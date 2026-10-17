/**
 * The single place the browser talks to the Moydan API.
 *
 * Everything the UI knows about failure is decided here. The API answers with
 * `{ error: { code, message, details } }` (see `docs/API.md`) and `ApiError`
 * keeps the machine readable `code` intact so screens can react - redirect on
 * `unauthenticated`, explain a quota on `quota_exceeded`, offer a new handle on
 * `conflict` - instead of pattern matching English prose.
 *
 * Writes carry the double-submit CSRF token: the API sets a readable
 * `moydan_csrf` cookie and requires its value in `x-csrf-token` for every
 * cookie-authenticated mutation.
 */

import type { ApiErrorBody } from '@moydan/core';

/** Empty string keeps every request on the app origin, which is what we want. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';

const CSRF_COOKIE = 'moydan_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type QueryValue = Record<string, string | number | boolean | null | undefined>;

export interface ApiRequestOptions {
  method?: HttpMethod;
  query?: QueryValue;
  /** Serialised as JSON. Use `apiPutBytes` for raw uploads. */
  body?: unknown;
  /** Pre-encoded body (bytes, FormData, Blob). Never JSON encoded. */
  raw?: BodyInit;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

export interface ApiErrorInit {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

/** A failed API call with everything a screen needs to react properly. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? {};
  }

  /** The viewer must sign in (or their session expired). */
  get needsAuth(): boolean {
    return this.code === 'unauthenticated';
  }

  get isNotFound(): boolean {
    return this.code === 'not_found';
  }

  /** Quota, payload size and rate limit problems deserve their own wording. */
  get isRecoverable(): boolean {
    return this.code === 'rate_limited' || this.code === 'quota_exceeded' || this.code === 'conflict';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Best-effort human sentence for any thrown value, used by error states. */
export function describeError(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Field-level messages the API attached to a validation failure. */
export function fieldIssues(error: unknown): { path: string; message: string }[] {
  if (!isApiError(error)) return [];
  const issues = error.details.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const entry = issue as { path?: unknown; message?: unknown };
    if (typeof entry.message !== 'string') return [];
    return [{ path: typeof entry.path === 'string' ? entry.path : '', message: entry.message }];
  });
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return part.slice(separator + 1).trim();
    }
  }
  return '';
}

/** Current CSRF token; refreshed on every write because login rotates it. */
export function csrfToken(): string {
  return readCookie(CSRF_COOKIE);
}

export function apiUrl(path: string, query?: QueryValue): string {
  const base = `${API_BASE}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

function fallbackCode(status: number): string {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 422:
      return 'validation_failed';
    case 429:
      return 'rate_limited';
    case 503:
      return 'unavailable';
    default:
      return status >= 500 ? 'internal_error' : 'invalid_request';
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return typeof (error as { code?: unknown }).code === 'string';
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    const parsed: unknown = await response.json();
    if (isApiErrorBody(parsed)) body = parsed;
  } catch {
    // A proxy or a crashed process can answer with HTML; the status is enough.
  }
  const code = body?.error.code ?? fallbackCode(response.status);
  return new ApiError({
    code,
    message: body?.error.message ?? `The server could not complete this request (HTTP ${response.status}).`,
    status: response.status,
    details: body?.error.details ?? {},
  });
}

async function send(path: string, options: ApiRequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.8');
  if (!SAFE_METHODS.has(method)) {
    const token = csrfToken();
    if (token) headers.set('x-csrf-token', token);
  }
  let payload: BodyInit | undefined;
  if (options.raw !== undefined) {
    payload = options.raw;
  } else if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(options.body);
  }
  const response = await fetch(apiUrl(path, options.query), {
    method,
    headers,
    body: payload,
    credentials: 'include',
    signal: options.signal,
  });
  if (!response.ok) throw await toApiError(response);
  return response;
}

/** JSON request. Resolves with `undefined` for `204 No Content`. */
export async function apiJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Raw response, for downloads the browser should handle itself (zip export). */
export async function apiResponse(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  return send(path, options);
}

export async function apiText(path: string, options: ApiRequestOptions = {}): Promise<string> {
  return (await send(path, options)).text();
}

export async function apiBytes(path: string, options: ApiRequestOptions = {}): Promise<Uint8Array> {
  return new Uint8Array(await (await send(path, options)).arrayBuffer());
}

export async function apiSend<T>(
  method: Exclude<HttpMethod, 'GET'>,
  path: string,
  body?: unknown,
  options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
): Promise<T> {
  return apiJson<T>(path, { ...options, method, body });
}

/** Copy bytes into a standalone ArrayBuffer: `fetch` wants a BufferSource. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Raw byte upload (project files and zip imports are never JSON). */
export async function apiPutBytes<T>(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  options: Omit<ApiRequestOptions, 'method' | 'body' | 'raw'> = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', contentType);
  return apiJson<T>(path, { ...options, method: 'PUT', headers, raw: toArrayBuffer(bytes) });
}

/** Raw byte upload with a method other than PUT (the zip importer). */
export async function apiSendBytes<T>(
  method: Exclude<HttpMethod, 'GET'>,
  path: string,
  bytes: Uint8Array,
  contentType: string,
  options: Omit<ApiRequestOptions, 'method' | 'body' | 'raw'> = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('content-type', contentType);
  return apiJson<T>(path, { ...options, method, headers, raw: toArrayBuffer(bytes) });
}

/** Encode a project file path into the wildcard segment the API expects. */
export function fileSegment(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
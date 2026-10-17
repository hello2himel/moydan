/**
 * HTTP client for the API's internal build protocol.
 *
 * The worker never talks to the database directly when it runs as a service: it
 * claims a job, uploads artifact files and reports success or failure over the
 * endpoints documented in `docs/API.md`, authenticated with the
 * `WORKER_JOB_SECRET` bearer token. Everything in this file is transport; the
 * decisions live in `pipeline.ts` so a CLI or a test can reuse them.
 *
 * Two failure classes matter and are kept apart:
 *   - `ApiRequestError` with a 4xx status: the request will never succeed
 *     (bad job state, lost lease), so the job must be given up on;
 *   - `ApiUnavailableError` (network, timeout, 5xx): the platform is unhealthy
 *     and the caller should back off rather than burn an attempt.
 */

import type { GameManifest, ProjectFileRole } from '@moydan/core';
import { safeJsonParse } from '@moydan/core';

export interface ClaimedFile {
  path: string;
  blobSha: string;
  size: number;
  contentType: string;
  role: ProjectFileRole;
}

export interface ClaimedJob {
  jobId: string;
  versionId: string;
  releaseId: string;
  toolchain: string;
  attempts: number;
  /** Lease duration the API granted, when it reports one. */
  leaseSeconds: number | null;
  manifest: GameManifest;
  files: ClaimedFile[];
  /**
   * The API publishes only a *summary* of the limits it enforces
   * (`artifactBytes`, `artifactFiles`, `firstPlayableBytes`), so this is never
   * used to enforce budgets - the worker enforces its own configured `Limits`
   * and warns when the two disagree.
   */
  limits: Record<string, unknown> | null;
}

export interface ArtifactUploadResult {
  sha256: string;
  size: number;
  storedBytes: number;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string, retryable = false) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class ApiUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiUnavailableError';
  }
}

export interface BuildApiClientOptions {
  baseUrl: string;
  secret: string;
  /** Per-request timeout; builds upload many files so this is per call. */
  timeoutMs?: number;
}

export class BuildApiClient {
  readonly baseUrl: string;
  private secret: string;
  private timeoutMs: number;

  constructor(options: BuildApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Claim the next queued (or lease-expired) job. Returns null when idle. */
  async claim(workerId: string): Promise<ClaimedJob | null> {
    const response = await this.send('POST', '/api/internal/builds/claim', { workerId });
    if (response.status === 204) return null;
    const body = await this.readJson(response);
    return normalizeClaim(body);
  }

  async heartbeat(jobId: string, workerId: string): Promise<{ ok: boolean; leaseSeconds: number }> {
    const response = await this.send('POST', `/api/internal/builds/${encodeURIComponent(jobId)}/heartbeat`, { workerId });
    const body = await this.readJson(response);
    return { ok: body?.['ok'] === true, leaseSeconds: Number(body?.['leaseSeconds'] ?? 0) };
  }

  async appendArtifact(
    jobId: string,
    workerId: string,
    input: { path: string; content: Uint8Array; contentType: string; entry: boolean },
  ): Promise<ArtifactUploadResult> {
    const response = await this.send('POST', `/api/internal/builds/${encodeURIComponent(jobId)}/artifacts`, {
      workerId,
      path: input.path,
      contentType: input.contentType,
      entry: input.entry,
      contentBase64: Buffer.from(input.content).toString('base64'),
    });
    const body = await this.readJson(response);
    return {
      sha256: String(body?.['sha256'] ?? ''),
      size: Number(body?.['size'] ?? input.content.byteLength),
      storedBytes: Number(body?.['storedBytes'] ?? input.content.byteLength),
    };
  }

  async finish(
    jobId: string,
    workerId: string,
    input: { manifest: unknown; log: string },
  ): Promise<{ releaseId: string }> {
    const response = await this.send('POST', `/api/internal/builds/${encodeURIComponent(jobId)}/finish`, {
      workerId,
      manifest: input.manifest,
      log: input.log,
    });
    const body = await this.readJson(response);
    return { releaseId: String(body?.['releaseId'] ?? '') };
  }

  async fail(
    jobId: string,
    workerId: string,
    input: { code: string; message: string; diagnostics: Array<{ code: string; message: string; path?: string }>; log: string },
  ): Promise<void> {
    const response = await this.send('POST', `/api/internal/builds/${encodeURIComponent(jobId)}/fail`, {
      workerId,
      ...input,
    });
    await this.readJson(response);
  }

  /** One-shot liveness probe used by the loop and by `--once`. */
  async ping(): Promise<void> {
    const response = await this.send('GET', '/health');
    await this.readJson(response);
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secret}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ApiUnavailableError(`${this.baseUrl}${path} is unreachable (${reason}).`, { cause: error });
    }
    return response;
  }

  private async readJson(response: Response): Promise<Record<string, unknown> | null> {
    const text = await response.text();
    const parsed = safeJsonParse<Record<string, unknown>>(text);
    if (response.ok) return parsed ?? {};
    const errorBody = asRecord(parsed?.['error']);
    const reported = typeof errorBody?.['message'] === 'string' ? errorBody['message'] : '';
    const message = reported || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new ApiRequestError(response.status, message, response.status >= 500 || response.status === 429);
  }
}

/**
 * Normalise a claim response.
 *
 * The payload is accepted in both camelCase and database-row casing: the claim
 * endpoint carries `release_files`/`version_files` rows, and a worker that
 * understands both shapes keeps working across an API refactor. A payload that
 * cannot be understood throws, because silently building "something" is worse
 * than failing the job.
 */
export function normalizeClaim(body: Record<string, unknown> | null): ClaimedJob {
  if (!body) throw new ApiRequestError(500, 'The claim response was not valid JSON.', true);
  const job = asRecord(body['job']);
  const version = asRecord(body['version']);
  if (!job || typeof job['id'] !== 'string') throw new ApiRequestError(500, 'The claim response contained no job.', true);

  const rawManifest = body['manifest'] ?? (typeof version?.['manifest_json'] === 'string' ? safeJsonParse(version['manifest_json']) : null);
  const manifest = asRecord(rawManifest);
  if (!manifest || typeof manifest['entry'] !== 'string') {
    throw new ApiRequestError(500, 'The claim response contained no usable game manifest.', true);
  }

  const rawFiles = Array.isArray(body['files']) ? body['files'] : [];
  const files: ClaimedFile[] = [];
  for (const entry of rawFiles) {
    const file = asRecord(entry);
    if (!file) continue;
    const path = str(file['path']);
    const blobSha = str(file['blobSha']) || str(file['blob_sha']);
    if (!path || !/^[a-f0-9]{64}$/.test(blobSha)) continue;
    files.push({
      path,
      blobSha,
      size: num(file['size'] ?? file['size_bytes']),
      contentType: str(file['contentType']) || str(file['content_type']) || 'application/octet-stream',
      role: (str(file['role']) || 'source') as ProjectFileRole,
    });
  }
  if (files.length === 0) throw new ApiRequestError(500, 'The claim response contained no source files.', true);

  return {
    jobId: str(job['id']),
    versionId: str(job['versionId']) || str(job['version_id']) || str(version?.['id']),
    releaseId: str(body['releaseId']) || str(body['release_id']) || str(job['release_id']),
    toolchain: str(job['toolchain']),
    attempts: num(job['attempts']),
    leaseSeconds: num(body['leaseSeconds']) || null,
    manifest: manifest as unknown as GameManifest,
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    limits: asRecord(body['limits']),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Opaque keyset-pagination cursors.
 *
 * Cursors only ever contain non-sensitive ordering keys (timestamps, counters,
 * identifiers) plus a version tag. They are intentionally *not* signed: they
 * carry no authority, and the API re-validates every value before use, so a
 * forged cursor can at worst skip within a result set the caller may already
 * read. They are validated against the expected key shape on decode.
 */

export const CURSOR_VERSION = 1;

export interface CursorPayload {
  v: typeof CURSOR_VERSION;
  /** Kind of collection the cursor belongs to, e.g. `feed:foryou`. */
  s: string;
  /** Ordering keys, ordered from most significant to least significant. */
  k: (string | number | null)[];
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeCursor(scope: string, keys: (string | number | null)[]): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, s: scope, k: keys };
  return toBase64Url(JSON.stringify(payload));
}

export function decodeCursor(raw: string | null | undefined, scope: string): CursorPayload | null {
  if (!raw) return null;
  if (raw.length > 512) return null;
  const text = fromBase64Url(raw);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const payload = parsed as Partial<CursorPayload>;
  if (payload.v !== CURSOR_VERSION) return null;
  if (payload.s !== scope) return null;
  if (!Array.isArray(payload.k) || payload.k.length === 0 || payload.k.length > 4) return null;
  for (const key of payload.k) {
    const type = typeof key;
    if (key !== null && type !== 'string' && type !== 'number') return null;
    if (type === 'string' && (key as string).length > 128) return null;
    if (type === 'number' && !Number.isFinite(key as number)) return null;
  }
  return payload as CursorPayload;
}

export function readCursorKeyString(payload: CursorPayload | null, index = 0): string | null {
  if (!payload) return null;
  const value = payload.k[index];
  return typeof value === 'string' ? value : null;
}

export function readCursorKeyNumber(payload: CursorPayload | null, index = 0): number | null {
  if (!payload) return null;
  const value = payload.k[index];
  return typeof value === 'number' ? value : null;
}

export const CURSOR_SCOPES = {
  forYouFeed: 'feed:foryou',
  followingFeed: 'feed:following',
  savedGames: 'saved:list',
  comments: 'comments:list',
  gameComments: 'comments:game',
  creatorGames: 'games:creator',
  creatorRemixes: 'games:remixes',
  buildJobs: 'jobs:list',
  reports: 'admin:reports',
  scores: 'scores:game',
} as const;

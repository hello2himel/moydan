/**
 * Game entry resolution.
 *
 * Releases live on the *game origin*, not on the app origin. The sandboxed host
 * authenticates every postMessage event against that origin, so the player
 * always needs an absolute URL plus the exact origin it belongs to - never a
 * guess made from `window.location`.
 */

const FALLBACK_GAME_ORIGIN = 'http://localhost:5174';

export interface ResolvedEntry {
  src: string;
  origin: string;
}

/**
 * Turn an `entryUrl` (or preview grant URL) into an absolute URL and its
 * origin. Relative URLs are resolved against the configured game origin, which
 * only happens in development and in self-hosted single-origin setups.
 */
export function resolveEntry(entryUrl: string | null | undefined): ResolvedEntry | null {
  if (!entryUrl) return null;
  const base = import.meta.env.VITE_GAME_ORIGIN ?? FALLBACK_GAME_ORIGIN;
  try {
    const url = new URL(entryUrl, base);
    return { src: url.toString(), origin: url.origin };
  } catch {
    return null;
  }
}

/**
 * Only sandboxed, same-origin-relative URLs are handed to the Web Share API
 * when a game asks the host to share something.
 */
export function isShareable(value: unknown): value is { title?: string; text?: string; url?: string } {
  return typeof value === 'object' && value !== null;
}
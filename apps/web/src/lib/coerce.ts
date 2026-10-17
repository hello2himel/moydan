/**
 * Small guards for responses that are *not* covered by `@moydan/core` DTOs.
 *
 * The shared contracts are trusted; endpoints that return loosely typed shapes
 * (`/api/meta/*`, `/games/:id/remix-options`, anything a deployment may extend)
 * are not. These helpers turn a missing array into an empty one so a partially
 * shaped response degrades into "nothing to show" instead of a render crash.
 */

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
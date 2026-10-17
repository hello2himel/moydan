/**
 * Digest helpers.
 *
 * `@moydan/core` is browser-safe by contract and therefore cannot expose a
 * synchronous SHA-256 (SubtleCrypto is async), so the two places that need one -
 * the blob store and the build worker - share this tiny node-side helper
 * instead of each re-implementing it.
 */

import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256HexOfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

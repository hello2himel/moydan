/**
 * Deterministic text compression used at build time.
 *
 * Compressed representations are stored as separate content-addressed blobs, so
 * identical payloads compress once and are deduplicated like any other blob. The
 * server picks a representation based on `Accept-Encoding`; the raw blob is kept
 * because it is the integrity reference and is needed for clients that cannot
 * decompress.
 */

import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';

export type ContentEncoding = 'gz' | 'br';

export interface CompressedVariant {
  encoding: ContentEncoding;
  bytes: Uint8Array;
  ratio: number;
}

/** Only worth storing when it saves at least 10% of the payload. */
const MIN_SAVING = 0.9;

export function compressVariants(input: Uint8Array, options: { maxSourceBytes?: number } = {}): CompressedVariant[] {
  const maxSourceBytes = options.maxSourceBytes ?? 2 * 1024 * 1024;
  if (input.byteLength === 0 || input.byteLength > maxSourceBytes) return [];
  const out: CompressedVariant[] = [];
  try {
    const brotli = new Uint8Array(
      brotliCompressSync(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
        },
      }),
    );
    if (brotli.byteLength <= input.byteLength * MIN_SAVING) {
      out.push({ encoding: 'br', bytes: brotli, ratio: brotli.byteLength / input.byteLength });
    }
  } catch {
    // Fall through to gzip.
  }
  try {
    const gzip = new Uint8Array(gzipSync(input, { level: 9 }));
    if (gzip.byteLength <= input.byteLength * MIN_SAVING) {
      out.push({ encoding: 'gz', bytes: gzip, ratio: gzip.byteLength / input.byteLength });
    }
  } catch {
    // Compression is an optimisation: failures must not fail a build.
  }
  return out;
}

export function decompress(encoding: ContentEncoding, data: Uint8Array): Uint8Array {
  if (encoding === 'br') return new Uint8Array(brotliDecompressSync(data));
  return new Uint8Array(gunzipSync(data));
}

/** Small helper for tests and diagnostics. */
export function compressionRatio(original: number, compressed: number): number {
  if (original <= 0) return 1;
  return Number((compressed / original).toFixed(4));
}

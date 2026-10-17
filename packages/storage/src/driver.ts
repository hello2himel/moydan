/**
 * Object storage abstraction.
 *
 * Two drivers ship with the platform:
 *   - `fs`  : local directory adapter for development and tests. Documented as
 *             non-durable; `assertConfigSafety` refuses it in production.
 *   - `s3`  : S3-compatible object storage (Cloudflare R2, AWS S3, MinIO,
 *             Garage, SeaweedFS...) implemented with a minimal SigV4 signer.
 *
 * Keys are always platform-generated, lowercase, and path-safe.
 */

export interface PutOptions {
  contentType: string;
  /** `public, max-age=31536000, immutable` for releases; private for drafts. */
  cacheControl?: string;
}

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
  size: number;
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
  etag: string | null;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface StorageDriver {
  readonly kind: 'fs' | 's3';
  put(key: string, body: Uint8Array, options: PutOptions): Promise<{ etag: string | null }>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  /** Delete many keys, tolerating missing objects (used by GC). */
  deleteMany(keys: readonly string[]): Promise<{ deleted: number; failed: string[] }>;
  list(prefix: string, options?: { limit?: number }): Promise<ListedObject[]>;
}

export function assertSafeKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]{0,220}$/.test(key)) {
    throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
  }
  if (key.includes('//') || key.includes('..') || key.endsWith('/')) {
    throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
  }
}

/** Key layout used by the platform. Kept in one place so GC and tests agree. */
export const storageKeys = {
  blob: (sha256: string) => `blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`,
  /** Pre-compressed representations live next to the blob, never published twice. */
  blobEncoding: (sha256: string, encoding: 'gz' | 'br') => `${storageKeys.blob(sha256)}.${encoding}`,
  releaseManifest: (releaseId: string) => `releases/${releaseId}/manifest.json`,
  buildLog: (jobId: string) => `builds/${jobId}/log.txt`,
  previewThumbnail: (gameId: string, rev: string) => `previews/${gameId}/${rev}.png`,
};

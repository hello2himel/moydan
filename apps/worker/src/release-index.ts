/**
 * The release index.
 *
 * The game content origin serves artifacts from object storage and deliberately
 * has *no* database credentials, so it needs one immutable object per release
 * that maps release paths to content-addressed blobs. That object is written
 * after a successful build; it is a derived cache of `release_files` (which
 * stays the authoritative record the API verifies against), which is why a
 * deployment that never writes it simply gets 404s instead of wrong bytes.
 *
 * Shape: the artifact manifest plus the release id. Deterministic JSON, so
 * re-writing the index for the same artifact produces the same bytes.
 */

import { ARTIFACT_MANIFEST_VERSION, safeJsonParse, stableStringify } from '@moydan/core';
import { storageKeys } from '@moydan/storage';
import type { BlobStore } from '../../api/src/storage/blobs.ts';
import type { ArtifactManifest, ArtifactManifestFile } from './bundler.ts';

export interface ReleaseIndexFile extends ArtifactManifestFile {
  /** Storage key of the (uncompressed) blob. */
  key: string;
}

export interface ReleaseIndex {
  version: number;
  releaseId: string;
  entry: string;
  files: ReleaseIndexFile[];
  totalBytes: number;
  firstPlayableBytes: number;
}

export function releaseIndexKey(releaseId: string): string {
  return storageKeys.releaseManifest(releaseId);
}

/** Build the index for one finished artifact. */
export function encodeReleaseIndex(releaseId: string, manifest: ArtifactManifest, blobKeyFor: (sha256: string) => string): Uint8Array {
  const index: ReleaseIndex = {
    version: manifest.version || ARTIFACT_MANIFEST_VERSION,
    releaseId,
    entry: manifest.entry,
    totalBytes: manifest.totalBytes,
    firstPlayableBytes: manifest.firstPlayableBytes,
    files: manifest.files.map((file) => ({ ...file, key: blobKeyFor(file.sha256) })),
  };
  return new TextEncoder().encode(stableStringify(index));
}

/**
 * Defensive parser: anything unexpected yields `null` so a caller can fall back
 * to a direct key lookup instead of serving the wrong bytes.
 */
export function parseReleaseIndex(bytes: Uint8Array): ReleaseIndex | null {
  const parsed = safeJsonParse<Partial<ReleaseIndex>>(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed.entry !== 'string' || !Array.isArray(parsed.files)) return null;
  const files: ReleaseIndexFile[] = [];
  for (const file of parsed.files) {
    if (typeof file !== 'object' || file === null) continue;
    const entry = file as Partial<ReleaseIndexFile>;
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') continue;
    if (typeof entry.size !== 'number' || typeof entry.contentType !== 'string') continue;
    const key = typeof entry.key === 'string' && entry.key.length > 0 ? entry.key : blobKeyOf(entry.sha256);
    files.push({ ...(entry as ArtifactManifestFile), key });
  }
  if (files.length === 0) return null;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : ARTIFACT_MANIFEST_VERSION,
    releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : '',
    entry: parsed.entry,
    files,
    totalBytes: typeof parsed.totalBytes === 'number' ? parsed.totalBytes : files.reduce((sum, file) => sum + file.size, 0),
    firstPlayableBytes: typeof parsed.firstPlayableBytes === 'number' ? parsed.firstPlayableBytes : 0,
  };
}

/** Content-addressed layout used by `BlobStore`; duplicated so the origin needs no database code. */
export function blobKeyOf(sha256: string): string {
  return storageKeys.blob(sha256);
}

/**
 * Publish the index. Failures are reported but never fail the build: the release
 * is already verified and published, and the origin can always be pointed at a
 * deployment that writes the index itself.
 */
export async function writeReleaseIndex(blobs: BlobStore, releaseId: string, manifest: ArtifactManifest): Promise<string> {
  const key = releaseIndexKey(releaseId);
  const bytes = encodeReleaseIndex(releaseId, manifest, blobKeyOf);
  await blobs.storage.put(key, bytes, {
    contentType: 'application/json',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return key;
}

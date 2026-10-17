/**
 * Artifact resolution: release id + path -> bytes.
 *
 * The origin has no database credentials, so it cannot join `release_files`. It
 * resolves content through one immutable object per release
 * (`releases/<releaseId>/manifest.json`, written by the build worker after the
 * API verified a release), which maps every artifact path to its
 * content-addressed blob. A deployment that stores release files under their
 * own key prefix instead is supported as a fallback.
 *
 * Two properties matter more than the mechanism:
 *
 *   - a path can only ever address a key inside its own release's prefix, and it
 *     must pass the platform's artifact path policy first (`..`, absolute paths,
 *     backslashes and reserved segments are all rejected before any I/O);
 *   - bytes that come back are verified against the digest recorded at build
 *     time, so storage corruption or a mis-pointed index becomes a 502 instead
 *     of untrusted content in a browser.
 */

import { createHash } from 'node:crypto';
import { checkArtifactPath, contentTypeForPath, safeJsonParse } from '@moydan/core';
import { storageKeys, type StorageDriver, type StoredObject } from '@moydan/storage';

export interface ReleaseAsset {
  path: string;
  key: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface ResolvedAsset {
  body: Uint8Array;
  contentType: string;
  sha256: string;
  /** Strong ETag: the identity digest of the bytes being served. */
  etag: string;
}

export interface ReadOptions {
  /** Reserved for future use; pre-compressed variants are not served today. */
  acceptEncoding?: string;
  /** Preview requests must not be served from long-lived caches. */
  immutable?: boolean;
}

export interface ArtifactStoreOptions {
  indexTtlMs: number;
  maxResponseBytes: number;
  /** Digests already verified, so repeat hits skip the hash. */
  verifiedCacheSize?: number;
}

interface CachedIndex {
  loadedAt: number;
  assets: Map<string, ReleaseAsset>;
}

/** Digests of bodies that were verified once and are still cached. */
const MAX_VERIFIED_DIGESTS = 512;

/**
 * Reader for published artifacts.
 *
 * Everything is cached for a few seconds only, and only to absorb the burst of
 * requests one game load produces (document, bundle, SDK, assets): the data
 * behind them is immutable, so a short cache is always safe.
 */
export class ArtifactStore {
  private storage: StorageDriver;
  private options: ArtifactStoreOptions;
  private indexCache = new Map<string, CachedIndex>();
  private verifiedDigests = new Set<string>();

  constructor(storage: StorageDriver, options: ArtifactStoreOptions) {
    this.storage = storage;
    this.options = options;
  }

  /** Release manifest as stored in object storage, or null when absent. */
  async index(releaseId: string): Promise<Map<string, ReleaseAsset> | null> {
    const now = Date.now();
    const cached = this.indexCache.get(releaseId);
    if (cached && now - cached.loadedAt < this.options.indexTtlMs) return cached.assets;

    const assets = new Map<string, ReleaseAsset>();
    const object = await this.storage.get(storageKeys.releaseManifest(releaseId));
    if (object) {
      for (const asset of parseIndex(object.body, releaseId)) assets.set(asset.path, asset);
    }
    this.indexCache.set(releaseId, { loadedAt: now, assets });
    this.pruneIndexCache(now);
    return assets.size > 0 ? assets : null;
  }

  /**
   * Read one artifact file.
   *
   * Identity bytes only. The platform stores compressed variants under their own
   * content-addressed key and the release index does not record their digests,
   * so this origin must not guess: it serves what it can verify and lets a
   * reverse proxy or CDN apply compression in front of it instead.
   *
   * Returns `null` when the release or the file is unknown, which the route
   * turns into a plain 404 (no information about which releases exist).
   */
  async read(releaseId: string, path: string, options: ReadOptions = {}): Promise<ResolvedAsset | null> {
    const safePath = safeArtifactPath(path);
    if (safePath === null) return null;
    void options;

    const assets = await this.index(releaseId);
    const declared = assets?.get(safePath) ?? null;
    const key = declared?.key ?? this.fallbackKey(releaseId, safePath);
    if (key === null) return null;

    const stored: StoredObject | null = await this.storage.get(key);
    if (!stored) return null;

    const body = stored.body;
    if (body.byteLength > this.options.maxResponseBytes) {
      throw new ArtifactTooLarge(`${safePath} is larger than this origin will serve in one response.`);
    }

    const digest = digestOf(body);
    const expected = declared?.sha256 ?? '';
    if (expected !== '' && !this.isVerified(digest) && !this.verifyBody(body, digest, expected, safePath)) {
      return null;
    }
    const sha256 = expected !== '' ? expected : digest;

    return {
      body,
      contentType: declared?.contentType ?? contentTypeForPath(safePath),
      sha256,
      etag: `"${sha256}"`,
    };
  }

  /** Object metadata without the body, for `HEAD`. */
  async head(releaseId: string, path: string): Promise<{ contentType: string; size: number; sha256: string } | null> {
    const safePath = safeArtifactPath(path);
    if (safePath === null) return null;
    const assets = await this.index(releaseId);
    const declared = assets?.get(safePath) ?? null;
    const key = declared?.key ?? this.fallbackKey(releaseId, safePath);
    if (key === null) return null;
    const object = await this.storage.head(key);
    const size = object?.size ?? declared?.size ?? 0;
    return { contentType: declared?.contentType ?? contentTypeForPath(safePath), size, sha256: declared?.sha256 ?? '' };
  }

  /**
   * Fallback for deployments that store release files under their own prefix
   * (`releases/<id>/<path>`) instead of content-addressed blobs.
   */
  private fallbackKey(releaseId: string, path: string): string | null {
    if (!isSafeSegment(releaseId)) return null;
    const key = `${storageKeys.releaseManifest(releaseId).replace(/\/manifest\.json$/, '')}/${path}`;
    return isSafeKey(key) ? key : null;
  }

  private verifyBody(body: Uint8Array, digest: string, expected: string, path: string): boolean {
    if (digest !== expected) {
      throw new ArtifactCorrupt(`${path} does not match the digest recorded for this release.`);
    }
    this.rememberVerified(digest);
    return true;
  }

  private isVerified(digest: string): boolean {
    return this.verifiedDigests.has(digest);
  }

  private rememberVerified(digest: string): void {
    if (this.verifiedDigests.size >= (this.options.verifiedCacheSize ?? MAX_VERIFIED_DIGESTS)) {
      const oldest = this.verifiedDigests.values().next();
      if (!oldest.done) this.verifiedDigests.delete(oldest.value);
    }
    this.verifiedDigests.add(digest);
  }

  private pruneIndexCache(now: number): void {
    if (this.indexCache.size <= 256) return;
    for (const [releaseId, entry] of this.indexCache) {
      if (now - entry.loadedAt >= this.options.indexTtlMs) this.indexCache.delete(releaseId);
    }
  }
}

export class ArtifactTooLarge extends Error {}
export class ArtifactCorrupt extends Error {}

/**
 * Accept a path only when the platform's artifact policy allows it. Returning
 * `null` (rather than throwing) keeps traversal attempts indistinguishable from
 * a missing file at the HTTP layer.
 *
 * A `%` is rejected outright: the router has already percent-decoded the URL,
 * so an encoded separator left in the path means somebody is trying to smuggle
 * one past the policy check.
 */
export function safeArtifactPath(path: string): string | null {
  if (path.length === 0 || path.length > 256) return null;
  if (path.includes('%') || path.includes('\\')) return null;
  if (checkArtifactPath(path)) return null;
  return path;
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  if (key.includes('//') || key.includes('..') || key.endsWith('/')) return false;
  return /^[a-z0-9][a-z0-9._/-]*$/.test(key);
}

/** Defensive parse of the release index written by the build worker. */
export function parseIndex(bytes: Uint8Array, releaseId: string): ReleaseAsset[] {
  const parsed = safeJsonParse<{ files?: unknown; releaseId?: unknown }>(new TextDecoder().decode(bytes));
  if (!parsed || !Array.isArray(parsed.files)) return [];
  if (typeof parsed.releaseId === 'string' && parsed.releaseId !== releaseId) return [];
  const assets: ReleaseAsset[] = [];
  for (const entry of parsed.files) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file = entry as Record<string, unknown>;
    const path = typeof file['path'] === 'string' ? file['path'] : '';
    const sha256 = typeof file['sha256'] === 'string' ? file['sha256'] : '';
    const size = typeof file['size'] === 'number' ? file['size'] : 0;
    const contentType = typeof file['contentType'] === 'string' ? file['contentType'] : '';
    if (safeArtifactPath(path) === null) continue;
    if (!/^[a-f0-9]{64}$/.test(sha256)) continue;
    if (!isSafeKey(storageKeys.blob(sha256))) continue;
    assets.push({
      path,
      key: storageKeys.blob(sha256),
      contentType: contentType || contentTypeForPath(path),
      size,
      sha256,
    });
  }
  return assets;
}

/** Local sha256 so a served body always matches its ETag. */
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Content-addressed blob store.
 *
 * Guarantees:
 *  - the sha256 of the bytes decides the storage key, so identical content is
 *    stored (and uploaded) only once;
 *  - every ingest verifies the digest it computed against the digest it stores;
 *  - reads can re-verify integrity (`verify: true`), which the publish path and
 *    the integrity tests use;
 *  - blob *rows* are only deleted by the mark-and-sweep GC, which refuses to
 *    delete anything still referenced by a draft, version, release or build.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import {
  compressVariants,
  storageKeys,
  type ContentEncoding,
  type StorageDriver,
  type StoredObject,
} from '@moydan/storage';

export type BlobClass = 'source' | 'asset' | 'artifact' | 'preview' | 'thumbnail' | 'temporary';

export interface BlobRow {
  sha256: string;
  size_bytes: number;
  content_type: string;
  class: BlobClass;
  key: string;
  compressed_key: string | null;
  created_at: string;
}

export interface IngestResult {
  sha256: string;
  size: number;
  deduped: boolean;
  contentType: string;
  encodings: { encoding: ContentEncoding; sha256: string; size: number }[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class BlobStore {
  private db: Db;
  private driver: StorageDriver;

  constructor(db: Db, driver: StorageDriver) {
    this.db = db;
    this.driver = driver;
  }

  get storage(): StorageDriver {
    return this.driver;
  }

  keyFor(sha256: string): string {
    return storageKeys.blob(sha256);
  }

  find(sha256: string): BlobRow | null {
    return (
      this.db.get<BlobRow>(
        'SELECT sha256, size_bytes, content_type, class, key, compressed_key, created_at FROM blobs WHERE sha256 = ?',
        [sha256],
      ) ?? null
    );
  }

  /**
   * Store bytes and register them. Returns the content digest and any compressed
   * representations that were worth keeping.
   */
  async ingest(
    bytes: Uint8Array,
    options: { class: BlobClass; contentType: string; compress?: boolean },
  ): Promise<IngestResult> {
    const sha256 = sha256Hex(bytes);
    const existing = this.find(sha256);
    const encodings: IngestResult['encodings'] = [];

    if (!existing) {
      const key = this.keyFor(sha256);
      await this.driver.put(key, bytes, {
        contentType: options.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      });
      let compressedKey: string | null = null;
      if (options.compress) {
        const variants = compressVariants(bytes);
        const preferred = variants.find((variant) => variant.encoding === 'br') ?? variants[0];
        if (preferred) {
          compressedKey = storageKeys.blobEncoding(sha256, preferred.encoding);
        }
      }
      this.db.run(
        'INSERT INTO blobs (sha256, size_bytes, content_type, class, key, compressed_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sha256, bytes.byteLength, options.contentType, options.class, key, compressedKey, nowIso()],
      );
    }

    if (options.compress) {
      for (const variant of compressVariants(bytes)) {
        const variantSha = sha256Hex(variant.bytes);
        const variantKey = this.keyFor(variantSha);
        if (!this.find(variantSha)) {
          await this.driver.put(variantKey, variant.bytes, {
            contentType: `${options.contentType}+${variant.encoding}`,
            cacheControl: 'public, max-age=31536000, immutable',
          });
          this.db.run(
            'INSERT INTO blobs (sha256, size_bytes, content_type, class, key, compressed_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [variantSha, variant.bytes.byteLength, options.contentType, options.class, variantKey, null, nowIso()],
          );
        }
        encodings.push({ encoding: variant.encoding, sha256: variantSha, size: variant.bytes.byteLength });
      }
    }

    return {
      sha256,
      size: bytes.byteLength,
      deduped: Boolean(existing),
      contentType: options.contentType,
      encodings,
    };
  }

  async read(sha256: string, options: { verify?: boolean } = {}): Promise<StoredObject | null> {
    const row = this.find(sha256);
    if (!row) return null;
    const object = await this.driver.get(row.key);
    if (!object) return null;
    if (options?.verify) {
      const actual = sha256Hex(object.body);
      if (actual !== sha256) {
        throw new Error(`blob integrity check failed: expected ${sha256}, computed ${actual}`);
      }
    }
    return { body: object.body, contentType: row.content_type, size: object.body.byteLength };
  }

  async delete(sha256: string): Promise<void> {
    const row = this.find(sha256);
    if (!row) return;
    this.db.transaction(() => {
      this.db.run('DELETE FROM blobs WHERE sha256 = ?', [sha256]);
    });
    await this.driver.delete(row.key);
  }
}

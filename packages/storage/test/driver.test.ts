/**
 * Storage driver contract. The `fs` driver is the development/test adapter and
 * the S3 driver is what production runs against; both must behave identically,
 * because every other part of the platform is written against this interface.
 *
 * The S3 case is opt-in: point `TEST_S3_ENDPOINT` at a MinIO/Garage container and
 * the same contract runs against it. Without the variable the block is skipped
 * with an explicit reason rather than silently passing.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeKey,
  compressVariants,
  createStorageDriver,
  decompress,
  FsStorageDriver,
  S3StorageDriver,
  storageKeys,
  type S3DriverConfig,
  type StorageDriver,
} from '@moydan/storage';

const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let temporaryRoot: string;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'moydan-storage-'));
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

/**
 * The behaviour every driver must provide. Run it against `fs` always, and
 * against S3 when a server is configured.
 */
function storageContract(name: string, driver: () => StorageDriver, options: { skip?: boolean } = {}): void {
  const suite = options.skip ? describe.skip : describe;
  suite(name, () => {
    const KEY = 'blobs/sha256/aa/bb/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const BODY = encoder.encode('moydan storage contract');

    it('stores and returns the exact bytes', async () => {
      const store = driver();
      const { etag } = await store.put(KEY, BODY, { contentType: 'text/plain' });
      expect(etag).toBe(sha256(BODY));
      const stored = await store.get(KEY);
      expect(stored).not.toBeNull();
      expect(Array.from(stored?.body ?? [])).toEqual(Array.from(BODY));
      expect(stored?.size).toBe(BODY.byteLength);
      expect(stored?.contentType).toBe('text/plain');
    });

    it('reports metadata through head without a body', async () => {
      const store = driver();
      await store.put(KEY, BODY, { contentType: 'image/png', cacheControl: 'public, max-age=60' });
      const head = await store.head(KEY);
      expect(head?.size).toBe(BODY.byteLength);
      expect(head?.contentType).toBe('image/png');
    });

    it('returns null for a key that was never written', async () => {
      const store = driver();
      expect(await store.get('blobs/sha256/ff/ff/missing')).toBeNull();
      expect(await store.head('blobs/sha256/ff/ff/missing')).toBeNull();
    });

    it('overwrites a key atomically with the new bytes', async () => {
      const store = driver();
      const key = 'blobs/sha256/cc/dd/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      await store.put(key, encoder.encode('first'), { contentType: 'text/plain' });
      await store.put(key, encoder.encode('second version'), { contentType: 'text/plain' });
      const stored = await store.get(key);
      expect(new TextDecoder().decode(stored?.body)).toBe('second version');
    });

    it('lists the keys under a prefix, ignoring internal metadata files', async () => {
      const store = driver();
      await store.put('prefix/a.txt', encoder.encode('a'), { contentType: 'text/plain' });
      await store.put('prefix/b.txt', encoder.encode('bb'), { contentType: 'text/plain' });
      const listed = await store.list('prefix/');
      const keys = listed.map((entry) => entry.key).sort();
      expect(keys).toEqual(['prefix/a.txt', 'prefix/b.txt']);
      expect(listed.find((entry) => entry.key === 'prefix/b.txt')?.size).toBe(2);
    });

    it('deletes a key and tolerates deleting it twice', async () => {
      const store = driver();
      const key = 'prefix/doomed.txt';
      await store.put(key, encoder.encode('bye'), { contentType: 'text/plain' });
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
      await expect(store.delete(key)).resolves.toBeUndefined();
    });

    it('deletes many keys, tolerating objects that are already gone', async () => {
      const store = driver();
      await store.put('bulk/one', encoder.encode('1'), { contentType: 'text/plain' });
      await store.put('bulk/two', encoder.encode('2'), { contentType: 'text/plain' });
      const result = await store.deleteMany(['bulk/one', 'bulk/two', 'bulk/never-existed']);
      expect(result.failed).toEqual([]);
      expect(result.deleted).toBe(3);
      expect(await store.list('bulk/')).toEqual([]);
    });

    it('refuses to operate on an unsafe key', async () => {
      const store = driver();
      for (const key of ['../escape', 'Blobs/Upper', '/absolute', 'trailing/']) {
        await expect(store.get(key), `key ${key}`).rejects.toThrow(/unsafe storage key/);
      }
    });
  });
}

storageContract('fs storage driver', () => new FsStorageDriver(temporaryRoot));

describe('createStorageDriver', () => {
  it('builds an fs driver for the fs selection', () => {
    const driver = createStorageDriver({ driver: 'fs', fsRoot: temporaryRoot });
    expect(driver.kind).toBe('fs');
  });

  it('refuses an fs selection without a root and an s3 selection without credentials', () => {
    expect(() => createStorageDriver({ driver: 'fs' })).toThrow(/root directory/);
    expect(() => createStorageDriver({ driver: 's3' })).toThrow(/S3 configuration/);
  });
});

describe('assertSafeKey', () => {
  it('accepts the platform-generated key shapes', () => {
    const digest = sha256(encoder.encode('x'));
    expect(() => assertSafeKey(storageKeys.blob(digest))).not.toThrow();
    expect(() => assertSafeKey(storageKeys.blobEncoding(digest, 'br'))).not.toThrow();
    expect(() => assertSafeKey(storageKeys.releaseManifest('rel_abc'))).not.toThrow();
    expect(() => assertSafeKey(storageKeys.buildLog('job_abc'))).not.toThrow();
    expect(() => assertSafeKey(storageKeys.previewThumbnail('gam_abc', 'r1'))).not.toThrow();
  });

  it('derives a deterministic, namespace-separated key from the digest', () => {
    const digest = sha256(encoder.encode('x'));
    expect(storageKeys.blob(digest)).toBe(`blobs/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`);
    expect(storageKeys.blob(digest)).toBe(storageKeys.blob(digest));
    expect(storageKeys.blobEncoding(digest, 'gz')).toBe(`${storageKeys.blob(digest)}.gz`);
  });

  it('refuses traversal, uppercase, empty and over-long keys', () => {
    for (const key of ['../x', 'a/../b', 'a//b', '/x', 'x/', '', 'A', 'a'.repeat(222), 'a b']) {
      expect(() => assertSafeKey(key), `key ${JSON.stringify(key)}`).toThrow(/unsafe storage key/);
    }
  });
});

describe('compression variants', () => {
  it('round-trips a stored brotli variant', () => {
    const payload = encoder.encode('a'.repeat(4096));
    const variants = compressVariants(payload);
    const brotli = variants.find((variant) => variant.encoding === 'br');
    expect(brotli).toBeDefined();
    expect(new TextDecoder().decode(decompress('br', brotli?.bytes ?? new Uint8Array()))).toBe('a'.repeat(4096));
  });

  it('keeps nothing for content that does not compress', () => {
    // Genuinely random bytes: neither brotli nor gzip can save 10% on these.
    expect(compressVariants(new Uint8Array(randomBytes(2048)))).toEqual([]);
  });

  it('refuses to compress an empty or oversized payload', () => {
    expect(compressVariants(new Uint8Array(0))).toEqual([]);
    expect(compressVariants(encoder.encode('a'.repeat(100)), { maxSourceBytes: 10 })).toEqual([]);
  });
});

// --- Optional S3 parity run ---------------------------------------------------

function readS3Config(): S3DriverConfig | null {
  const endpoint = process.env['TEST_S3_ENDPOINT'];
  if (!endpoint) return null;
  return {
    endpoint,
    region: process.env['TEST_S3_REGION'] ?? 'us-east-1',
    bucket: process.env['TEST_S3_BUCKET'] ?? 'moydan-tests',
    accessKeyId: process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'test',
    forcePathStyle: (process.env['TEST_S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
  };
}

/** Probe the configured server once; a network failure is a skip, not a failure. */
async function probeS3(config: S3DriverConfig): Promise<{ ok: boolean; reason: string }> {
  if (!process.env['TEST_S3_ACCESS_KEY_ID'] || !process.env['TEST_S3_SECRET_ACCESS_KEY']) {
    return { ok: false, reason: 'TEST_S3_ACCESS_KEY_ID / TEST_S3_SECRET_ACCESS_KEY are not set' };
  }
  const driver = new S3StorageDriver(config);
  try {
    await driver.list('probe/');
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const s3Config = readS3Config();
const s3Probe = s3Config ? await probeS3(s3Config) : null;
if (s3Config && !s3Probe?.ok) {
  // Loud, explicit: an operator pointing at a server should never wonder why
  // the S3 assertions did not run.
  console.warn(`[storage] skipping the S3 contract run: ${s3Probe?.reason ?? 'unknown reason'}`);
}

storageContract(
  's3 storage driver (TEST_S3_ENDPOINT)',
  () => {
    if (!s3Config) throw new Error('the S3 contract run requires TEST_S3_ENDPOINT');
    return new S3StorageDriver(s3Config);
  },
  { skip: !s3Probe?.ok },
);

const maybeS3 = s3Probe?.ok ? describe : describe.skip;

maybeS3('s3 storage driver extras', () => {
  it('never leaves the run depending on an object left by a previous run', async () => {
    if (!s3Config) return;
    const driver = new S3StorageDriver(s3Config);
    const key = `contract/${sha256(encoder.encode('reuse'))}`;
    await driver.put(key, encoder.encode('one'), { contentType: 'text/plain' });
    await driver.put(key, encoder.encode('two'), { contentType: 'text/plain' });
    const stored = await driver.get(key);
    expect(new TextDecoder().decode(stored?.body)).toBe('two');
    await driver.delete(key);
  });
});
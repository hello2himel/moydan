/**
 * Blob storage: content-addressed deduplication, reference tracking, the GC's
 * mark-and-sweep rule and per-account quota accounting.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectGarbage, blobReferenceSummary } from '../src/storage/gc.ts';
import { computeUsage, readUsage } from '../src/storage/usage.ts';
import { createEnv, errorCode, raw, type TestEnv } from './harness.ts';

let env: TestEnv;
/** An account whose source quota is deliberately tiny. */
let capped: TestEnv;
/** An environment whose per-file ceiling is deliberately tiny. */
let smallFiles: TestEnv;

const encoder = new TextEncoder();

beforeAll(async () => {
  env = await createEnv();
  capped = await createEnv({ quotaUserSourceBytes: 65_536, maxGamesPerUser: 3 });
  smallFiles = await createEnv({ maxFileBytes: 4096 });
});

afterAll(async () => {
  await smallFiles.close();
  await capped.close();
  await env.close();
});

describe('content-addressed dedup', () => {
  it('stores identical bytes once and reports the second write as deduped', async () => {
    const bytes = encoder.encode('the very same source file, byte for byte\n');
    const first = await env.blobs.ingest(bytes, { class: 'source', contentType: 'text/plain' });
    const second = await env.blobs.ingest(bytes, { class: 'source', contentType: 'text/plain' });

    expect(first.sha256).toBe(second.sha256);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    const rows = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM blobs WHERE sha256 = ?', [first.sha256]);
    expect(Number(rows?.count ?? 0)).toBe(1);
  });

  it('derives the storage key from the digest, so dedup is automatic', async () => {
    const bytes = encoder.encode('key derivation\n');
    const ingested = await env.blobs.ingest(bytes, { class: 'source', contentType: 'text/plain' });
    expect(env.blobs.keyFor(ingested.sha256)).toBe(
      `blobs/sha256/${ingested.sha256.slice(0, 2)}/${ingested.sha256.slice(2, 4)}/${ingested.sha256}`,
    );
    const stored = await env.blobs.read(ingested.sha256, { verify: true });
    expect(new TextDecoder().decode(stored?.body)).toBe('key derivation\n');
  });

  it('lets two projects reference the same blob', async () => {
    const first = await env.createGame(env.alice, { slug: 'dedup-one' });
    const second = await env.createGame(env.bob, { slug: 'dedup-two' });
    const shared = 'export const shared = "one blob, two rows";\n';

    const digests: string[] = [];
    for (const [gameId, account] of [
      [first, env.alice],
      [second, env.bob],
    ] as const) {
      const written = await env.api('PUT', `/api/games/${gameId}/draft/files/src/shared.ts`, {
        account,
        ...raw(shared),
      });
      expect(written.statusCode).toBe(200);
      digests.push(written.json<{ sha256: string }>().sha256);
    }

    expect(digests[0]).toBe(digests[1]);
    const rows = env.db.all<{ path: string; blob_sha: string }>(
      `SELECT df.path, df.blob_sha FROM draft_files df JOIN game_drafts d ON d.id = df.draft_id
        WHERE df.path = 'src/shared.ts'`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.blob_sha)).size).toBe(1);
  });

  it('refuses to read a digest it never stored', async () => {
    expect(await env.blobs.read('0'.repeat(64))).toBeNull();
    expect(env.blobs.find('0'.repeat(64))).toBeNull();
  });

  it('detects corruption on a verifying read', async () => {
    const bytes = encoder.encode('integrity matters\n');
    const ingested = await env.blobs.ingest(bytes, { class: 'source', contentType: 'text/plain' });
    // Tamper with the object behind the blob store's back.
    await writeFile(join(env.root, 'storage', env.blobs.keyFor(ingested.sha256)), 'tampered');
    await expect(env.blobs.read(ingested.sha256, { verify: true })).rejects.toThrow(/integrity check failed/);
    // A non-verifying read still returns the bytes: the check is opt-in.
    expect(await env.blobs.read(ingested.sha256)).not.toBeNull();
  });
});

describe('reference counting and garbage collection', () => {
  it('never sweeps a blob that a draft still references', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'gc-live' });
    const written = await env.api('PUT', `/api/games/${gameId}/draft/files/src/live.ts`, {
      account: env.alice,
      ...raw('export const live = true;\n'),
    });
    const sha = written.json<{ sha256: string }>().sha256;

    // A clock far in the future plus no grace period makes every blob a candidate.
    const report = await collectGarbage(
      { db: env.db, driver: env.driver },
      { graceSeconds: 0, now: () => Date.now() + 86_400_000 },
    );

    expect(report.skippedBecauseLive).toBeGreaterThan(0);
    expect(env.db.get<{ sha256: string }>('SELECT sha256 FROM blobs WHERE sha256 = ?', [sha])).toBeDefined();
    expect(await env.blobs.read(sha)).not.toBeNull();
  });

  it('sweeps a blob nothing references any more', async () => {
    const orphan = await env.blobs.ingest(encoder.encode('nobody references this\n'), {
      class: 'temporary',
      contentType: 'text/plain',
    });
    expect(env.blobs.find(orphan.sha256)).not.toBeNull();

    const report = await collectGarbage({ db: env.db, driver: env.driver }, { graceSeconds: 0, now: () => Date.now() + 86_400_000 });
    expect(report.deleted).toBeGreaterThan(0);
    expect(env.blobs.find(orphan.sha256)).toBeNull();
    expect(await env.blobs.read(orphan.sha256)).toBeNull();
  });

  it('reports what a dry run would do without changing anything', async () => {
    const orphan = await env.blobs.ingest(encoder.encode('dry run only\n'), { class: 'temporary', contentType: 'text/plain' });
    const report = await collectGarbage(
      { db: env.db, driver: env.driver },
      { graceSeconds: 0, dryRun: true, now: () => Date.now() + 86_400_000 },
    );
    expect(report.dryRun).toBe(true);
    expect(report.deleted).toBeGreaterThan(0);
    expect(env.blobs.find(orphan.sha256)).not.toBeNull();

    await collectGarbage({ db: env.db, driver: env.driver }, { graceSeconds: 0, now: () => Date.now() + 86_400_000 });
  });

  it('respects the grace period so an in-flight upload is never collected', async () => {
    const fresh = await env.blobs.ingest(encoder.encode('just written\n'), { class: 'temporary', contentType: 'text/plain' });
    const report = await collectGarbage({ db: env.db, driver: env.driver }, { graceSeconds: 3600 });
    expect(env.blobs.find(fresh.sha256)).not.toBeNull();
    expect(report.deleted).toBe(0);
  });

  it('summarises where each blob is referenced from', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'gc-summary' });
    await env.publish(gameId, env.alice);
    const summary = blobReferenceSummary(env.db);
    expect(summary.draft).toBeGreaterThan(0);
    expect(summary.version).toBeGreaterThan(0);
    expect(summary.release).toBeGreaterThan(0);
    expect(summary.draft + summary.version + summary.release + summary.unreferenced).toBeGreaterThan(0);
  });
});

describe('usage accounting', () => {
  it('counts the bytes a creator actually references', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'usage-basic' });
    const before = readUsage(env.db, env.alice.id);
    const written = await env.api('PUT', `/api/games/${gameId}/draft/files/src/usage.ts`, {
      account: env.alice,
      ...raw('export const usage = "measured";\n'),
    });
    const size = written.json<{ size: number }>().size;

    const after = computeUsage(env.db, env.alice.id);
    expect(after.sourceBytes).toBeGreaterThan(before.sourceBytes);
    expect(after.sourceBytes - before.sourceBytes).toBeGreaterThanOrEqual(size);
    expect(after.gameCount).toBeGreaterThan(0);
  });

  it('counts a shared blob once per account that references it', async () => {
    const shared = 'export const shared = "counted per owner";\n';
    const mine = await env.createGame(env.alice, { slug: 'usage-shared-a' });
    const yours = await env.createGame(env.bob, { slug: 'usage-shared-b' });
    await env.api('PUT', `/api/games/${mine}/draft/files/src/shared.ts`, { account: env.alice, ...raw(shared) });
    await env.api('PUT', `/api/games/${yours}/draft/files/src/shared.ts`, { account: env.bob, ...raw(shared) });

    const aliceUsage = readUsage(env.db, env.alice.id);
    const bobUsage = readUsage(env.db, env.bob.id);
    expect(aliceUsage.sourceBytes).toBeGreaterThan(0);
    expect(bobUsage.sourceBytes).toBeGreaterThan(0);
  });

  it('exposes usage and the effective limits on /api/me/storage', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'usage-endpoint' });
    await env.publish(gameId, env.alice);
    const response = await env.api('GET', '/api/me/storage', { account: env.alice });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sourceBytes: number; releaseBytes: number; blobCount: number; gameCount: number; limits: Record<string, number> }>();
    expect(body.sourceBytes).toBeGreaterThan(0);
    expect(body.releaseBytes).toBeGreaterThan(0);
    expect(body.blobCount).toBeGreaterThan(0);
    expect(body.limits['sourceBytes']).toBe(env.config.limits.quotaUserSourceBytes);
    expect(body.limits['games']).toBe(env.config.limits.maxGamesPerUser);
  });
});

describe('quotas', () => {
  it('rejects a write that would exceed the per-account source quota', async () => {
    const gameId = await capped.createGame(capped.alice, { slug: 'quota-source' });
    const response = await capped.api('PUT', `/api/games/${gameId}/draft/files/src/big.ts`, {
      account: capped.alice,
      ...raw('x'.repeat(131_072)),
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('quota_exceeded');
    expect(response.json<{ error: { details: { bucket: string; limitBytes: number } } }>().error.details.bucket).toBe('source');
  });

  it('rejects a project creation once the game count quota is reached', async () => {
    for (let index = 0; index < 3; index += 1) {
      const created = await capped.api('POST', '/api/games', {
        account: capped.bob,
        payload: { title: 'Filler', slug: `quota-games-${index}`, description: 'x', licenseSpdx: 'MIT', template: 'bounce-dodge' },
      });
      expect(created.statusCode).toBe(200);
    }
    const rejected = await capped.api('POST', '/api/games', {
      account: capped.bob,
      payload: { title: 'One too many', slug: 'quota-games-overflow', description: 'x', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(rejected.statusCode).toBe(422);
    expect(errorCode(rejected)).toBe('quota_exceeded');
  });

  it('rejects a release that would exceed the per-account release quota', async () => {
    const narrow = await createEnv({ quotaUserReleaseBytes: 1024 });
    try {
      const gameId = await narrow.createGame(narrow.alice, { slug: 'quota-release' });
      const started = await narrow.api('POST', `/api/games/${gameId}/build`, { account: narrow.alice });
      expect(started.statusCode).toBe(422);
      expect(errorCode(started)).toBe('quota_exceeded');
      expect(started.json<{ error: { details: { bucket: string } } }>().error.details.bucket).toBe('release');

      // The in-process pipeline refuses for the same reason.
      await expect(narrow.publish(gameId, narrow.alice)).rejects.toMatchObject({ code: 'quota_exceeded' });
      expect(readUsage(narrow.db, narrow.alice.id).releaseBytes).toBe(0);
    } finally {
      await narrow.close();
    }
  });

  it('rejects a file larger than the per-file limit', async () => {
    const gameId = await smallFiles.createGame(smallFiles.alice, { slug: 'quota-file-size' });
    const response = await smallFiles.api('PUT', `/api/games/${gameId}/draft/files/src/large.ts`, {
      account: smallFiles.alice,
      ...raw('y'.repeat(16 * 1024)),
    });
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('payload_too_large');
  });

  it('rejects a tree larger than the per-project source limit', async () => {
    const bounded = await createEnv({ maxSourceBytes: 32_000 });
    try {
      const gameId = await bounded.createGame(bounded.alice, { slug: 'quota-tree-size' });
      const response = await bounded.api('PUT', `/api/games/${gameId}/draft/files/src/bulk.ts`, {
        account: bounded.alice,
        ...raw('z'.repeat(8192)),
      });
      expect(response.statusCode).toBe(422);
      expect(errorCode(response)).toBe('quota_exceeded');
    } finally {
      await bounded.close();
    }
  });
});
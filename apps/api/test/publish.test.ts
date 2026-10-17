/**
 * The build and publish pipeline, driven exactly the way `npm run seed` drives
 * it: through the worker's own `runLocalBuild`, with the API's own verification
 * and publication steps. The internal worker protocol is exercised over HTTP so
 * the secret check is asserted end to end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildJob, DraftState, GameCard, ReleaseDetail } from '@moydan/core';
import { createEnv, errorCode, raw, type TestEnv } from './harness.ts';
import { runLocalBuild } from '../../worker/src/pipeline.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await createEnv();
});

afterAll(async () => {
  await env.close();
});

function workerAuth(): Record<string, string> {
  return { authorization: `Bearer ${env.config.workerJobSecret}` };
}

async function buildJobOf(gameId: string): Promise<BuildJob> {
  const response = await env.api('GET', `/api/games/${gameId}/builds`, { account: env.alice });
  expect(response.statusCode).toBe(200);
  const jobs = response.json<{ items: BuildJob[] }>().items;
  const job = jobs[0];
  if (!job) throw new Error(`no build job for ${gameId}`);
  return job;
}

async function releaseOf(gameId: string): Promise<ReleaseDetail> {
  // The game card names the live release; the release endpoint carries the full
  // verified artifact manifest.
  const card = await env.api('GET', `/api/games/${gameId}`, { account: env.alice });
  expect(card.statusCode).toBe(200);
  const releaseId = card.json<GameCard>().release?.id;
  if (!releaseId) throw new Error(`no published release for ${gameId}`);
  const response = await env.api('GET', `/api/releases/${releaseId}`, { account: env.alice });
  expect(response.statusCode).toBe(200);
  return response.json<ReleaseDetail>();
}

describe('publish lifecycle', () => {
  it('takes a new project from draft to publicly visible', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-lifecycle' });

    const draft = await env.api('GET', `/api/games/${gameId}/draft`, { account: env.alice });
    expect(draft.json<DraftState>().validation.ok).toBe(true);
    expect((await env.api('GET', `/api/games/${gameId}`)).statusCode).toBe(404);

    const built = await env.publish(gameId, env.alice);
    expect(built.releaseId).toMatch(/^rel_/);
    expect(built.jobId).toMatch(/^job_/);

    const release = await releaseOf(gameId);
    expect(release.status).toBe('published');
    expect(release.entryUrl).toContain(built.releaseId);
    expect(release.artifactManifest.entry).toBe('index.html');
    expect(release.artifactManifest.files.map((file) => file.path)).toContain('game.js');
    expect(release.totalBytes).toBeGreaterThan(0);
    expect(release.artifactHash).toMatch(/^[0-9a-f]{64}$/);

    // Publicly visible to a stranger, with no authentication.
    const card = await env.api('GET', `/api/games/${gameId}`);
    expect(card.statusCode).toBe(200);
    const body = card.json<GameCard>();
    expect(body.status).toBe('published');
    expect(body.release?.id).toBe(built.releaseId);
    expect(body.publishedAt).toBeTruthy();
  });

  it('records the verified artifact, not the worker’s claim', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-verified' });
    const built = await env.publish(gameId, env.alice);
    const release = await releaseOf(gameId);
    for (const file of release.artifactManifest.files) {
      const row = env.db.get<{ blob_sha: string; size_bytes: number }>(
        'SELECT blob_sha, size_bytes FROM release_files WHERE release_id = ? AND path = ? AND encoding IS NULL',
        [built.releaseId, file.path],
      );
      expect(row?.blob_sha, `digest recorded for ${file.path}`).toBe(file.sha256);
      expect(Number(row?.size_bytes ?? -1)).toBe(file.size);
    }
  });

  it('is idempotent for an unchanged source tree', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-idempotent' });
    const first = await env.publish(gameId, env.alice);
    const second = await env.publish(gameId, env.alice);
    expect(second.releaseId).toBe(first.releaseId);
    expect(second.jobId).toBe(first.jobId);
    const jobs = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM build_jobs WHERE game_id = ?', [gameId]);
    expect(Number(jobs?.count ?? 0)).toBe(1);
  });

  it('produces a new release once the source tree changes', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-new-release' });
    const first = await env.publish(gameId, env.alice);
    await env.api('PUT', `/api/games/${gameId}/draft/files/src/extra.ts`, {
      account: env.alice,
      ...raw('export const extra = 1;\n'),
    });
    const second = await env.publish(gameId, env.alice);
    expect(second.releaseId).not.toBe(first.releaseId);
  });

  it('never lets a failed build replace the current release', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-failure' });
    const good = await env.publish(gameId, env.alice);

    // Import a bare module the sandbox resolver does not allow.
    await env.api('PUT', `/api/games/${gameId}/draft/files/src/main.ts`, {
      account: env.alice,
      ...raw("import thing from 'left-pad';\nexport const x = thing;\n"),
    });

    await expect(env.publish(gameId, env.alice)).rejects.toThrow();

    const card = await env.api('GET', `/api/games/${gameId}`);
    expect(card.statusCode).toBe(200);
    const body = card.json<GameCard>();
    expect(body.status).toBe('published');
    expect(body.release?.id).toBe(good.releaseId);

    const failed = await buildJobOf(gameId);
    expect(failed.status).toBe('failed');
    expect(failed.errorMessage).toBeTruthy();
    expect(failed.diagnostics.length).toBeGreaterThan(0);

    const failedRelease = env.db.get<{ status: string }>('SELECT status FROM releases WHERE id != ? AND game_id = ?', [
      good.releaseId,
      gameId,
    ]);
    expect(failedRelease?.status).toBe('failed');
  });

  it('refuses to build a draft whose manifest is invalid', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-invalid-manifest' });
    await env.api('PUT', `/api/games/${gameId}/draft/files/game.json`, {
      account: env.alice,
      ...raw(JSON.stringify({ manifestVersion: 1 })),
    });
    const started = await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    expect(started.statusCode).toBe(400);
    expect(errorCode(started)).toBe('validation_failed');
  });
});

describe('publication transitions', () => {
  it('refuses to publish a release that is not ready for review', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-not-ready' });
    const started = await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    expect(started.statusCode).toBe(200);
    const job = started.json<BuildJob>();
    expect(job.status).toBe('queued');

    const response = await env.api('POST', `/api/games/${gameId}/publish`, {
      account: env.alice,
      payload: { releaseId: job.releaseId },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
    expect(response.json<{ error: { message: string } }>().error.message).toContain('building');
  });

  it('404s for a release that belongs to another game', async () => {
    const first = await env.createGame(env.alice, { slug: 'publish-other-a' });
    const second = await env.createGame(env.alice, { slug: 'publish-other-b' });
    const built = await env.publish(first, env.alice);
    const response = await env.api('POST', `/api/games/${second}/publish`, {
      account: env.alice,
      payload: { releaseId: built.releaseId },
    });
    expect(response.statusCode).toBe(404);
  });

  it('unpublishes, republishes and withdraws', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-transitions' });
    const built = await env.publish(gameId, env.alice);

    const unpublished = await env.api('POST', `/api/games/${gameId}/unpublish`, { account: env.alice });
    expect(unpublished.json<{ status: string }>().status).toBe('unpublished');
    expect((await env.api('GET', `/api/games/${gameId}`)).statusCode).toBe(404);

    const republished = await env.api('POST', `/api/games/${gameId}/republish`, { account: env.alice });
    expect(republished.json<{ status: string }>().status).toBe('published');
    expect((await env.api('GET', `/api/games/${gameId}`)).statusCode).toBe(200);

    const withdrawn = await env.api('POST', `/api/releases/${built.releaseId}/withdraw`, {
      account: env.alice,
      payload: { reason: 'broken on a specific device' },
    });
    expect(withdrawn.json<{ status: string }>().status).toBe('withdrawn');
    // Withdrawing the live release takes the game offline.
    expect((await env.api('GET', `/api/games/${gameId}`)).statusCode).toBe(404);
    const release = env.db.get<{ status: string; withdrawn_at: string | null }>('SELECT status, withdrawn_at FROM releases WHERE id = ?', [
      built.releaseId,
    ]);
    expect(release?.status).toBe('withdrawn');
    expect(release?.withdrawn_at).toBeTruthy();
  });

  it('refuses to republish a game that was never published', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-never' });
    const response = await env.api('POST', `/api/games/${gameId}/republish`, { account: env.alice });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
  });

  it('mints a preview grant that the game origin can resolve', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-preview' });
    await env.publish(gameId, env.alice);
    const release = await releaseOf(gameId);
    const grant = await env.api('POST', `/api/releases/${release.id}/preview-grant`, { account: env.alice });
    expect(grant.statusCode).toBe(200);
    const body = grant.json<{ token: string; expiresAt: string; url: string }>();
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(body.url).toContain(body.token);

    const resolved = await env.api('GET', `/api/internal/preview-grants/${release.id}?token=${body.token}`, {
      headers: workerAuth(),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<{ gameId: string }>().gameId).toBe(gameId);

    const rejected = await env.api('GET', `/api/internal/preview-grants/${release.id}?token=forged`, {
      headers: workerAuth(),
    });
    expect(rejected.statusCode).toBe(403);
  });
});

describe('internal worker protocol', () => {
  it.each([
    ['no Authorization header', {}],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['the wrong secret', { authorization: 'Bearer not-the-secret' }],
    ['a viewer session token', { authorization: 'Bearer not-a-session-either' }],
  ])('rejects a claim with %s', async (_label, headers) => {
    const response = await env.api('POST', '/api/internal/builds/claim', { headers, payload: { workerId: 'w1' } });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
  });

  it('rejects the artifact and finish endpoints with a wrong secret', async () => {
    for (const url of ['/api/internal/builds/job_x/artifacts', '/api/internal/builds/job_x/finish', '/api/internal/builds/job_x/fail']) {
      const response = await env.api('POST', url, { headers: { authorization: 'Bearer wrong' }, payload: {} });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('claims a queued job, uploads artifacts and finishes it', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-protocol' });
    await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });

    const claim = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'worker-under-test' },
    });
    expect(claim.statusCode).toBe(200);
    const claimed = claim.json<{ job: BuildJob; version: { fileCount: number }; files: { path: string }[] }>();
    expect(claimed.job.status).toBe('building');
    expect(claimed.version.fileCount).toBeGreaterThan(0);
    expect(claimed.files.map((file) => file.path)).toContain('game.json');

    const entry = Buffer.from('<!doctype html><html><body><script type="module" src="./game.js"></script></body></html>').toString(
      'base64',
    );
    const bundle = Buffer.from('console.log("built");').toString('base64');

    const uploaded = await env.api('POST', `/api/internal/builds/${claimed.job.id}/artifacts`, {
      headers: workerAuth(),
      payload: { workerId: 'worker-under-test', path: 'index.html', contentType: 'text/html', entry: true, contentBase64: entry },
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json<{ size: number }>().size).toBeGreaterThan(0);

    const second = await env.api('POST', `/api/internal/builds/${claimed.job.id}/artifacts`, {
      headers: workerAuth(),
      payload: { workerId: 'worker-under-test', path: 'game.js', contentBase64: bundle },
    });
    expect(second.statusCode).toBe(200);

    const finished = await env.api('POST', `/api/internal/builds/${claimed.job.id}/finish`, {
      headers: workerAuth(),
      payload: {
        workerId: 'worker-under-test',
        manifest: {
          version: 1,
          entry: 'index.html',
          // The worker claims a digest that does not exist: the server must use
          // the rows it wrote itself.
          files: [{ path: 'index.html', size: 1, contentType: 'text/html', sha256: '0'.repeat(64) }],
          totalBytes: 1,
          firstPlayableBytes: 1,
        },
        log: 'built by the test worker',
      },
    });
    expect(finished.statusCode).toBe(200);

    const release = env.db.get<{ status: string; artifact_manifest_json: string }>(
      'SELECT status, artifact_manifest_json FROM releases WHERE id = ?',
      [claimed.job.releaseId],
    );
    expect(release?.status).toBe('ready_for_review');
    const manifest = JSON.parse(release?.artifact_manifest_json ?? '{}') as ReleaseDetail['artifactManifest'];
    expect(manifest.files.find((file) => file.path === 'index.html')?.sha256).not.toBe('0'.repeat(64));
  });

  it.each([
    ['a source map', 'game.js.map'],
    ['uncompiled TypeScript', 'game.ts'],
    ['a traversing path', '../escape.js'],
  ])('refuses %s as an artifact path', async (_label, path) => {
    const gameId = await env.createGame(env.alice, { slug: `publish-artifact-${path.replace(/\W/g, '')}` });
    await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    const claim = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'worker-artifacts' },
    });
    const job = claim.json<{ job: BuildJob }>().job;
    const response = await env.api('POST', `/api/internal/builds/${job.id}/artifacts`, {
      headers: workerAuth(),
      payload: {
        workerId: 'worker-artifacts',
        path,
        contentBase64: Buffer.from('x').toString('base64'),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('refuses base64 that does not re-encode to itself', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-base64' });
    await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    const claim = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'worker-base64' },
    });
    const job = claim.json<{ job: BuildJob }>().job;
    const response = await env.api('POST', `/api/internal/builds/${job.id}/artifacts`, {
      headers: workerAuth(),
      payload: { workerId: 'worker-base64', path: 'index.html', contentBase64: 'not*base64' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an artifact upload from a worker that does not hold the lease', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-lease' });
    await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    const claim = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'lease-owner' },
    });
    const job = claim.json<{ job: BuildJob }>().job;
    const response = await env.api('POST', `/api/internal/builds/${job.id}/artifacts`, {
      headers: workerAuth(),
      payload: {
        workerId: 'someone-else',
        path: 'index.html',
        contentBase64: Buffer.from('<html></html>').toString('base64'),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
  });

  it('reports an empty queue with 204 rather than an error', async () => {
    const response = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'idle-worker' },
    });
    // Drain whatever is still queued, then the next claim must be empty.
    for (let attempt = 0; attempt < 50 && response.statusCode !== 204; attempt += 1) {
      const next = await env.api('POST', '/api/internal/builds/claim', {
        headers: workerAuth(),
        payload: { workerId: `drain-${attempt}` },
      });
      if (next.statusCode === 204) break;
      const job = next.json<{ job: BuildJob }>().job;
      await env.api('POST', `/api/internal/builds/${job.id}/fail`, {
        headers: workerAuth(),
        payload: { workerId: `drain-${attempt}`, code: 'cancelled', message: 'test drain' },
      });
    }
    const empty = await env.api('POST', '/api/internal/builds/claim', {
      headers: workerAuth(),
      payload: { workerId: 'idle-worker' },
    });
    expect(empty.statusCode).toBe(204);
  });

  it('builds two projects created from the same template independently', async () => {
    // Both projects have byte-identical source, so their tree hashes match. The
    // idempotency key must still be scoped per game, otherwise the second build
    // would hand back the first game's release.
    const firstGame = await env.createGame(env.alice, { slug: 'same-template-one' });
    const secondGame = await env.createGame(env.bob, { slug: 'same-template-two' });

    const first = await env.publish(firstGame, env.alice);
    const second = await env.publish(secondGame, env.bob);

    expect(first.releaseId).not.toBe(second.releaseId);

    const firstRelease = await env.api('GET', `/api/releases/${first.releaseId}`);
    expect(firstRelease.statusCode).toBe(200);
    expect(firstRelease.json<ReleaseDetail>().versionId).toBeTruthy();

    const secondRelease = await env.api('GET', `/api/releases/${second.releaseId}`);
    expect(secondRelease.statusCode).toBe(200);

    // Each release belongs to its own game and its own project.
    const releases = await env.api('GET', `/api/games/${secondGame}/releases`, { account: env.bob });
    expect(releases.json<{ items: { id: string }[] }>().items.map((item) => item.id)).toContain(second.releaseId);
  });
});

describe('release visibility', () => {
  it('hides an unpublished release from strangers', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-private-release' });
    const started = await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    const releaseId = started.json<BuildJob>().releaseId as string;

    expect((await env.api('GET', `/api/releases/${releaseId}`, { account: env.bob })).statusCode).toBe(404);
    expect((await env.api('GET', `/api/releases/${releaseId}`)).statusCode).toBe(404);
    expect((await env.api('GET', `/api/games/${gameId}/releases`, { account: env.bob })).statusCode).toBe(404);
  });

  it('lets the owner read their own in-progress or failed release', async () => {
    // A release that has not been verified yet has no artifact manifest. The
    // owner must get their build state, never a 500; strangers still see nothing.
    const gameId = await env.createGame(env.alice, { slug: 'publish-owner-read' });
    const started = await env.api('POST', `/api/games/${gameId}/build`, { account: env.alice });
    const releaseId = started.json<BuildJob>().releaseId as string;

    const owner = await env.api('GET', `/api/releases/${releaseId}`, { account: env.alice });
    expect(owner.statusCode).not.toBe(500);

    const stranger = await env.api('GET', `/api/releases/${releaseId}`, { account: env.bob });
    expect(stranger.statusCode).toBe(404);
  });

  it('serves the published source as plain text, never as executable content', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-source-view' });
    await env.publish(gameId, env.alice);

    const listing = await env.api('GET', `/api/games/${gameId}/source`);
    expect(listing.statusCode).toBe(200);
    const body = listing.json<{ versionId: string; visible: boolean; files: { path: string }[] }>();
    expect(body.visible).toBe(true);
    expect(body.files.map((file) => file.path)).toContain('src/main.ts');

    const file = await env.api('GET', `/api/games/${gameId}/source/files/src/main.ts`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/plain');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    // A traversing source path is a miss, never a file read.
    expect((await env.api('GET', `/api/games/${gameId}/source/files/%2e%2e%2Fpackage.json`)).statusCode).toBe(404);
  });

  it('keeps the source of a proprietary publication private', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-proprietary' });
    await env.publish(gameId, env.alice);
    env.db.run("UPDATE games SET license_spdx = 'LicenseRef-AllRightsReserved' WHERE id = ?", [gameId]);
    env.db.run("UPDATE source_versions SET license_spdx = 'LicenseRef-AllRightsReserved' WHERE game_id = ?", [gameId]);

    expect((await env.api('GET', `/api/games/${gameId}/source`, { account: env.bob })).statusCode).toBe(403);
    // The owner still has access to their own tree.
    expect((await env.api('GET', `/api/games/${gameId}/source`, { account: env.alice })).statusCode).toBe(200);
  });
});

describe('build idempotency at the service layer', () => {
  it('reuses the job and release for an unchanged tree', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'publish-service-idempotent' });
    const first = await runLocalBuild({ db: env.db, blobs: env.blobs, limits: env.config.limits, config: env.config }, {
      gameId,
      userId: env.alice.id,
    });
    const second = await runLocalBuild({ db: env.db, blobs: env.blobs, limits: env.config.limits, config: env.config }, {
      gameId,
      userId: env.alice.id,
    });
    expect(second).toEqual(first);
  });
});
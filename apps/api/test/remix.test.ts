/**
 * Remixing. Both modes are derivative works, so the assertions here are mostly
 * about *provenance*: which exact parent version is pinned, which blobs are
 * shared, what attribution text is carried and which child licences the parent's
 * policy allows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameCard, LineageNode, RemixOrigin } from '@moydan/core';
import { createEnv, errorCode, raw, type TestEnv } from './harness.ts';

let env: TestEnv;
let parent: string;

beforeAll(async () => {
  env = await createEnv();
  parent = await env.createGame(env.alice, { slug: 'remix-parent', title: 'Bounce Dodge' });
  await env.publish(parent, env.alice);
});

afterAll(async () => {
  await env.close();
});

async function lineage(gameId: string): Promise<{ origin: RemixOrigin | null; ancestors: LineageNode[] }> {
  const response = await env.api('GET', `/api/games/${gameId}/lineage`, { account: env.bob });
  expect(response.statusCode).toBe(200);
  return response.json<{ origin: RemixOrigin | null; ancestors: LineageNode[] }>();
}

function remix(gameId: string, payload: Record<string, unknown>) {
  return env.api('POST', `/api/games/${gameId}/remix`, { account: env.bob, payload });
}

/** Rewrite the draft manifest and rebuild so the change is part of the release. */
async function gameWithManifest(
  slug: string,
  mutate: (manifest: Record<string, unknown>) => void,
  account = env.alice,
): Promise<string> {
  const gameId = await env.createGame(account, { slug });
  const response = await env.api('GET', `/api/games/${gameId}/draft/files/game.json`, { account });
  const manifest = JSON.parse(response.body) as Record<string, unknown>;
  mutate(manifest);
  const written = await env.api('PUT', `/api/games/${gameId}/draft/files/game.json`, {
    account,
    ...raw(JSON.stringify(manifest)),
  });
  expect(written.statusCode).toBe(200);
  await env.publish(gameId, account);
  return gameId;
}

describe('remix options', () => {
  it('advertises the parent’s modes, parameters and child licences', async () => {
    const response = await env.api('GET', `/api/games/${parent}/remix-options`, { account: env.bob });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      allowed: boolean;
      modes: string[];
      parameters: { key: string }[];
      allowedChildLicenses: string[];
    }>();
    expect(body.allowed).toBe(true);
    expect(body.modes).toEqual(['parameters', 'source']);
    expect(body.parameters.map((parameter) => parameter.key)).toContain('speed');
    expect(body.allowedChildLicenses).toContain('MIT');
  });
});

describe('eligibility', () => {
  it('hides an unpublished game from a stranger', async () => {
    const draft = await env.createGame(env.alice, { slug: 'remix-draft' });
    const response = await remix(draft, { mode: 'source', slug: 'remix-of-draft' });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to remix an unpublished game even for its owner', async () => {
    const unpublished = await env.createGame(env.alice, { slug: 'remix-unpublished' });
    await env.publish(unpublished, env.alice);
    await env.api('POST', `/api/games/${unpublished}/unpublish`, { account: env.alice });
    const response = await env.api('POST', `/api/games/${unpublished}/remix`, {
      account: env.alice,
      payload: { mode: 'source', slug: 'remix-of-unpublished' },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('remix_not_allowed');
    expect(response.json<{ error: { message: string } }>().error.message).toContain('published');
  });

  it('refuses a parent whose licence forbids derivative works', async () => {
    const noDerivatives = await env.createGame(env.alice, { slug: 'remix-nd' });
    await env.publish(noDerivatives, env.alice);
    // A no-derivatives licence cannot be shipped in a manifest (it is not a code
    // licence), so the row is set directly: the capability gate must still read
    // the licence, not only the manifest.
    env.db.run("UPDATE games SET license_spdx = 'CC-BY-ND-4.0' WHERE id = ?", [noDerivatives]);

    const response = await remix(noDerivatives, { mode: 'source', slug: 'remix-of-nd' });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('remix_not_allowed');
    expect(response.json<{ error: { message: string } }>().error.message).toContain('does not permit derivative');
  });

  it('refuses a parent that disabled remixing in its manifest', async () => {
    const closed = await gameWithManifest('remix-closed', (manifest) => {
      manifest['remix'] = { allowed: false, modes: [], parameters: [] };
    });
    const options = await env.api('GET', `/api/games/${closed}/remix-options`, { account: env.bob });
    expect(options.json<{ allowed: boolean; reason: string }>().allowed).toBe(false);
    expect(options.json<{ reason: string }>().reason).toContain('disabled remixing');

    const response = await remix(closed, { mode: 'source', slug: 'remix-of-closed' });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('remix_not_allowed');
  });

  it('refuses a mode the parent does not offer', async () => {
    const parametersOnly = await gameWithManifest('remix-params-only', (manifest) => {
      manifest['remix'] = {
        allowed: true,
        modes: ['parameters'],
        parameters: [{ key: 'speed', label: 'Speed', type: 'number', min: 1, max: 2, default: 1 }],
      };
    });
    const options = await env.api('GET', `/api/games/${parametersOnly}/remix-options`, { account: env.bob });
    expect(options.json<{ modes: string[] }>().modes).toEqual(['parameters']);

    const response = await remix(parametersOnly, { mode: 'source', slug: 'remix-of-params-only' });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('remix_not_allowed');
  });
});

describe('parameter validation', () => {
  it('rejects an unknown parameter key', async () => {
    const response = await remix(parent, { mode: 'parameters', slug: 'remix-unknown-param', params: { nope: 1 } });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
    expect(response.json<{ error: { details: { issues: { key: string }[] } } }>().error.details.issues[0]?.key).toBe('nope');
  });

  it('rejects a parameter outside the declared range', async () => {
    const response = await remix(parent, { mode: 'parameters', slug: 'remix-range', params: { speed: 99 } });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('rejects a parameter of the wrong type', async () => {
    const response = await remix(parent, { mode: 'parameters', slug: 'remix-type', params: { shake: 'yes' } });
    expect(response.statusCode).toBe(400);
  });
});

describe('parameter remix', () => {
  it('creates a distinct child that pins the exact parent version', async () => {
    const response = await remix(parent, {
      mode: 'parameters',
      slug: 'remix-params-child',
      title: 'Fast Dodge',
      params: { speed: 2.2, lives: 1 },
    });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { id: string } }>().game;
    expect(child.id).not.toBe(parent);

    const parentCard = await env.api('GET', `/api/games/${parent}`);
    const parentVersion = parentCard.json<GameCard>().source?.versionId;

    const { origin } = await lineage(child.id);
    expect(origin?.mode).toBe('parameters');
    expect(origin?.parent.gameId).toBe(parent);
    // The exact version is frozen into the lineage row so a later parent release
    // can never rewrite history.
    expect(origin?.parent.versionId).toBe(parentVersion);
    expect(origin?.params).toMatchObject({ speed: 2.2, lives: 1 });
  });

  it('fills unspecified parameters from the declared defaults', async () => {
    const response = await remix(parent, { mode: 'parameters', slug: 'remix-defaults', params: { speed: 1.8 } });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { id: string } }>().game;
    const { origin } = await lineage(child.id);
    expect(origin?.params).toMatchObject({ speed: 1.8, lives: 3 });
  });

  it('starts the child engagement counters at zero', async () => {
    const response = await remix(parent, { mode: 'parameters', slug: 'remix-counters' });
    const child = response.json<{ game: { id: string } }>().game;
    const card = await env.api('GET', `/api/games/${child.id}`, { account: env.bob });
    expect(card.json<GameCard>().stats).toMatchObject({ reactions: 0, comments: 0, saves: 0, plays: 0, remixes: 0 });
  });

  it('leaves the parent untouched', async () => {
    const beforeCard = (await env.api('GET', `/api/games/${parent}`)).json<GameCard>();
    await remix(parent, { mode: 'parameters', slug: 'remix-parent-untouched' });
    const afterCard = (await env.api('GET', `/api/games/${parent}`)).json<GameCard>();
    expect(afterCard.status).toBe(beforeCard.status);
    expect(afterCard.source?.versionId).toBe(beforeCard.source?.versionId);
    expect(afterCard.source?.treeHash).toBe(beforeCard.source?.treeHash);
  });
});

describe('source remix', () => {
  it('references the parent blobs instead of copying the bytes', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-source-child' });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { id: string } }>().game;

    const childFiles = env.db.all<{ path: string; blob_sha: string }>(
      `SELECT df.path, df.blob_sha FROM draft_files df
        JOIN game_drafts d ON d.id = df.draft_id WHERE d.game_id = ?`,
      [child.id],
    );
    const parentVersion = (await env.api('GET', `/api/games/${parent}`)).json<GameCard>().source?.versionId;
    const parentFiles = new Map(
      env.db
        .all<{ path: string; blob_sha: string }>('SELECT path, blob_sha FROM version_files WHERE version_id = ?', [
          parentVersion ?? '',
        ])
        .map((row) => [row.path, row.blob_sha]),
    );

    expect(childFiles.length).toBeGreaterThan(0);
    expect(childFiles.length).toBe(parentFiles.size);
    for (const file of childFiles) {
      expect(parentFiles.get(file.path), `child blob for ${file.path}`).toBe(file.blob_sha);
    }
  });

  it('only writes new blobs once a file is actually edited', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-editable' });
    const child = response.json<{ game: { id: string } }>().game;
    const before = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM blobs');

    const edited = await env.api('PUT', `/api/games/${child.id}/draft/files/src/extra.ts`, {
      account: env.bob,
      ...raw('export const extra = 1;\n'),
    });
    expect(edited.statusCode).toBe(200);

    const after = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM blobs');
    // Exactly one new blob: the new file. Everything else still shares.
    expect(Number(after?.count ?? 0)).toBe(Number(before?.count ?? 0) + 1);
  });

  it('marks the child as a remix and records the root game', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-rooted' });
    const child = response.json<{ game: { id: string } }>().game;
    const { origin } = await lineage(child.id);
    expect(origin?.rootGameId).toBe(parent);
    const card = await env.api('GET', `/api/games/${child.id}`, { account: env.bob });
    expect(card.json<GameCard>().isRemix).toBe(true);
  });

  it('builds and publishes the child like any other project', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-publishable' });
    const child = response.json<{ game: { id: string } }>().game;
    const edited = await env.api('PUT', `/api/games/${child.id}/draft/files/src/extra.ts`, {
      account: env.bob,
      ...raw('export const extra = 1;\n'),
    });
    expect(edited.statusCode).toBe(200);

    const built = await env.publish(child.id, env.bob);
    const card = await env.api('GET', `/api/games/${child.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json<GameCard>().release?.id).toBe(built.releaseId);
  });

  it('increments the parent remix counter once the child is published', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-counted' });
    const child = response.json<{ game: { id: string } }>().game;
    await env.api('PUT', `/api/games/${child.id}/draft/files/src/counted.ts`, {
      account: env.bob,
      ...raw('export const counted = true;\n'),
    });
    await env.publish(child.id, env.bob);
    const card = await env.api('GET', `/api/games/${parent}`, { account: env.alice });
    expect(card.json<GameCard>().stats.remixes).toBeGreaterThan(0);
  });

  it('builds and publishes a source remix that has not been edited yet', async () => {
    // A source remix shares every blob with its parent, so both have the same
    // tree hash. The build idempotency key is scoped per game, so the child gets
    // its own release instead of the parent's.
    const response = await remix(parent, { mode: 'source', slug: 'remix-unedited', title: 'Unedited Child' });
    const child = response.json<{ game: { id: string } }>().game;

    const built = await env.publish(child.id, env.bob);
    expect(built.releaseId).toBeTruthy();

    const parentRelease = await env.api("GET", `/api/games/${parent}/releases`, { account: env.alice });
    const parentReleaseIds = parentRelease.json<{ items: { id: string }[] }>().items.map((item) => item.id);
    expect(parentReleaseIds).not.toContain(built.releaseId);

    const card = await env.api('GET', `/api/games/${child.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json<{ status: string }>().status).toBe('published');
    // Attribution and lineage survive the child being published.
    expect(card.json<{ remixOrigin: { parent: { gameId: string } } | null }>().remixOrigin?.parent.gameId).toBe(parent);
  });
});

describe('attribution', () => {
  it('carries the parent’s title, handle, licence and mode into the lineage', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-attributed', title: 'Attributed Child' });
    const child = response.json<{ game: { id: string } }>().game;
    const { origin } = await lineage(child.id);
    expect(origin?.parent.title).toBe('Bounce Dodge');
    expect(origin?.parent.creator.handle).toBe(env.alice.handle);
    expect(origin?.parent.licenseSpdx).toBe('MIT');
    expect(origin?.attributionText).toContain('"Attributed Child"');
    expect(origin?.attributionText).toContain(env.alice.handle);
    expect(origin?.attributionText).toContain('Bounce Dodge');
  });

  it('chains attribution through several generations', async () => {
    const first = await remix(parent, { mode: 'source', slug: 'remix-gen-1', title: 'Generation One' });
    const genOne = first.json<{ game: { id: string } }>().game;
    await env.api('PUT', `/api/games/${genOne.id}/draft/files/src/gen-one.ts`, {
      account: env.bob,
      ...raw('export const generation = 1;\n'),
    });
    await env.publish(genOne.id, env.bob);
    const second = await remix(genOne.id, { mode: 'source', slug: 'remix-gen-2', title: 'Generation Two' });
    expect(second.statusCode).toBe(200);
    const genTwo = second.json<{ game: { id: string } }>().game;

    const { origin, ancestors } = await lineage(genTwo.id);
    expect(origin?.parent.gameId).toBe(genOne.id);
    expect(ancestors.map((node) => node.gameId)).toEqual([genOne.id, parent]);
    expect(origin?.rootGameId).toBe(parent);
  });

  it('keeps the lineage row after the parent is unpublished', async () => {
    const temporaryParent = await env.createGame(env.alice, { slug: 'remix-temporary-parent' });
    await env.publish(temporaryParent, env.alice);
    const response = await remix(temporaryParent, { mode: 'source', slug: 'remix-lineage' });
    const child = response.json<{ game: { id: string } }>().game;

    await env.api('POST', `/api/games/${temporaryParent}/unpublish`, { account: env.alice });

    const row = env.db.get<{ id: string }>('SELECT id FROM remix_relations WHERE child_game_id = ?', [child.id]);
    expect(row).toBeDefined();

    const { origin, ancestors } = await lineage(child.id);
    expect(origin?.parent.gameId).toBe(temporaryParent);
    expect(ancestors.map((node) => node.gameId)).toEqual([temporaryParent]);
    // The creator can still see their own now-unpublished game.
    expect((await env.api('GET', `/api/games/${temporaryParent}`, { account: env.alice })).statusCode).toBe(200);
    // ...but nobody else can.
    expect((await env.api('GET', `/api/games/${temporaryParent}`)).statusCode).toBe(404);
  });
});

describe('share-alike', () => {
  it('restricts the child licence to what the parent policy allows', async () => {
    const agplParent = await gameWithManifest('remix-agpl', (manifest) => {
      manifest['license'] = { ...(manifest['license'] as object), spdx: 'AGPL-3.0-only' };
    });
    const response = await remix(agplParent, { mode: 'source', slug: 'remix-agpl-mit', childLicenseSpdx: 'MIT' });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('license_rejected');
    expect(response.json<{ error: { details: { allowedLicenses: string[] } } }>().error.details.allowedLicenses).toEqual([
      'AGPL-3.0-only',
    ]);
  });

  it('accepts the share-alike licence and records it on the child', async () => {
    const agplParent = await gameWithManifest('remix-agpl-ok', (manifest) => {
      manifest['license'] = { ...(manifest['license'] as object), spdx: 'AGPL-3.0-only' };
    });
    const response = await remix(agplParent, {
      mode: 'source',
      slug: 'remix-agpl-child',
      childLicenseSpdx: 'AGPL-3.0-only',
    });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { id: string; license_spdx: string } }>().game;
    expect(child.license_spdx).toBe('AGPL-3.0-only');
    const { origin } = await lineage(child.id);
    expect(origin?.attributionText).toContain('AGPL-3.0-only');
    expect(origin?.attributionText).toContain('Network users must be offered the corresponding source');
  });

  it('defaults the child licence to the parent’s when share-alike allows it', async () => {
    const agplParent = await gameWithManifest('remix-agpl-default', (manifest) => {
      manifest['license'] = { ...(manifest['license'] as object), spdx: 'AGPL-3.0-only' };
    });
    const response = await remix(agplParent, { mode: 'source', slug: 'remix-agpl-default-child' });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { license_spdx: string } }>().game;
    expect(child.license_spdx).toBe('AGPL-3.0-only');
  });

  it('lets a permissive parent declare any code licence', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-permissive-child', childLicenseSpdx: 'Apache-2.0' });
    expect(response.statusCode).toBe(200);
    const child = response.json<{ game: { id: string; license_spdx: string } }>().game;
    // The child's manifest is inherited from the parent, so the manifest licence
    // still wins on the row; the requested licence is what the lineage records.
    const row = env.db.get<{ license_spdx: string }>('SELECT license_spdx FROM remix_relations WHERE child_game_id = ?', [
      child.id,
    ]);
    expect(row?.license_spdx).toBe('Apache-2.0');
  });

  it('rejects a licence the platform does not recognise at all', async () => {
    const response = await remix(parent, { mode: 'source', slug: 'remix-bad-licence', childLicenseSpdx: 'WTFPL' });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('license_rejected');
  });
});

describe('remix authorisation', () => {
  it('requires a signed-in creator', async () => {
    const response = await env.api('POST', `/api/games/${parent}/remix`, { payload: { mode: 'source' } });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a duplicate slug for the same creator', async () => {
    await remix(parent, { mode: 'source', slug: 'remix-duplicate' });
    const response = await remix(parent, { mode: 'source', slug: 'remix-duplicate' });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
  });
});
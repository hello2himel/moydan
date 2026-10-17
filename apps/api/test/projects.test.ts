/**
 * Creator projects: template scaffolding, the mutable draft file tree, path
 * policy on every write, archive import/export and ownership.
 */

import { randomBytes } from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DraftState, ProjectFile } from '@moydan/core';
import { createEnv, errorCode, raw, type TestEnv } from './harness.ts';

let env: TestEnv;
/** A second environment whose archive ceiling is deliberately tiny. */
let tiny: TestEnv;
let gameId: string;

const encoder = new TextEncoder();

beforeAll(async () => {
  env = await createEnv();
  tiny = await createEnv({ maxArchiveBytes: 4096 });
  gameId = await env.createGame(env.alice, { slug: 'projects-main' });
});

afterAll(async () => {
  await tiny.close();
  await env.close();
});

async function draftState(): Promise<DraftState> {
  const response = await env.api('GET', `/api/games/${gameId}/draft`, { account: env.alice });
  expect(response.statusCode).toBe(200);
  return response.json<DraftState>();
}

async function putFile(path: string, content: string): Promise<ReturnType<TestEnv['api']>> {
  return env.api('PUT', `/api/games/${gameId}/draft/files/${path}`, { account: env.alice, ...raw(content) });
}

describe('POST /api/games', () => {
  it('creates a draft from a template with the template files in place', async () => {
    const state = await draftState();
    expect(state.gameId).toBe(gameId);
    expect(state.slug).toBe('projects-main');
    expect(state.validation.ok).toBe(true);
    expect(state.license.spdx).toBe('MIT');
    const paths = state.files.map((file) => file.path);
    expect(paths).toContain('game.json');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('src/main.ts');
  });

  it('reports the declared remix capabilities of the template', async () => {
    const state = await draftState();
    expect(state.capabilities.remixModes).toEqual(['parameters', 'source']);
    expect(state.capabilities.engine).toEqual({ name: 'canvas2d', version: '1.0.0' });
    expect(state.capabilities.parameters.map((parameter) => parameter.key)).toContain('speed');
  });

  it('rejects an unknown template with 404', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      payload: { title: 'x', slug: 'x-unknown', description: 'y', licenseSpdx: 'MIT', template: 'does-not-exist' },
    });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });

  it('rejects a licence that is not code', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      payload: { title: 'x', slug: 'x-licence', description: 'y', licenseSpdx: 'CC-BY-4.0', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('license_rejected');
  });

  it('rejects a licence that does not match the template', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      payload: { title: 'x', slug: 'x-mismatch', description: 'y', licenseSpdx: 'GPL-3.0-only', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('license_rejected');
  });

  it('refuses a slug the creator already uses', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      payload: { title: 'Again', slug: 'projects-main', description: 'y', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
  });

  it('rejects a malformed slug', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      payload: { title: 'x', slug: 'Not A Slug', description: 'y', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('draft files', () => {
  it('writes a file and reads the exact bytes back', async () => {
    const content = 'export const marker = "written-by-a-test";\n';
    const written = await putFile('src/marker.ts', content);
    expect(written.statusCode).toBe(200);
    const file = written.json<ProjectFile>();
    expect(file.path).toBe('src/marker.ts');
    expect(file.role).toBe('source');
    expect(file.contentType).toBe('text/plain');
    expect(file.size).toBe(content.length);

    const read = await env.api('GET', `/api/games/${gameId}/draft/files/src/marker.ts`, { account: env.alice });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe(content);
    // Creator markup must never be served as executable content.
    expect(read.headers['content-type']).toContain('text/plain');
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect(read.headers['cache-control']).toBe('private, no-store');
  });

  it('bumps the draft revision on every write', async () => {
    const before = await draftState();
    await putFile('src/marker.ts', 'export const marker = 2;\n');
    const after = await draftState();
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('renames a file and keeps the old path unreachable', async () => {
    await putFile('src/old-name.ts', 'export const old = 1;\n');
    const renamed = await env.api('POST', `/api/games/${gameId}/draft/files/rename`, {
      account: env.alice,
      payload: { from: 'src/old-name.ts', to: 'src/new-name.ts' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await env.api('GET', `/api/games/${gameId}/draft/files/src/new-name.ts`, { account: env.alice })).statusCode).toBe(200);
    expect((await env.api('GET', `/api/games/${gameId}/draft/files/src/old-name.ts`, { account: env.alice })).statusCode).toBe(404);
  });

  it('refuses to rename onto an existing path', async () => {
    await putFile('src/a.ts', 'export const a = 1;\n');
    await putFile('src/b.ts', 'export const b = 1;\n');
    const response = await env.api('POST', `/api/games/${gameId}/draft/files/rename`, {
      account: env.alice,
      payload: { from: 'src/a.ts', to: 'src/b.ts' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('deletes a file', async () => {
    await putFile('src/doomed.ts', 'export const doomed = 1;\n');
    const deleted = await env.api('DELETE', `/api/games/${gameId}/draft/files/src/doomed.ts`, { account: env.alice });
    expect(deleted.statusCode).toBe(200);
    expect((await env.api('GET', `/api/games/${gameId}/draft/files/src/doomed.ts`, { account: env.alice })).statusCode).toBe(404);
  });

  it('refuses to delete the manifest or the licence', async () => {
    const manifest = await env.api('DELETE', `/api/games/${gameId}/draft/files/game.json`, { account: env.alice });
    expect(manifest.statusCode).toBe(400);
    expect(manifest.json<{ error: { message: string } }>().error.message).toContain('manifest');

    const licence = await env.api('DELETE', `/api/games/${gameId}/draft/files/LICENSE`, { account: env.alice });
    expect(licence.statusCode).toBe(400);
    expect(licence.json<{ error: { message: string } }>().error.message).toContain('LICENSE');
  });
});

describe('path policy on writes', () => {
  it.each([
    ['traversal', '..%2F..%2Fetc%2Fpasswd'],
    ['an absolute path', '%2Fetc%2Fpasswd'],
    ['a backslash separator', 'src%5Cmain.ts'],
  ])('refuses %s', async (_label, encoded) => {
    const response = await env.api('PUT', `/api/games/${gameId}/draft/files/${encoded}`, {
      account: env.alice,
      ...raw('malicious'),
    });
    expect([400, 404]).toContain(response.statusCode);
  });

  it('refuses a file outside any allowed project directory', async () => {
    for (const path of ['tools/build.ts', 'src/nested/deep.exe', '.env']) {
      const response = await putFile(path, 'content');
      expect(response.statusCode, `path ${path}`).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }
  });

  it('refuses content that contradicts its extension', async () => {
    const response = await putFile('assets/liar.png', '#!/bin/sh\necho pwned\n');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe('declared_type_mismatch');
  });

  it('refuses an SVG carrying script', async () => {
    const response = await putFile('assets/evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe('svg_active_content');
  });
});

describe('validation', () => {
  const validShape = {
    manifestVersion: 1,
    slug: 'projects-broken',
    title: 'Broken',
    description: 'A deliberately broken manifest for the validation endpoint.',
    engine: { name: 'canvas2d', version: '1.0.0' },
    runtime: { apiVersion: '1' },
    entry: 'src/main.ts',
    orientation: 'portrait',
    viewport: { width: 720, height: 1280, scale: 'fit' },
    input: ['pointer'],
    capabilities: [],
    license: { spdx: 'MIT', assets: [] },
    remix: { allowed: true, modes: ['parameters'], parameters: [] },
  };

  async function validateManifest(
    manifest: unknown,
  ): Promise<{ ok: boolean; issues: { path: string; code: string; message: string }[] }> {
    const slug = `projects-validate-${Math.random().toString(36).slice(2, 8)}`;
    const target = await env.createGame(env.alice, { slug });
    const written = await env.api('PUT', `/api/games/${target}/draft/files/game.json`, {
      account: env.alice,
      ...raw(JSON.stringify(manifest)),
    });
    expect(written.statusCode).toBe(200);
    const response = await env.api('POST', `/api/games/${target}/draft/validate`, { account: env.alice });
    expect(response.statusCode).toBe(200);
    return response.json<{ ok: boolean; issues: { path: string; code: string; message: string }[] }>();
  }

  it('reports schema violations before any cross-check runs', async () => {
    const body = await validateManifest({
      ...validShape,
      engine: { name: 'unity', version: '1.0.0' },
      orientation: 'sideways',
      viewport: { width: 10, height: 10, scale: 'fit' },
    });
    expect(body.ok).toBe(false);
    const paths = body.issues.map((issue) => issue.path);
    expect(paths).toContain('engine.name');
    expect(paths).toContain('orientation');
    expect(paths).toContain('viewport.width');
  });

  it('reports cross-check violations once the shape is valid', async () => {
    const body = await validateManifest({
      ...validShape,
      engine: { name: 'canvas2d', version: '9.9.9' },
      runtime: { apiVersion: '7' },
      remix: { allowed: false, modes: ['source'], parameters: [] },
    });
    expect(body.ok).toBe(false);
    const paths = body.issues.map((issue) => issue.path);
    expect(paths).toContain('engine.version');
    expect(paths).toContain('runtime.apiVersion');
    expect(paths).toContain('remix.modes');
  });

  it('reports an asset that no licence entry covers', async () => {
    const body = await validateManifest({ ...validShape, license: { spdx: 'MIT', assets: [] } });
    expect(body.ok).toBe(false);
    expect(body.issues.some((issue) => issue.message.includes('assets/ui/mark.svg'))).toBe(true);
  });

  it('reports an unparsable manifest rather than throwing', async () => {
    const broken = await env.createGame(env.alice, { slug: 'projects-notjson' });
    await env.api('PUT', `/api/games/${broken}/draft/files/game.json`, { account: env.alice, ...raw('{ not json') });
    const response = await env.api('POST', `/api/games/${broken}/draft/validate`, { account: env.alice });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; issues: { code: string }[] }>();
    expect(body.ok).toBe(false);
    expect(body.issues[0]?.code).toBe('bad_format');
  });
});

describe('archive import and export', () => {
  function archive(entries: Record<string, string | Uint8Array>): Uint8Array {
    const input: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(entries)) {
      input[path] = typeof content === 'string' ? encoder.encode(content) : content;
    }
    return zipSync(input, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
  }

  async function importInto(target: string, bytes: Uint8Array) {
    return env.api('POST', `/api/games/${target}/draft/import`, {
      account: env.alice,
      ...raw(bytes, 'application/zip'),
    });
  }

  it('imports the allowed entries of an archive', async () => {
    const target = await env.createGame(env.alice, { slug: 'projects-import' });
    const bytes = archive({
      'src/extra.ts': 'export const extra = 1;\n',
      'README.md': '# imported\n',
    });
    const response = await importInto(target, bytes);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ imported: number; skipped: number }>()).toMatchObject({ imported: 2, skipped: 0 });
    const read = await env.api('GET', `/api/games/${target}/draft/files/src/extra.ts`, { account: env.alice });
    expect(read.body).toBe('export const extra = 1;\n');
  });

  it('drops a traversing entry instead of writing outside the project', async () => {
    const target = await env.createGame(env.alice, { slug: 'projects-import-escape' });
    const response = await importInto(
      target,
      archive({ 'src/ok.ts': 'export const ok = 1;\n', '../escape.ts': 'export const escape = 1;\n' }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<{ imported: number; warnings: string[] }>().imported).toBe(1);
    expect((await env.api('GET', `/api/games/${target}/draft/files/src/ok.ts`, { account: env.alice })).statusCode).toBe(200);
  });

  it('refuses an archive whose only entry traverses out of the project', async () => {
    const target = await env.createGame(env.alice, { slug: 'projects-import-only-escape' });
    const response = await importInto(target, archive({ '../escape.ts': 'export const escape = 1;\n' }));
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('refuses an archive larger than the configured limit', async () => {
    const target = await tiny.createGame(tiny.alice, { slug: 'projects-import-huge' });
    // Random hex, so the payload really is that large after compression.
    const payload = randomBytes(6000).toString('hex');
    const bytes = zipSync({ 'src/big.ts': encoder.encode(payload) }, { level: 6 });
    expect(bytes.byteLength).toBeGreaterThan(tiny.config.limits.maxArchiveBytes);
    const response = await tiny.api('POST', `/api/games/${target}/draft/import`, {
      account: tiny.alice,
      ...raw(bytes, 'application/zip'),
    });
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe('payload_too_large');
  });

  it('refuses a payload that is not a zip archive at all', async () => {
    const target = await env.createGame(env.alice, { slug: 'projects-import-notzip' });
    const response = await importInto(target, encoder.encode('this is not a zip'));
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('round-trips a project through export and import', async () => {
    const source = await env.createGame(env.alice, { slug: 'projects-export-src' });
    await env.api('PUT', `/api/games/${source}/draft/files/src/roundtrip.ts`, {
      account: env.alice,
      ...raw('export const roundtrip = true;\n'),
    });

    const exported = await env.api('GET', `/api/games/${source}/draft/export`, { account: env.alice });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toBe('application/zip');
    expect(exported.headers['content-disposition']).toContain('projects-export-src.zip');

    const entries = Object.keys(unzipSync(new Uint8Array(Buffer.from(exported.rawPayload))));
    expect(entries).toContain('game.json');
    expect(entries).toContain('src/roundtrip.ts');

    const target = await env.createGame(env.alice, { slug: 'projects-export-dst' });
    const imported = await importInto(target, new Uint8Array(Buffer.from(exported.rawPayload)));
    expect(imported.statusCode).toBe(200);
    const read = await env.api('GET', `/api/games/${target}/draft/files/src/roundtrip.ts`, { account: env.alice });
    expect(read.body).toBe('export const roundtrip = true;\n');
  });

  it('produces a byte-identical archive for an unchanged tree', async () => {
    const first = await env.api('GET', `/api/games/${gameId}/draft/export`, { account: env.alice });
    const second = await env.api('GET', `/api/games/${gameId}/draft/export`, { account: env.alice });
    expect(Buffer.from(first.rawPayload).equals(Buffer.from(second.rawPayload))).toBe(true);
  });
});

describe('ownership', () => {
  it('404s for another account so drafts cannot be enumerated', async () => {
    for (const request of [
      env.api('GET', `/api/games/${gameId}/draft`, { account: env.bob }),
      env.api('GET', `/api/games/${gameId}/draft/files/game.json`, { account: env.bob }),
      env.api('PUT', `/api/games/${gameId}/draft/files/src/sneaky.ts`, { account: env.bob, ...raw('x') }),
      env.api('DELETE', `/api/games/${gameId}/draft/files/src/marker.ts`, { account: env.bob }),
      env.api('GET', `/api/games/${gameId}/draft/export`, { account: env.bob }),
      env.api('POST', `/api/games/${gameId}/draft/validate`, { account: env.bob }),
    ]) {
      const response = await request;
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('not_found');
    }
  });

  it('401s for an anonymous caller', async () => {
    const response = await env.api('GET', `/api/games/${gameId}/draft`);
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('keeps another account out of the version listing', async () => {
    expect((await env.api('GET', `/api/games/${gameId}/versions`, { account: env.bob })).statusCode).toBe(404);
    expect((await env.api('GET', `/api/games/${gameId}/versions`, { account: env.alice })).statusCode).toBe(200);
  });
});
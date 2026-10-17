/**
 * Moderation: reporting, the admin queue and the audit trail. Admin is a
 * server-side property of the resolved session, never a request flag, so these
 * tests drive it by registering a real account whose email is configured as an
 * administrator.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Comment, GameCard, ModerationReport, Paginated } from '@moydan/core';
import { createEnv, errorCode, raw, type TestEnv } from './harness.ts';

let env: TestEnv;
let admin: TestEnv['alice'];
let parent: string;
let child: string;

beforeAll(async () => {
  env = await createEnv({
    accounts: [
      { handle: 'ada', email: 'ada@test.moydan.local' },
      { handle: 'kai', email: 'kai@test.moydan.local' },
      { handle: 'triage', email: 'moderator@test.moydan.local' },
    ],
    env: { ADMIN_EMAILS: 'moderator@test.moydan.local' },
  });
  // The harness registers `ada` and `kai` first; the third account is the admin.
  admin = await env.login('moderator@test.moydan.local', 'correct-horse-battery-staple');
  expect(admin.role).toBe('admin');

  parent = await env.createGame(env.alice, { slug: 'mod-parent' });
  await env.publish(parent, env.alice);
  const remixed = await env.api('POST', `/api/games/${parent}/remix`, {
    account: env.bob,
    payload: { mode: 'source', slug: 'mod-child' },
  });
  expect(remixed.statusCode).toBe(200);
  child = remixed.json<{ game: { id: string } }>().game.id;
  // A source remix shares the parent's tree, so it needs an edit before the build
  // worker will produce a release of its own.
  const edited = await env.api('PUT', `/api/games/${child}/draft/files/src/child.ts`, {
    account: env.bob,
    ...raw('export const child = true;\n'),
  });
  expect(edited.statusCode).toBe(200);
  await env.publish(child, env.bob);
});

afterAll(async () => {
  await env.close();
});

function fileReport(targetId: string, details = 'looks broken') {
  return env.api('POST', '/api/reports', {
    account: env.bob,
    payload: { targetType: 'game', targetId, reasonCode: 'malware', details },
  });
}

describe('POST /api/reports', () => {
  it('files a report and returns the moderator-facing projection', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-reportable' });
    await env.publish(gameId, env.alice);
    const response = await fileReport(gameId);
    expect(response.statusCode).toBe(200);
    const report = response.json<ModerationReport>();
    expect(report.id).toMatch(/^rpt_/);
    expect(report.targetType).toBe('game');
    expect(report.reasonCode).toBe('malware');
    expect(report.status).toBe('open');
    expect(report.targetLabel).toBe('Bounce Dodge');
    expect(report.reporter?.handle).toBe(env.bob.handle);
    expect(report.resolvedAt).toBeNull();
  });

  it('refuses a second report for the same target from the same account', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-report-twice' });
    await env.publish(gameId, env.alice);
    expect((await fileReport(gameId)).statusCode).toBe(200);
    const again = await fileReport(gameId);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('conflict');
    expect(again.json<{ error: { details: { reportId: string } } }>().error.details.reportId).toMatch(/^rpt_/);
  });

  it('accepts a report from a different account', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-report-others' });
    await env.publish(gameId, env.alice);
    expect((await fileReport(gameId)).statusCode).toBe(200);
    const other = await env.api('POST', '/api/reports', {
      account: admin,
      payload: { targetType: 'game', targetId: gameId, reasonCode: 'broken' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('reports a comment with a truncated label', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-report-comment' });
    await env.publish(gameId, env.alice);
    const comment = await env.api('POST', `/api/games/${gameId}/comments`, {
      account: env.bob,
      payload: { body: 'a very long comment body '.repeat(10) },
    });
    const response = await env.api('POST', '/api/reports', {
      account: env.alice,
      payload: { targetType: 'comment', targetId: comment.json<Comment>().id, reasonCode: 'abuse' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ModerationReport>().targetLabel.length).toBeLessThanOrEqual(60);
  });

  it('404s for a target that does not exist', async () => {
    const response = await env.api('POST', '/api/reports', {
      account: env.bob,
      payload: { targetType: 'game', targetId: 'gam_missing00000000000', reasonCode: 'spam' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown reason code and an unknown target type', async () => {
    for (const payload of [
      { targetType: 'game', targetId: parent, reasonCode: 'because' },
      { targetType: 'planet', targetId: parent, reasonCode: 'spam' },
    ]) {
      const response = await env.api('POST', '/api/reports', { account: env.bob, payload });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }
  });

  it('requires a signed-in reporter', async () => {
    const response = await env.api('POST', '/api/reports', {
      payload: { targetType: 'game', targetId: parent, reasonCode: 'spam' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/admin/reports', () => {
  it('is closed to an ordinary account', async () => {
    for (const account of [env.alice, env.bob]) {
      const response = await env.api('GET', '/api/admin/reports', { account });
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('forbidden');
    }
  });

  it('is closed to an anonymous caller', async () => {
    expect((await env.api('GET', '/api/admin/reports')).statusCode).toBe(401);
  });

  it('lists the open queue for an administrator', async () => {
    const response = await env.api('GET', '/api/admin/reports?status=open', { account: admin });
    expect(response.statusCode).toBe(200);
    const body = response.json<Paginated<ModerationReport>>();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((report) => report.status === 'open')).toBe(true);
  });

  it('filters the queue by status', async () => {
    const response = await env.api('GET', '/api/admin/reports?status=dismissed', { account: admin });
    expect(response.json<Paginated<ModerationReport>>().items).toEqual([]);
  });
});

describe('report resolution', () => {
  it('writes a moderation event when a game is removed', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-removed' });
    await env.publish(gameId, env.alice);
    const reported = await fileReport(gameId);
    const reportId = reported.json<ModerationReport>().id;

    const before = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM moderation_events');
    const response = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'remove-game', reason: 'confirmed malware' } },
    });
    expect(response.statusCode).toBe(200);
    const resolved = response.json<ModerationReport>();
    expect(resolved.status).toBe('actioned');
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolution).toContain('confirmed malware');

    const events = env.db.all<{ action: string; target_id: string; actor_id: string; reason: string }>(
      'SELECT action, target_id, actor_id, reason FROM moderation_events WHERE target_id = ? ORDER BY created_at',
      [gameId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('game.removed');
    expect(events[0]?.actor_id).toBe(admin.id);
    expect(events[0]?.reason).toBe('confirmed malware');
    expect(Number(env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM moderation_events')?.count ?? 0)).toBe(
      Number(before?.count ?? 0) + 1,
    );
  });

  it('hides a removed game from the feed while keeping the lineage intact', async () => {
    // The child is the reported game; the parent stays published.
    const report = await fileReport(child, 'broken rendering');
    const reportId = report.json<ModerationReport>().id;
    expect((await env.api('GET', `/api/feed/foryou?limit=25`)).json<Paginated<GameCard>>().items.map((card) => card.id)).toContain(child);

    const removed = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'remove-game', reason: 'broken rendering' } },
    });
    expect(removed.statusCode).toBe(200);

    const feed = await env.api('GET', '/api/feed/foryou?limit=25');
    expect(feed.json<Paginated<GameCard>>().items.map((card) => card.id)).not.toContain(child);
    // Strangers cannot reach the removed game at all.
    expect((await env.api('GET', `/api/games/${child}`)).statusCode).toBe(404);

    // The remix lineage row and the child's own attribution survive the removal.
    const relation = env.db.get<{ parent_game_id: string; attribution_text: string }>(
      'SELECT parent_game_id, attribution_text FROM remix_relations WHERE child_game_id = ?',
      [child],
    );
    expect(relation?.parent_game_id).toBe(parent);
    expect(relation?.attribution_text).toContain('Bounce Dodge');
    expect(relation?.attribution_text).toContain(env.alice.handle);
  });

  it('refuses to resolve the same report twice', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-twice-resolved' });
    await env.publish(gameId, env.alice);
    const reportId = (await fileReport(gameId)).json<ModerationReport>().id;

    const first = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'dismiss', note: 'looks fine' } },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<ModerationReport>().status).toBe('dismissed');

    const second = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'dismiss' } },
    });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('conflict');
  });

  it('hides a comment and removes it from the visible count', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-hide-comment' });
    await env.publish(gameId, env.alice);
    const comment = await env.api('POST', `/api/games/${gameId}/comments`, {
      account: env.bob,
      payload: { body: 'something to hide' },
    });
    const commentId = comment.json<Comment>().id;
    const reportId = (
      await env.api('POST', '/api/reports', {
        account: env.alice,
        payload: { targetType: 'comment', targetId: commentId, reasonCode: 'abuse' },
      })
    ).json<ModerationReport>().id;

    const response = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'hide-comment', note: 'rude' } },
    });
    expect(response.statusCode).toBe(200);

    const listed = await env.api('GET', `/api/games/${gameId}/comments`);
    expect(listed.json<Paginated<Comment>>().items.map((entry) => entry.id)).not.toContain(commentId);
    const metrics = env.db.get<{ comment_count: number }>('SELECT comment_count FROM game_metrics WHERE game_id = ?', [gameId]);
    expect(Number(metrics?.comment_count ?? -1)).toBe(0);
  });

  it('restores a removed game as a draft', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-restored' });
    await env.publish(gameId, env.alice);
    const removeReport = (await fileReport(gameId)).json<ModerationReport>().id;
    const removed = await env.api('POST', `/api/admin/reports/${removeReport}/resolve`, {
      account: admin,
      payload: { action: { kind: 'remove-game', reason: 'temporary' } },
    });
    expect(removed.statusCode).toBe(200);
    expect((await env.api('GET', `/api/games/${gameId}`, { account: env.alice })).json<GameCard>().status).toBe('removed');

    // A second report is needed: a resolved report can never be resolved again,
    // and a reporter may only file one report per target.
    const appeal = await env.api('POST', '/api/reports', {
      account: admin,
      payload: { targetType: 'game', targetId: gameId, reasonCode: 'other', details: 'appeal' },
    });
    expect(appeal.statusCode).toBe(200);
    const restoreReport = appeal.json<ModerationReport>().id;
    const restored = await env.api('POST', `/api/admin/reports/${restoreReport}/resolve`, {
      account: admin,
      payload: { action: { kind: 'restore-game' } },
    });
    expect(restored.statusCode).toBe(200);

    const card = await env.api('GET', `/api/games/${gameId}`, { account: env.alice });
    expect(card.json<GameCard>().status).toBe('draft');
    // Restored as a draft: it is not public again until it is republished.
    expect((await env.api('GET', `/api/games/${gameId}`)).statusCode).toBe(404);
  });

  it('suspends the creator and drops their sessions', async () => {
    const creator = await env.register({ handle: 'ephemeral', email: 'ephemeral@test.moydan.local' });
    const gameId = await env.createGame(creator, { slug: 'mod-suspended' });
    await env.publish(gameId, creator);
    const reportId = (await fileReport(gameId, 'abuse')).json<ModerationReport>().id;

    const response = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'suspend-creator', reason: 'repeated abuse' } },
    });
    expect(response.statusCode).toBe(200);
    // The suspended creator's cookie no longer resolves.
    expect((await env.api('GET', '/api/me/profile', { account: creator })).statusCode).toBe(401);
    const event = env.db.get<{ action: string }>('SELECT action FROM moderation_events WHERE target_id = ?', [creator.id]);
    expect(event?.action).toBe('user.suspended');
  });

  it('is closed to an ordinary account', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-not-admin' });
    await env.publish(gameId, env.alice);
    const reportId = (await fileReport(gameId)).json<ModerationReport>().id;
    const response = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: env.bob,
      payload: { action: { kind: 'dismiss' } },
    });
    expect(response.statusCode).toBe(403);
  });

  it('404s for a report that does not exist', async () => {
    const response = await env.api('POST', '/api/admin/reports/rpt_missing0000000000/resolve', {
      account: admin,
      payload: { action: { kind: 'dismiss' } },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown moderation action', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'mod-bad-action' });
    await env.publish(gameId, env.alice);
    const reportId = (await fileReport(gameId)).json<ModerationReport>().id;
    const response = await env.api('POST', `/api/admin/reports/${reportId}/resolve`, {
      account: admin,
      payload: { action: { kind: 'nuke-everything' } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });
});

describe('maintenance endpoint', () => {
  it('hides the queue depth from ordinary accounts', async () => {
    expect((await env.api('GET', '/api/meta/maintenance', { account: env.alice })).json<{ openReports: number }>().openReports).toBe(0);
    expect((await env.api('GET', '/api/meta/maintenance', { account: admin })).json<{ openReports: number }>().openReports).toBeGreaterThan(0);
  });
});
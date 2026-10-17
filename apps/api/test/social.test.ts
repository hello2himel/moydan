/**
 * Social interactions: one reaction per account per game, idempotent saves,
 * threaded comments with authorship rules, and a canonical share link.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Comment, GameCard, Paginated } from '@moydan/core';
import { createEnv, errorCode, type TestAccount, type TestEnv } from './harness.ts';

let env: TestEnv;
/** A second environment whose comment budget is deliberately tiny. */
let throttled: TestEnv;
let publishedGame: string;

beforeAll(async () => {
  env = await createEnv({ maxCommentsPerMinute: 1000 });
  throttled = await createEnv({ maxCommentsPerMinute: 2 });
  publishedGame = await env.createGame(env.alice, { slug: 'social-main' });
  await env.publish(publishedGame, env.alice);
});

afterAll(async () => {
  await throttled.close();
  await env.close();
});

async function comment(account: TestAccount, body: string, parentId?: string) {
  const response = await env.api('POST', `/api/games/${publishedGame}/comments`, {
    account,
    payload: { body, ...(parentId ? { parentId } : {}) },
  });
  expect(response.statusCode).toBe(200);
  return response.json<Comment>();
}

describe('reactions', () => {
  it('records one reaction per account per game', async () => {
    const first = await env.api('PUT', `/api/games/${publishedGame}/reaction`, {
      account: env.alice,
      payload: { type: 'love' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ reacted: string; reactions: number }>()).toEqual({ reacted: 'love', reactions: 1 });

    const second = await env.api('PUT', `/api/games/${publishedGame}/reaction`, {
      account: env.alice,
      payload: { type: 'love' },
    });
    expect(second.json<{ reactions: number }>().reactions).toBe(1);
  });

  it('replaces the reaction when the type changes', async () => {
    const changed = await env.api('PUT', `/api/games/${publishedGame}/reaction`, {
      account: env.alice,
      payload: { type: 'fire' },
    });
    expect(changed.json<{ reacted: string; reactions: number }>()).toEqual({ reacted: 'fire', reactions: 1 });
    const rows = env.db.all<{ type: string }>('SELECT type FROM reactions WHERE user_id = ? AND game_id = ?', [
      env.alice.id,
      publishedGame,
    ]);
    expect(rows.map((row) => row.type)).toEqual(['fire']);
  });

  it('counts reactions from several accounts separately', async () => {
    await env.api('PUT', `/api/games/${publishedGame}/reaction`, { account: env.bob, payload: { type: 'wow' } });
    const total = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM reactions WHERE game_id = ?', [
      publishedGame,
    ]);
    expect(Number(total?.count ?? 0)).toBe(2);
  });

  it('removes the reaction and recomputes the counter', async () => {
    const removed = await env.api('DELETE', `/api/games/${publishedGame}/reaction`, { account: env.alice });
    expect(removed.json<{ reacted: null; reactions: number }>()).toEqual({ reacted: null, reactions: 1 });
    const metrics = env.db.get<{ reaction_count: number }>('SELECT reaction_count FROM game_metrics WHERE game_id = ?', [
      publishedGame,
    ]);
    expect(Number(metrics?.reaction_count ?? 0)).toBe(1);
  });

  it('rejects an unknown reaction type', async () => {
    const response = await env.api('PUT', `/api/games/${publishedGame}/reaction`, {
      account: env.alice,
      payload: { type: 'shrug' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('requires a signed-in viewer', async () => {
    const response = await env.api('PUT', `/api/games/${publishedGame}/reaction`, { payload: { type: 'like' } });
    expect(response.statusCode).toBe(401);
  });

  it('hides an unpublished game from a stranger', async () => {
    const draftId = await env.createGame(env.alice, { slug: 'social-draft' });
    const response = await env.api('PUT', `/api/games/${draftId}/reaction`, { account: env.bob, payload: { type: 'like' } });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });
});

describe('saves', () => {
  it('is idempotent and never stores a duplicate row', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-save' });
    await env.publish(gameId, env.alice);

    const first = await env.api('PUT', `/api/games/${gameId}/save`, { account: env.bob });
    expect(first.json<{ saved: boolean; saves: number }>()).toEqual({ saved: true, saves: 1 });

    const second = await env.api('PUT', `/api/games/${gameId}/save`, { account: env.bob });
    expect(second.json<{ saved: boolean; saves: number }>()).toEqual({ saved: true, saves: 1 });

    const rows = env.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM saved_games WHERE user_id = ? AND game_id = ?', [
      env.bob.id,
      gameId,
    ]);
    expect(Number(rows?.count ?? 0)).toBe(1);
  });

  it('removes the save again', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-unsave' });
    await env.publish(gameId, env.alice);
    await env.api('PUT', `/api/games/${gameId}/save`, { account: env.bob });
    const removed = await env.api('DELETE', `/api/games/${gameId}/save`, { account: env.bob });
    expect(removed.json<{ saved: boolean; saves: number }>()).toEqual({ saved: false, saves: 0 });
    const metrics = env.db.get<{ save_count: number }>('SELECT save_count FROM game_metrics WHERE game_id = ?', [gameId]);
    expect(Number(metrics?.save_count ?? 0)).toBe(0);
  });

  it('is idempotent in the other direction too', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-unsave-twice' });
    await env.publish(gameId, env.alice);
    const removed = await env.api('DELETE', `/api/games/${gameId}/save`, { account: env.bob });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ saved: boolean }>().saved).toBe(false);
  });

  it('shows up in the saved collection and in the game card', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-saved-list' });
    await env.publish(gameId, env.alice);
    await env.api('PUT', `/api/games/${gameId}/save`, { account: env.bob });
    const saved = await env.api('GET', '/api/me/saved', { account: env.bob });
    expect(saved.json<Paginated<GameCard>>().items.map((card) => card.id)).toContain(gameId);
    const card = await env.api('GET', `/api/games/${gameId}`, { account: env.bob });
    expect(card.json<GameCard>().viewer.saved).toBe(true);
  });
});

describe('comments', () => {
  it('creates a comment and returns it as the author', async () => {
    const created = await comment(env.alice, 'Instantly playable.');
    expect(created.body).toBe('Instantly playable.');
    expect(created.author.handle).toBe(env.alice.handle);
    expect(created.parentId).toBeNull();
    expect(created.viewerCanEdit).toBe(true);
    expect(created.edited).toBe(false);
  });

  it('rejects an empty or whitespace-only body', async () => {
    for (const body of ['', '   ', '\n\t']) {
      const response = await env.api('POST', `/api/games/${publishedGame}/comments`, {
        account: env.alice,
        payload: { body },
      });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('validation_failed');
    }
  });

  it('rejects a body over the length limit', async () => {
    const response = await env.api('POST', `/api/games/${publishedGame}/comments`, {
      account: env.alice,
      payload: { body: 'x'.repeat(2001) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('threads a one-level reply and counts it on the parent', async () => {
    const parent = await comment(env.alice, 'The bar is too slow.');
    const reply = await comment(env.bob, 'Try the speed parameter.', parent.id);
    expect(reply.parentId).toBe(parent.id);

    const listed = await env.api('GET', `/api/games/${publishedGame}/comments`, { account: env.alice });
    const parentInList = listed.json<Paginated<Comment>>().items.find((entry) => entry.id === parent.id);
    expect(parentInList?.replyCount).toBe(1);
  });

  it('refuses a reply to a reply', async () => {
    const parent = await comment(env.alice, 'Top level again.');
    const reply = await comment(env.bob, 'A reply.', parent.id);
    const nested = await env.api('POST', `/api/games/${publishedGame}/comments`, {
      account: env.alice,
      payload: { body: 'Too deep.', parentId: reply.id },
    });
    expect(nested.statusCode).toBe(400);
    expect(errorCode(nested)).toBe('validation_failed');
  });

  it('lets the author edit their own comment and marks it edited', async () => {
    const created = await comment(env.alice, 'Typo here.');
    const response = await env.api('PATCH', `/api/comments/${created.id}`, {
      account: env.alice,
      payload: { body: 'Fixed now.' },
    });
    expect(response.statusCode).toBe(200);
    const edited = response.json<Comment>();
    expect(edited.body).toBe('Fixed now.');
    expect(edited.edited).toBe(true);
  });

  it('refuses to let another account edit a comment', async () => {
    const created = await comment(env.alice, 'Mine.');
    const response = await env.api('PATCH', `/api/comments/${created.id}`, {
      account: env.bob,
      payload: { body: 'Hijacked.' },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
    const unchanged = env.db.get<{ body: string }>('SELECT body FROM comments WHERE id = ?', [created.id]);
    expect(unchanged?.body).toBe('Mine.');
  });

  it('refuses to let another account delete a comment', async () => {
    const created = await comment(env.alice, 'Still mine.');
    const response = await env.api('DELETE', `/api/comments/${created.id}`, { account: env.bob });
    expect(response.statusCode).toBe(403);
  });

  it('lets the author delete their own comment and blanks the body', async () => {
    const created = await comment(env.alice, 'Delete me.');
    const response = await env.api('DELETE', `/api/comments/${created.id}`, { account: env.alice });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ removed: true }>().removed).toBe(true);

    const row = env.db.get<{ body: string; moderation_state: string }>('SELECT body, moderation_state FROM comments WHERE id = ?', [
      created.id,
    ]);
    expect(row?.moderation_state).toBe('removed');
    // The row survives so the thread structure is not rewritten under readers.
    expect(row?.body).toBe('Delete me.');

    const listed = await env.api('GET', `/api/games/${publishedGame}/comments`);
    const projection = listed.json<Paginated<Comment>>().items.find((entry) => entry.id === created.id);
    expect(projection?.removed).toBe(true);
    expect(projection?.body).toBe('');
  });

  it('refuses to edit a removed comment', async () => {
    const created = await comment(env.alice, 'Gone.');
    await env.api('DELETE', `/api/comments/${created.id}`, { account: env.alice });
    const response = await env.api('PATCH', `/api/comments/${created.id}`, {
      account: env.alice,
      payload: { body: 'Back please.' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
  });

  it('404s for a comment that does not exist', async () => {
    const response = await env.api('PATCH', '/api/comments/cmt_missing0000000000000', {
      account: env.alice,
      payload: { body: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('paginates without repeating or skipping a comment', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-comment-page' });
    await env.publish(gameId, env.alice);
    for (let index = 0; index < 5; index += 1) {
      await env.api('POST', `/api/games/${gameId}/comments`, {
        account: env.alice,
        payload: { body: `comment ${index}` },
      });
    }

    const everything = await env.api('GET', `/api/games/${gameId}/comments?limit=50`);
    const expected = everything.json<Paginated<Comment>>().items.map((entry) => entry.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await env.api('GET', `/api/games/${gameId}/comments${query}`);
      expect(page.statusCode).toBe(200);
      const body = page.json<Paginated<Comment>>();
      seen.push(...body.items.map((entry) => entry.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it('lists only top-level comments unless a parent is requested', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'social-thread-filter' });
    await env.publish(gameId, env.alice);
    const parent = await env.api('POST', `/api/games/${gameId}/comments`, {
      account: env.alice,
      payload: { body: 'parent' },
    });
    const parentId = parent.json<Comment>().id;
    await env.api('POST', `/api/games/${gameId}/comments`, { account: env.bob, payload: { body: 'child', parentId } });

    const top = await env.api('GET', `/api/games/${gameId}/comments`);
    expect(top.json<Paginated<Comment>>().items.map((entry) => entry.id)).toEqual([parentId]);

    const children = await env.api('GET', `/api/games/${gameId}/comments?parentId=${parentId}`);
    expect(children.json<Paginated<Comment>>().items.map((entry) => entry.body)).toEqual(['child']);
  });

  it('rate-limits a burst of comments', async () => {
    const gameId = await throttled.createGame(throttled.alice, { slug: 'social-rate-limit' });
    await throttled.publish(gameId, throttled.alice);
    for (let index = 0; index < 2; index += 1) {
      const allowed = await throttled.api('POST', `/api/games/${gameId}/comments`, {
        account: throttled.bob,
        payload: { body: `burst ${index}` },
      });
      expect(allowed.statusCode).toBe(200);
    }
    const blocked = await throttled.api('POST', `/api/games/${gameId}/comments`, {
      account: throttled.bob,
      payload: { body: 'one too many' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('rate_limited');
    expect(blocked.json<{ error: { details: { limit: number } } }>().error.details.limit).toBe(2);
  });

  it('requires a signed-in viewer to comment', async () => {
    const response = await env.api('POST', `/api/games/${publishedGame}/comments`, { payload: { body: 'anon' } });
    expect(response.statusCode).toBe(401);
  });
});

describe('share', () => {
  it('returns the canonical application URL for the game', async () => {
    const response = await env.api('POST', `/api/games/${publishedGame}/share`, { account: env.alice });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ url: string; title: string }>()).toEqual({
      url: `${env.config.appOrigin}/games/${publishedGame}`,
      title: 'Bounce Dodge',
    });
  });

  it('is stable across repeated calls', async () => {
    const first = await env.api('POST', `/api/games/${publishedGame}/share`, { account: env.bob });
    const second = await env.api('POST', `/api/games/${publishedGame}/share`, { account: env.bob });
    expect(first.json<{ url: string }>().url).toBe(second.json<{ url: string }>().url);
  });

  it('requires a signed-in viewer, so a draft cannot be probed by id', async () => {
    const draftId = await env.createGame(env.alice, { slug: 'social-share-draft' });
    const anonymous = await env.api('POST', `/api/games/${draftId}/share`);
    expect(anonymous.statusCode).toBe(401);
    const stranger = await env.api('POST', `/api/games/${draftId}/share`, { account: env.bob });
    expect(stranger.statusCode).toBe(404);
  });
});
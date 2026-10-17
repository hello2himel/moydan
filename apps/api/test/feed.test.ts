/**
 * Feeds. The contract is narrow and important: only published games reach the
 * feed, the viewer state is per-account, and cursor pagination walks the result
 * set exactly once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameCard, Paginated, PublicProfile } from '@moydan/core';
import { createEnv, errorCode, gameItems, type TestEnv } from './harness.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await createEnv();
});

afterAll(async () => {
  await env.close();
});

async function forYou(account: TestEnv['alice'] | null, query = ''): Promise<Paginated<GameCard>> {
  const response = await env.api('GET', `/api/feed/foryou${query}`, account ? { account } : {});
  expect(response.statusCode).toBe(200);
  return response.json<Paginated<GameCard>>();
}

describe('GET /api/feed/foryou', () => {
  it('lists published games for an anonymous visitor', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'feed-anon' });
    await env.publish(gameId, env.alice);
    const feed = await forYou(null);
    expect(feed.items.map((card) => card.id)).toContain(gameId);
    expect(feed.items[0]?.status).toBe('published');
  });

  it('never exposes a draft, not even to its owner', async () => {
    const draftId = await env.createGame(env.alice, { slug: 'feed-draft' });
    const feed = await forYou(env.alice);
    expect(feed.items.map((card) => card.id)).not.toContain(draftId);
    const asOwner = await env.api('GET', `/api/games/${draftId}`, { account: env.alice });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json<GameCard>().status).toBe('draft');
  });

  it('drops a game from the feed once it is unpublished', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'feed-unpublish' });
    await env.publish(gameId, env.bob);
    expect((await forYou(null)).items.map((card) => card.id)).toContain(gameId);

    const unpublish = await env.api('POST', `/api/games/${gameId}/unpublish`, { account: env.bob });
    expect(unpublish.statusCode).toBe(200);

    expect((await forYou(null)).items.map((card) => card.id)).not.toContain(gameId);
    const stranger = await env.api('GET', `/api/games/${gameId}`);
    expect(stranger.statusCode).toBe(404);
  });

  it('reports the viewer state of the requesting account only', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'feed-viewer' });
    await env.publish(gameId, env.alice);
    await env.api('PUT', `/api/games/${gameId}/reaction`, { account: env.bob, payload: { type: 'fire' } });
    await env.api('PUT', `/api/games/${gameId}/save`, { account: env.bob });

    const bobView = (await forYou(env.bob)).items.find((card) => card.id === gameId);
    expect(bobView?.viewer.reacted).toBe('fire');
    expect(bobView?.viewer.saved).toBe(true);

    const aliceView = (await forYou(env.alice)).items.find((card) => card.id === gameId);
    expect(aliceView?.viewer.reacted).toBeNull();
    expect(aliceView?.viewer.saved).toBe(false);
  });

  it('never records an impression for an anonymous scroll', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'feed-impressions' });
    await env.publish(gameId, env.bob);
    await forYou(null);
    const rows = env.db.all<{ user_id: string | null }>('SELECT user_id FROM feed_impressions WHERE game_id = ?', [gameId]);
    expect(rows).toEqual([]);
  });

  it('records an impression for a signed-in viewer', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'feed-impressions-2' });
    await env.publish(gameId, env.bob);
    await forYou(env.alice);
    const rows = env.db.all<{ user_id: string }>('SELECT user_id FROM feed_impressions WHERE game_id = ? AND feed = ?', [
      gameId,
      'foryou',
    ]);
    expect(rows.map((row) => row.user_id)).toEqual([env.alice.id]);
  });

  it('rejects a limit outside the accepted range', async () => {
    const response = await env.api('GET', '/api/feed/foryou?limit=999');
    expect(response.statusCode).toBe(400);
  });
});

describe('feed pagination', () => {
  // Ranking is engagement-driven, so the fixtures are given clearly separated
  // reaction counts: a one-point gap dwarfs the recency term, which makes the
  // page boundaries deterministic without injecting a clock.
  async function rankedFeed(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, reactions] of [6, 4, 2].entries()) {
      const slug = `${prefix}-${index}`;
      const gameId = await env.createGame(env.alice, { slug });
      await env.publish(gameId, env.alice);
      for (let reaction = 0; reaction < reactions; reaction += 1) {
        const account = await env.register({
          handle: `fan${prefix.replace(/-/g, '')}${index}${reaction}`,
          email: `fan-${prefix}-${index}-${reaction}@test.moydan.local`,
        });
        await env.api('PUT', `/api/games/${gameId}/reaction`, { account, payload: { type: 'like' } });
      }
      ids.push(gameId);
    }
    return ids;
  }

  async function walkAllPages(): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await forYou(null, query);
      seen.push(...page.items.map((card) => card.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages, 'pagination must terminate').toBeLessThan(30);
    } while (cursor);
    return seen;
  }

  it('never skips an item while paging', async () => {
    const ranked = await rankedFeed('walk');
    const seen = await walkAllPages();
    for (const id of ranked) expect(seen, `paging must reach ${id}`).toContain(id);
  });

  it('orders the strongest engagement first', async () => {
    const ranked = await rankedFeed('order');
    const page = await forYou(null, '?limit=25');
    const slice = page.items.map((card) => card.id).filter((id) => ranked.includes(id));
    expect(slice).toEqual(ranked);
  });

  it('serves the whole result set in one page when it fits', async () => {
    const page = await forYou(null, '?limit=25');
    const published = env.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM games WHERE status = 'published'");
    expect(Number(published?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(published?.count ?? 0)).toBeLessThanOrEqual(25);
    expect(page.items).toHaveLength(Number(published?.count ?? 0));
    expect(page.nextCursor).toBeNull();
  });

  it('ignores a cursor minted for a different collection', async () => {
    // A following-feed cursor must not silently page the For You feed.
    const malformed = Buffer.from(
      JSON.stringify({ v: 1, s: 'feed:following', k: ['2026-01-01T00:00:00.000Z', 'gam_x'] }),
    ).toString('base64url');
    const page = await forYou(null, `?limit=2&cursor=${encodeURIComponent(malformed)}`);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('ignores a cursor that is not decodable at all', async () => {
    const page = await forYou(null, '?limit=2&cursor=not-a-real-cursor');
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('never repeats the boundary item when paging with a cursor', async () => {
    // The recency term used to be evaluated against a moving clock, so page 2
    // re-scored every row and the boundary item qualified again. The ranking clock
    // is now quantised and pinned inside the cursor, so a walk is deterministic.
    const first = await env.api('GET', '/api/feed/foryou?limit=2', { account: env.alice });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(page.items.length).toBe(2);
    if (!page.nextCursor) return;

    const second = await env.api(
      'GET',
      `/api/feed/foryou?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
      { account: env.alice },
    );
    expect(second.statusCode).toBe(200);
    const next = second.json<{ items: { id: string }[] }>();
    const firstIds = new Set(page.items.map((item) => item.id));
    for (const item of next.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });
});

describe('GET /api/feed/following', () => {
  it('is empty for a brand-new account', async () => {
    const response = await env.api('GET', '/api/feed/following', { account: env.alice });
    expect(response.statusCode).toBe(200);
    expect(response.json<Paginated<GameCard>>().items).toEqual([]);
  });

  it('requires a signed-in viewer', async () => {
    const response = await env.api('GET', '/api/feed/following');
    expect(response.statusCode).toBe(401);
  });

  it('returns only the games of followed creators', async () => {
    const followed = await env.createGame(env.bob, { slug: 'following-yes' });
    const ignored = await env.createGame(env.alice, { slug: 'following-no' });
    await env.publish(followed, env.bob);
    await env.publish(ignored, env.alice);
    await env.api('POST', `/api/profiles/${env.bob.handle}/follow`, { account: env.alice });

    const feed = await env.api('GET', '/api/feed/following', { account: env.alice });
    const ids = gameItems(feed.json<Paginated<GameCard>>()).map((card) => card.id);
    expect(ids).toContain(followed);
    expect(ids).not.toContain(ignored);
  });

  it('stops returning a creator once the follow is removed', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'following-unfollow' });
    await env.publish(gameId, env.bob);
    await env.api('POST', `/api/profiles/${env.bob.handle}/follow`, { account: env.alice });
    const before = await env.api('GET', '/api/feed/following', { account: env.alice });
    expect(gameItems(before.json<Paginated<GameCard>>()).map((card) => card.id)).toContain(gameId);

    await env.api('DELETE', `/api/profiles/${env.bob.handle}/follow`, { account: env.alice });
    const after = await env.api('GET', '/api/feed/following', { account: env.alice });
    expect(gameItems(after.json<Paginated<GameCard>>()).map((card) => card.id)).not.toContain(gameId);
  });
});

describe('follows', () => {
  it('is idempotent in both directions', async () => {
    const before = await env.api('GET', `/api/profiles/${env.bob.handle}`, { account: env.alice });
    const followersBefore = before.json<PublicProfile>().stats.followers;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await env.api('POST', `/api/profiles/${env.bob.handle}/follow`, { account: env.alice });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ following: boolean }>().following).toBe(true);
    }

    const during = await env.api('GET', `/api/profiles/${env.bob.handle}`, { account: env.alice });
    expect(during.json<PublicProfile>().stats.followers).toBe(followersBefore + 1);
    expect(during.json<PublicProfile>().viewerFollows).toBe(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await env.api('DELETE', `/api/profiles/${env.bob.handle}/follow`, { account: env.alice });
      expect(response.json<{ following: boolean }>().following).toBe(false);
    }
    const after = await env.api('GET', `/api/profiles/${env.bob.handle}`, { account: env.alice });
    expect(after.json<PublicProfile>().stats.followers).toBe(followersBefore);
    expect(after.json<PublicProfile>().viewerFollows).toBe(false);
  });

  it('refuses a self-follow', async () => {
    const response = await env.api('POST', `/api/profiles/${env.alice.handle}/follow`, { account: env.alice });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('404s for a handle nobody holds', async () => {
    const response = await env.api('POST', '/api/profiles/nobody-at-all/follow', { account: env.alice });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/me/saved', () => {
  it('lists exactly the games the viewer saved', async () => {
    const saved = await env.createGame(env.bob, { slug: 'saved-yes' });
    const notSaved = await env.createGame(env.bob, { slug: 'saved-no' });
    await env.publish(saved, env.bob);
    await env.publish(notSaved, env.bob);

    const response = await env.api('GET', '/api/me/saved', { account: env.alice });
    expect(gameItems(response.json<Paginated<GameCard>>())).toEqual([]);

    await env.api('PUT', `/api/games/${saved}/save`, { account: env.alice });
    const after = await env.api('GET', '/api/me/saved', { account: env.alice });
    const ids = gameItems(after.json<Paginated<GameCard>>()).map((card) => card.id);
    expect(ids).toEqual([saved]);
    expect(ids).not.toContain(notSaved);
  });

  it('keeps a saved game listed after the viewer signs in again', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'saved-survives' });
    await env.publish(gameId, env.bob);
    await env.api('PUT', `/api/games/${gameId}/save`, { account: env.alice });

    const again = await env.login(env.alice.email, env.alice.password);
    const response = await env.api('GET', '/api/me/saved', { account: again });
    expect(gameItems(response.json<Paginated<GameCard>>()).map((card) => card.id)).toContain(gameId);
  });

  it('requires a signed-in viewer', async () => {
    expect((await env.api('GET', '/api/me/saved')).statusCode).toBe(401);
  });
});
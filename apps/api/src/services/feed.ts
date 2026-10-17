/**
 * Feeds.
 *
 * The For You ranking is intentionally simple, inspectable and non-personalised
 * beyond "you have already seen this": engagement signals, a recency decay and
 * an impression penalty, all expressed in one SQL query. There is no model, no
 * hidden profile and no ad auction - a deployment can read the ORDER BY and
 * know exactly why a game is on screen.
 */

import { CURSOR_SCOPES, decodeCursor, encodeCursor, type GameCard, type Paginated } from '@moydan/core';
import type { Config } from '../config.ts';
import { nowIso, type Db } from '../db/client.ts';
import { listGameCards, type ReleaseRow } from './catalog.ts';
import type { GameRow } from './projects.ts';

export type FeedName = 'foryou' | 'following' | 'saved';

export interface FeedQuery {
  viewerId: string | null;
  cursor?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 40;

/**
 * The feed queries select `g.*` plus two ranking columns, so a row *is* the game
 * row with extra ordering keys attached.
 */
type RankedGameRow = GameRow & { score: number; published_at: string };

/** Published games with their current release joined in. */
const PUBLISHED_GAMES = `
  FROM games g
  JOIN releases r ON r.id = g.current_release_id AND r.status = 'published'
  LEFT JOIN game_metrics m ON m.game_id = g.id
`;

/**
 * Recency decay is measured against a *quantised* clock, not `julianday('now')`.
 *
 * A cursor is only meaningful if every page of a walk is scored with the same
 * function. With a moving clock the boundary row's score has already drifted by
 * the time page 2 is asked for, so it can be served twice (or skipped). Quantising
 * to five-minute buckets and pinning the bucket inside the cursor makes the whole
 * walk deterministic, at the cost of a score that only refreshes every five
 * minutes - which is well inside the noise for a feed.
 */
const RANK_BUCKET_MS = 300_000;

function rankBucket(nowMs: number): number {
  return Math.floor(nowMs / RANK_BUCKET_MS) * RANK_BUCKET_MS;
}

export function loadForYouFeed(db: Db, config: Config, query: FeedQuery): Paginated<GameCard> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor ?? null, CURSOR_SCOPES.forYouFeed);
  const cursorScore = typeof cursor?.k[0] === 'number' ? (cursor.k[0] as number) : null;
  const cursorPublished = typeof cursor?.k[1] === 'string' ? (cursor.k[1] as string) : null;
  const cursorId = typeof cursor?.k[2] === 'string' ? (cursor.k[2] as string) : null;
  // A walk keeps the bucket it started in, so page N is scored exactly like page 1.
  const cursorBucket = typeof cursor?.k[3] === 'number' ? (cursor.k[3] as number) : null;
  const bucket = cursorBucket ?? rankBucket(Date.now());
  const nowSeconds = Math.floor(bucket / 1000);

  // `julianday(?, 'unixepoch')` is the pinned clock. It is bound once per
  // statement (and twice more for the cursor comparison), in this exact order.
  const scoreExpression = `
    (1.0 * COALESCE(m.reaction_count, 0) + 0.8 * COALESCE(m.save_count, 0) + 0.3 * COALESCE(m.play_count, 0)
     + 0.6 * COALESCE(m.remix_count, 0)
     + 40.0 / (1.0 + MAX(0.0, julianday(?, 'unixepoch') - julianday(COALESCE(g.published_at, g.created_at))))
     - CASE WHEN fi.seen_at IS NULL THEN 0.0
            ELSE 25.0 / (1.0 + MAX(0.0, julianday(?, 'unixepoch') - julianday(fi.seen_at))) END)`;

  const params: (string | number | null)[] = [];
  let sql = `
    SELECT g.*, ${scoreExpression} AS score, COALESCE(g.published_at, g.created_at) AS published_at
    ${PUBLISHED_GAMES}
    LEFT JOIN feed_impressions fi
      ON fi.game_id = g.id AND fi.feed = 'foryou' AND fi.user_id = ?
    WHERE g.status = 'published'`;
  // Placeholders appear in SQL order: the score expression is selected first (two
  // clock bindings), then the impression join's user id.
  params.push(nowSeconds, nowSeconds, query.viewerId);
  if (cursorScore !== null && cursorPublished && cursorId) {
    sql += ` AND (${scoreExpression} < ? OR (${scoreExpression} = ? AND (COALESCE(g.published_at, g.created_at) < ? OR (COALESCE(g.published_at, g.created_at) = ? AND g.id < ?))))`;
    params.push(
      nowSeconds,
      nowSeconds,
      cursorScore,
      nowSeconds,
      nowSeconds,
      cursorScore,
      cursorPublished,
      cursorPublished,
      cursorId,
    );
  }
  sql += ' ORDER BY score DESC, published_at DESC, g.id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.all<RankedGameRow>(sql, params);
  const page = rows.slice(0, limit);
  const cards = listGameCards(
    db,
    config,
    page,
    query.viewerId,
    { publicOnly: true },
  );
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(CURSOR_SCOPES.forYouFeed, [last.score, last.published_at, last.id, bucket])
      : null;
  if (query.viewerId) recordImpressions(db, query.viewerId, 'foryou', cards.map((card) => card.id));
  return { items: cards, nextCursor, total: null };
}

export function loadFollowingFeed(db: Db, config: Config, viewerId: string, query: FeedQuery): Paginated<GameCard> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor ?? null, CURSOR_SCOPES.followingFeed);
  const cursorPublished = typeof cursor?.k[0] === 'string' ? (cursor.k[0] as string) : null;
  const cursorId = typeof cursor?.k[1] === 'string' ? (cursor.k[1] as string) : null;

  const params: (string | number | null)[] = [viewerId];
  let sql = `
    SELECT g.*, 0 AS score, COALESCE(g.published_at, g.created_at) AS published_at
    ${PUBLISHED_GAMES}
    JOIN follows f ON f.followee_id = g.owner_id AND f.follower_id = ?
    WHERE g.status = 'published'`;
  if (cursorPublished && cursorId) {
    sql += ` AND (COALESCE(g.published_at, g.created_at) < ? OR (COALESCE(g.published_at, g.created_at) = ? AND g.id < ?))`;
    params.push(cursorPublished, cursorPublished, cursorId);
  }
  sql += ' ORDER BY published_at DESC, g.id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.all<RankedGameRow>(sql, params);
  const page = rows.slice(0, limit);
  const cards = listGameCards(
    db,
    config,
    page,
    viewerId,
    { publicOnly: true },
  );
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(CURSOR_SCOPES.followingFeed, [last.published_at, last.id]) : null;
  if (cards.length > 0) recordImpressions(db, viewerId, 'following', cards.map((card) => card.id));
  return { items: cards, nextCursor, total: null };
}

export function loadSavedGames(db: Db, config: Config, viewerId: string, query: FeedQuery): Paginated<GameCard> {
  const limit = clampLimit(query.limit);
  const cursor = decodeCursor(query.cursor ?? null, CURSOR_SCOPES.savedGames);
  const cursorSavedAt = typeof cursor?.k[0] === 'string' ? (cursor.k[0] as string) : null;
  const cursorId = typeof cursor?.k[1] === 'string' ? (cursor.k[1] as string) : null;

  const params: (string | number | null)[] = [viewerId];
  let sql = `
    SELECT g.*, sg.created_at AS saved_at
      FROM saved_games sg
      JOIN games g ON g.id = sg.game_id
     WHERE sg.user_id = ?`;
  if (cursorSavedAt && cursorId) {
    sql += ' AND (sg.created_at < ? OR (sg.created_at = ? AND g.id < ?))';
    params.push(cursorSavedAt, cursorSavedAt, cursorId);
  }
  sql += ' ORDER BY sg.created_at DESC, g.id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.all<GameRow & { saved_at: string }>(sql, params);
  const page = rows.slice(0, limit);
  const cards = listGameCards(db, config, page, viewerId);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(CURSOR_SCOPES.savedGames, [last.saved_at, last.id]) : null;
  return { items: cards, nextCursor, total: null };
}

export function recordImpressions(db: Db, userId: string, feed: FeedName, gameIds: string[]): void {
  if (gameIds.length === 0) return;
  const timestamp = nowIso();
  db.transaction(() => {
    for (const gameId of gameIds) {
      db.run(
        `INSERT INTO feed_impressions (user_id, game_id, feed, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, game_id, feed) DO UPDATE SET seen_at = excluded.seen_at`,
        [userId, gameId, feed, timestamp],
      );
    }
  });
}

/** Public creator profile listing: published first, then drafts for the owner. */
export function listCreatorGames(
  db: Db,
  config: Config,
  creatorId: string,
  viewerId: string | null,
  options: { includeDrafts?: boolean } = {},
): GameCard[] {
  const rows = db.all<GameRow>(
    `SELECT * FROM games WHERE owner_id = ?
      ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, COALESCE(published_at, created_at) DESC LIMIT 100`,
    [creatorId],
  );
  const cards = listGameCards(
    db,
    config,
    rows,
    viewerId,
    { publicOnly: !options.includeDrafts },
  );
  return cards;
}

export function releaseRowById(db: Db, releaseId: string): ReleaseRow | null {
  return db.get<ReleaseRow>('SELECT * FROM releases WHERE id = ?', [releaseId]) ?? null;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

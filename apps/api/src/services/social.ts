/**
 * Social interactions: reactions, saved games and comments.
 *
 * All counters that appear in the feed are maintained in `game_metrics` inside
 * the same transaction as the underlying row, and can always be rebuilt with
 * `npm run metrics` - the counters are a cache, never the source of truth.
 */

import {
  AppError,
  CURSOR_SCOPES,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  truncate,
  type Comment,
  type Limits,
  type Paginated,
} from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';
import { creatorRefFromRow, type AuthenticatedUser } from './identity.ts';
import type { GameRow } from './projects.ts';

export const REACTION_TYPES = ['like', 'love', 'fire', 'wow'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export interface SocialDeps {
  db: Db;
  limits: Limits;
}

// --- Reactions ---------------------------------------------------------------

export function setReaction(
  deps: SocialDeps,
  viewer: AuthenticatedUser,
  game: GameRow,
  type: ReactionType | null,
): { reacted: string | null; reactions: number } {
  const db = deps.db;
  db.transaction(() => {
    if (type === null) {
      db.run('DELETE FROM reactions WHERE user_id = ? AND game_id = ?', [viewer.id, game.id]);
    } else {
      db.run(
        `INSERT INTO reactions (user_id, game_id, type, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, game_id) DO UPDATE SET type = excluded.type, created_at = excluded.created_at`,
        [viewer.id, game.id, type, nowIso()],
      );
    }
    refreshReactionCount(db, game.id);
  });
  const row = db.get<{ type: string }>('SELECT type FROM reactions WHERE user_id = ? AND game_id = ?', [viewer.id, game.id]);
  const count = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM reactions WHERE game_id = ?', [game.id]);
  return { reacted: row?.type ?? null, reactions: Number(count?.count ?? 0) };
}

export function refreshReactionCount(db: Db, gameId: string): void {
  db.run(
    `INSERT INTO game_metrics (game_id, reaction_count, updated_at)
     VALUES (?, (SELECT COUNT(*) FROM reactions WHERE game_id = ?), ?)
     ON CONFLICT(game_id) DO UPDATE SET
       reaction_count = excluded.reaction_count, updated_at = excluded.updated_at`,
    [gameId, gameId, nowIso()],
  );
}

export function refreshCommentCount(db: Db, gameId: string): void {
  db.run(
    `INSERT INTO game_metrics (game_id, comment_count, updated_at)
     VALUES (?, (SELECT COUNT(*) FROM comments WHERE game_id = ? AND moderation_state = 'visible'), ?)
     ON CONFLICT(game_id) DO UPDATE SET comment_count = excluded.comment_count, updated_at = excluded.updated_at`,
    [gameId, gameId, nowIso()],
  );
}

// --- Saved games -------------------------------------------------------------

export function setSaved(
  deps: SocialDeps,
  viewer: AuthenticatedUser,
  game: GameRow,
  saved: boolean,
): { saved: boolean; saves: number } {
  const db = deps.db;
  db.transaction(() => {
    if (saved) {
      db.run(
        `INSERT INTO saved_games (user_id, game_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, game_id) DO NOTHING`,
        [viewer.id, game.id, nowIso()],
      );
    } else {
      db.run('DELETE FROM saved_games WHERE user_id = ? AND game_id = ?', [viewer.id, game.id]);
    }
    refreshSaveCount(db, game.id);
  });
  const count = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM saved_games WHERE game_id = ?', [game.id]);
  const row = db.get<{ game_id: string }>('SELECT game_id FROM saved_games WHERE user_id = ? AND game_id = ?', [
    viewer.id,
    game.id,
  ]);
  return { saved: Boolean(row), saves: Number(count?.count ?? 0) };
}

export function refreshSaveCount(db: Db, gameId: string): void {
  db.run(
    `INSERT INTO game_metrics (game_id, save_count, updated_at)
     VALUES (?, (SELECT COUNT(*) FROM saved_games WHERE game_id = ?), ?)
     ON CONFLICT(game_id) DO UPDATE SET save_count = excluded.save_count, updated_at = excluded.updated_at`,
    [gameId, gameId, nowIso()],
  );
}

// --- Comments ----------------------------------------------------------------

export interface CommentRow {
  id: string;
  game_id: string;
  author_id: string;
  parent_id: string | null;
  body: string;
  moderation_state: 'visible' | 'hidden' | 'removed';
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

function commentAuthor(db: Db, userId: string) {
  const row = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [userId],
  );
  if (!row) return { id: userId, handle: 'deleted', displayName: 'Deleted account', avatarUrl: null };
  return creatorRefFromRow(row);
}

export function toComment(db: Db, row: CommentRow, viewer: AuthenticatedUser | null): Comment {
  const removed = row.moderation_state === 'removed';
  const hidden = row.moderation_state === 'hidden';
  const replies = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM comments WHERE parent_id = ? AND moderation_state = 'visible'",
    [row.id],
  );
  return {
    id: row.id,
    gameId: row.game_id,
    parentId: row.parent_id,
    body: removed ? '' : row.body,
    author: commentAuthor(db, row.author_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.edited_at !== null,
    removed,
    hidden,
    viewerCanEdit: !removed && viewer !== null && (viewer.id === row.author_id || viewer.role === 'admin'),
    viewerCanDelete: !removed && viewer !== null && (viewer.id === row.author_id || viewer.role === 'admin'),
    replyCount: Number(replies?.count ?? 0),
  };
}

export function listComments(
  db: Db,
  gameId: string,
  viewer: AuthenticatedUser | null,
  options: { cursor?: string | null; limit?: number; parentId?: string | null; includeHidden?: boolean } = {},
): Paginated<Comment> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 20)));
  const cursor = decodeCursor(options.cursor ?? null, CURSOR_SCOPES.gameComments);
  const cursorCreatedAt = typeof cursor?.k[0] === 'string' ? (cursor.k[0] as string) : null;
  const cursorId = typeof cursor?.k[1] === 'string' ? (cursor.k[1] as string) : null;

  const params: (string | number | null)[] = [gameId];
  let sql = 'SELECT * FROM comments WHERE game_id = ?';
  if (options.parentId) {
    sql += ' AND parent_id = ?';
    params.push(options.parentId);
  } else {
    sql += ' AND parent_id IS NULL';
  }
  if (!options.includeHidden) sql += " AND moderation_state <> 'hidden'";
  if (cursorCreatedAt && cursorId) {
    sql += ' AND (created_at > ? OR (created_at = ? AND id > ?))';
    params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }
  sql += ' ORDER BY created_at ASC, id ASC LIMIT ?';
  params.push(limit + 1);
  const rows = db.all<CommentRow>(sql, params);
  const page = rows.slice(0, limit);
  const items = page.map((row) => toComment(db, row, viewer));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(CURSOR_SCOPES.gameComments, [last.created_at, last.id]) : null;
  return { items, nextCursor, total: null };
}

export interface CreateCommentInput {
  gameId: string;
  parentId?: string | null;
  body: string;
}

export function createComment(deps: SocialDeps, viewer: AuthenticatedUser, input: CreateCommentInput): Comment {
  const db = deps.db;
  const body = input.body.trim();
  if (body.length === 0) throw errors.validationFailed('Comment must not be empty.', { field: 'body' });
  if (body.length > 2000) throw errors.validationFailed('Comment is too long (2000 characters max).', { field: 'body' });

  const recent = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM comments WHERE author_id = ? AND created_at > ?',
    [viewer.id, new Date(Date.now() - 60_000).toISOString()],
  );
  if (Number(recent?.count ?? 0) >= deps.limits.maxCommentsPerMinute) {
    throw new AppError('rate_limited', 'You are commenting too quickly. Wait a moment and try again.', {
      limit: deps.limits.maxCommentsPerMinute,
      windowSeconds: 60,
    });
  }

  if (input.parentId) {
    const parent = db.get<CommentRow>('SELECT * FROM comments WHERE id = ? AND game_id = ?', [input.parentId, input.gameId]);
    if (!parent || parent.moderation_state !== 'visible') throw errors.notFound('The comment you replied to is gone.');
    if (parent.parent_id) throw errors.validationFailed('Replies are limited to one level.');
  }

  const timestamp = nowIso();
  const row: CommentRow = {
    id: newId('comment'),
    game_id: input.gameId,
    author_id: viewer.id,
    parent_id: input.parentId ?? null,
    body,
    moderation_state: 'visible',
    created_at: timestamp,
    updated_at: timestamp,
    edited_at: null,
    deleted_at: null,
  };
  db.transaction(() => {
    db.run(
      `INSERT INTO comments (id, game_id, author_id, parent_id, body, moderation_state, created_at, updated_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.game_id, row.author_id, row.parent_id, row.body, row.moderation_state, row.created_at, row.updated_at, row.edited_at, row.deleted_at],
    );
    refreshCommentCount(db, input.gameId);
  });
  return toComment(db, row, viewer);
}

export function updateComment(
  deps: SocialDeps,
  viewer: AuthenticatedUser,
  commentId: string,
  body: string,
): Comment {
  const db = deps.db;
  const row = db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', [commentId]);
  if (!row) throw errors.notFound('Comment not found.');
  if (row.author_id !== viewer.id && viewer.role !== 'admin') throw errors.forbidden();
  if (row.moderation_state === 'removed') throw errors.conflict('This comment was deleted.');
  const trimmed = body.trim();
  if (trimmed.length === 0) throw errors.validationFailed('Comment must not be empty.', { field: 'body' });
  if (trimmed.length > 2000) throw errors.validationFailed('Comment is too long (2000 characters max).', { field: 'body' });
  const timestamp = nowIso();
  db.run('UPDATE comments SET body = ?, updated_at = ?, edited_at = ? WHERE id = ?', [trimmed, timestamp, timestamp, commentId]);
  return toComment(db, { ...row, body: trimmed, updated_at: timestamp, edited_at: timestamp }, viewer);
}

export function deleteComment(deps: SocialDeps, viewer: AuthenticatedUser, commentId: string): { removed: true } {
  const db = deps.db;
  const row = db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', [commentId]);
  if (!row) throw errors.notFound('Comment not found.');
  const isOwner = viewer.id === row.author_id;
  if (!isOwner && viewer.role !== 'admin') throw errors.forbidden();
  const timestamp = nowIso();
  db.transaction(() => {
    db.run("UPDATE comments SET moderation_state = 'removed', deleted_at = ?, updated_at = ? WHERE id = ?", [
      timestamp,
      timestamp,
      commentId,
    ]);
    refreshCommentCount(db, row.game_id);
  });
  return { removed: true };
}

export function describeCommentForModeration(db: Db, commentId: string): string {
  const row = db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', [commentId]);
  if (!row) return commentId;
  return truncate(row.body.replace(/\s+/g, ' '), 60);
}

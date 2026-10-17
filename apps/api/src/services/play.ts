/**
 * Play sessions and score submissions.
 *
 * A play session is created when a viewer *starts* a release. The session id is
 * the capability the sandboxed game's host uses for heartbeats and the final
 * report; the game itself never sees it (the host holds it).
 *
 * Scores are explicitly unverified: the platform cannot tell a brilliant player
 * from an edited JavaScript console, so scores are stored as claims
 * (`verified = 0`) and never presented as tamper-proof competition.
 */

import { AppError, newId, safeJsonParse, type Paginated } from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';

export interface PlaySessionRow {
  id: string;
  game_id: string;
  release_id: string;
  user_id: string | null;
  started_at: string;
  first_frame_at: string | null;
  ended_at: string | null;
  outcome: 'completed' | 'abandoned' | 'error' | null;
  error_code: string | null;
}

export interface ScoreRow {
  id: string;
  game_id: string;
  release_id: string;
  user_id: string | null;
  session_id: string;
  value: number;
  unit: string;
  difficulty: string | null;
  duration_ms: number | null;
  meta_json: string;
  verified: number;
  created_at: string;
}

const MAX_SESSIONS_PER_RELEASE_MINUTE = 30;

export function createPlaySession(db: Db, input: { gameId: string; releaseId: string; userId: string | null }): PlaySessionRow {
  const recent = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM play_sessions WHERE started_at > ? AND (user_id IS ? OR user_id = ?)',
    [new Date(Date.now() - 60_000).toISOString(), input.userId, input.userId],
  );
  if (Number(recent?.count ?? 0) > MAX_SESSIONS_PER_RELEASE_MINUTE * 10) {
    throw new AppError('rate_limited', 'Too many play sessions started. Slow down.', {});
  }
  const row: PlaySessionRow = {
    id: newId('session'),
    game_id: input.gameId,
    release_id: input.releaseId,
    user_id: input.userId,
    started_at: nowIso(),
    first_frame_at: null,
    ended_at: null,
    outcome: null,
    error_code: null,
  };
  db.transaction(() => {
    db.run(
      `INSERT INTO play_sessions (id, game_id, release_id, user_id, started_at, first_frame_at, ended_at, outcome, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.game_id, row.release_id, row.user_id, row.started_at, row.first_frame_at, row.ended_at, row.outcome, row.error_code],
    );
    refreshPlayMetrics(db, input.gameId);
  });
  return row;
}

export function findPlaySession(db: Db, sessionId: string): PlaySessionRow | null {
  return db.get<PlaySessionRow>('SELECT * FROM play_sessions WHERE id = ?', [sessionId]) ?? null;
}

export function heartbeatPlaySession(
  db: Db,
  session: PlaySessionRow,
  payload: { frames: number; fps?: number },
): { firstFrame: boolean; ended: boolean } {
  if (session.ended_at) return { firstFrame: false, ended: true };
  if (!session.first_frame_at && payload.frames > 0) {
    const timestamp = nowIso();
    db.run('UPDATE play_sessions SET first_frame_at = ? WHERE id = ? AND first_frame_at IS NULL', [timestamp, session.id]);
    session.first_frame_at = timestamp;
    return { firstFrame: true, ended: false };
  }
  return { firstFrame: false, ended: false };
}

export interface ReportInput {
  outcome: 'completed' | 'abandoned' | 'error';
  errorCode?: string;
  score?: number;
  scoreUnit?: string;
  difficulty?: string;
  durationMs?: number;
  meta?: unknown;
}

export interface ReportResult {
  alreadyReported: boolean;
  outcome: PlaySessionRow['outcome'];
  scoreId: string | null;
  bestScore: number | null;
}

/** Idempotent: a session is finished exactly once, however many times the client retries. */
export function reportPlaySession(db: Db, session: PlaySessionRow, input: ReportInput): ReportResult {
  const existing = findPlaySession(db, session.id);
  if (!existing) throw new Error('play session disappeared');
  if (existing.ended_at) {
    const best = db.get<{ best_score: number | null }>('SELECT best_score FROM game_metrics WHERE game_id = ?', [
      existing.game_id,
    ]);
    return {
      alreadyReported: true,
      outcome: existing.outcome,
      scoreId: null,
      bestScore: best?.best_score ?? null,
    };
  }

  const timestamp = nowIso();
  const durationMs =
    input.durationMs !== undefined && Number.isFinite(input.durationMs)
      ? Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(input.durationMs)))
      : Math.max(0, Date.parse(timestamp) - Date.parse(existing.started_at));
  const metaJson = input.meta === undefined ? '{}' : JSON.stringify(truncateMeta(input.meta));
  const hasScore = typeof input.score === 'number' && Number.isFinite(input.score);

  const scoreId = hasScore ? newId('score') : null;
  db.transaction(() => {
    db.run('UPDATE play_sessions SET ended_at = ?, outcome = ?, error_code = ? WHERE id = ? AND ended_at IS NULL', [
      timestamp,
      input.outcome,
      input.errorCode ?? null,
      existing.id,
    ]);
    if (scoreId) {
      db.run(
        `INSERT INTO game_scores (id, game_id, release_id, user_id, session_id, value, unit, difficulty, duration_ms, meta_json, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          scoreId,
          existing.game_id,
          existing.release_id,
          existing.user_id,
          existing.id,
          input.score,
          (input.scoreUnit ?? 'points').slice(0, 16),
          input.difficulty ? input.difficulty.slice(0, 24) : null,
          durationMs,
          metaJson,
          timestamp,
        ],
      );
    }
    refreshPlayMetrics(db, existing.game_id);
  });

  const best = db.get<{ best_score: number | null }>('SELECT best_score FROM game_metrics WHERE game_id = ?', [
    existing.game_id,
  ]);
  return { alreadyReported: false, outcome: input.outcome, scoreId, bestScore: best?.best_score ?? null };
}

export function refreshPlayMetrics(db: Db, gameId: string): void {
  const row = db.get<{ plays: number; distinct_players: number }>(
    `SELECT COUNT(*) AS plays,
            COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN user_id END) AS distinct_players
       FROM play_sessions WHERE game_id = ?`,
    [gameId],
  );
  const scores = db.get<{ submissions: number; best: number | null }>(
    'SELECT COUNT(*) AS submissions, MAX(value) AS best FROM game_scores WHERE game_id = ?',
    [gameId],
  );
  db.run(
    `INSERT INTO game_metrics (game_id, play_count, score_submissions, best_score, distinct_players, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET
       play_count = excluded.play_count,
       score_submissions = excluded.score_submissions,
       best_score = excluded.best_score,
       distinct_players = excluded.distinct_players,
       updated_at = excluded.updated_at`,
    [
      gameId,
      Number(row?.plays ?? 0),
      Number(scores?.submissions ?? 0),
      scores?.best ?? null,
      Number(row?.distinct_players ?? 0),
      nowIso(),
    ],
  );
}

export interface PublicScore {
  id: string;
  value: number;
  unit: string;
  difficulty: string | null;
  createdAt: string;
  player: { handle: string; displayName: string; avatarUrl: string | null } | null;
  verified: false;
}

export function listScores(db: Db, gameId: string, limit = 10): Paginated<PublicScore> {
  const rows = db.all<ScoreRow & { handle: string | null; display_name: string | null; avatar_url: string | null }>(
    `SELECT s.*, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM game_scores s
       LEFT JOIN profiles p ON p.user_id = s.user_id
      WHERE s.game_id = ?
      ORDER BY s.value DESC, s.created_at ASC LIMIT ?`,
    [gameId, Math.max(1, Math.min(50, limit))],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      value: row.value,
      unit: row.unit,
      difficulty: row.difficulty,
      createdAt: row.created_at,
      player: row.handle ? { handle: row.handle, displayName: row.display_name ?? row.handle, avatarUrl: row.avatar_url } : null,
      verified: false,
    })),
    nextCursor: null,
    total: rows.length,
  };
}

/** Recompute every counter in `game_metrics` from the underlying tables. */
export function rebuildAllMetrics(db: Db): void {
  const gameIds = db.all<{ id: string }>('SELECT id FROM games');
  db.transaction(() => {
    for (const { id } of gameIds) {
      refreshPlayMetrics(db, id);
      db.run(
        `INSERT INTO game_metrics (game_id, reaction_count, comment_count, save_count, remix_count, updated_at)
         VALUES (?, (SELECT COUNT(*) FROM reactions WHERE game_id = ?),
                    (SELECT COUNT(*) FROM comments WHERE game_id = ? AND moderation_state = 'visible'),
                    (SELECT COUNT(*) FROM saved_games WHERE game_id = ?),
                    (SELECT COUNT(*) FROM remix_relations WHERE parent_game_id = ?), ?)
         ON CONFLICT(game_id) DO UPDATE SET
           reaction_count = excluded.reaction_count,
           comment_count = excluded.comment_count,
           save_count = excluded.save_count,
           remix_count = excluded.remix_count,
           updated_at = excluded.updated_at`,
        [id, id, id, id, id, nowIso()],
      );
    }
  });
}

function truncateMeta(meta: unknown): unknown {
  try {
    const text = JSON.stringify(meta);
    if (text === undefined) return {};
    if (text.length <= 1024) return JSON.parse(text);
    const parsed = safeJsonParse<Record<string, unknown>>(text);
    if (parsed && typeof parsed === 'object') {
      return { note: 'metadata exceeded the 1 KiB limit and was dropped' };
    }
    return {};
  } catch {
    return {};
  }
}

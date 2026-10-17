/**
 * Moderation: reports, admin actions and the append-only audit trail.
 *
 * Every privileged action writes a `moderation_events` row and returns the
 * updated target state, so the admin UI never has to guess what happened.
 */

import {
  CURSOR_SCOPES,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  type ModerationReport,
  type Paginated,
} from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';
import { creatorRefFromRow, type AuthenticatedUser } from './identity.ts';
import { refreshCommentCount } from './social.ts';
import type { GameRow } from './projects.ts';

export const REPORT_REASONS = ['spam', 'abuse', 'copyright', 'malware', 'broken', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: 'game' | 'comment' | 'user';
  target_id: string;
  reason_code: ReportReason;
  details: string;
  status: 'open' | 'actioned' | 'dismissed';
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string;
  created_at: string;
}

export interface ReportInput {
  reporterId: string;
  targetType: 'game' | 'comment' | 'user';
  targetId: string;
  reasonCode: ReportReason;
  details?: string;
}

export function createReport(db: Db, input: ReportInput): ReportRow {
  const existing = db.get<ReportRow>(
    'SELECT * FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?',
    [input.reporterId, input.targetType, input.targetId],
  );
  if (existing) {
    throw errors.conflict('You have already reported this. Our moderators have it from here.', {
      reportId: existing.id,
      status: existing.status,
    });
  }
  if (input.targetType === 'game') {
    const game = db.get<{ id: string }>('SELECT id FROM games WHERE id = ?', [input.targetId]);
    if (!game) throw errors.notFound('That game does not exist.');
  }
  if (input.targetType === 'comment') {
    const comment = db.get<{ id: string }>('SELECT id FROM comments WHERE id = ?', [input.targetId]);
    if (!comment) throw errors.notFound('That comment does not exist.');
  }
  if (input.targetType === 'user') {
    const user = db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [input.targetId]);
    if (!user) throw errors.notFound('That account does not exist.');
  }
  const recent = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM reports WHERE reporter_id = ? AND created_at > ?', [
    input.reporterId,
    new Date(Date.now() - 3_600_000).toISOString(),
  ]);
  if (Number(recent?.count ?? 0) >= 20) {
    throw errors.quotaExceeded('You have filed many reports in the last hour. Our moderators are reviewing them.');
  }

  const row: ReportRow = {
    id: newId('report'),
    reporter_id: input.reporterId,
    target_type: input.targetType,
    target_id: input.targetId,
    reason_code: input.reasonCode,
    details: (input.details ?? '').slice(0, 1000),
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    resolution: '',
    created_at: nowIso(),
  };
  db.run(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, reason_code, details, status, resolved_by, resolved_at, resolution, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.reporter_id,
      row.target_type,
      row.target_id,
      row.reason_code,
      row.details,
      row.status,
      row.resolved_by,
      row.resolved_at,
      row.resolution,
      row.created_at,
    ],
  );
  return row;
}

export function reportTargetLabel(db: Db, targetType: ReportRow['target_type'], targetId: string): string {
  if (targetType === 'game') {
    const game = db.get<{ title: string }>('SELECT title FROM games WHERE id = ?', [targetId]);
    return game?.title ?? targetId;
  }
  if (targetType === 'comment') {
    const comment = db.get<{ body: string }>('SELECT body FROM comments WHERE id = ?', [targetId]);
    return comment ? comment.body.replace(/\s+/g, ' ').slice(0, 60) : targetId;
  }
  const user = db.get<{ handle: string }>('SELECT handle FROM profiles WHERE user_id = ?', [targetId]);
  return user ? `@${user.handle}` : targetId;
}

export function toReport(db: Db, row: ReportRow): ModerationReport {
  const reporter = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [row.reporter_id],
  );
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: reportTargetLabel(db, row.target_type, row.target_id),
    reasonCode: row.reason_code,
    details: row.details,
    status: row.status,
    reporter: reporter ? creatorRefFromRow(reporter) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

export function listReports(
  db: Db,
  options: { cursor?: string | null; limit?: number; status?: ReportRow['status'] | 'all' } = {},
): Paginated<ModerationReport> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const cursor = decodeCursor(options.cursor ?? null, CURSOR_SCOPES.reports);
  const cursorCreatedAt = typeof cursor?.k[0] === 'string' ? (cursor.k[0] as string) : null;
  const cursorId = typeof cursor?.k[1] === 'string' ? (cursor.k[1] as string) : null;
  const params: (string | number | null)[] = [];
  let sql = 'SELECT * FROM reports WHERE 1 = 1';
  if (options.status && options.status !== 'all') {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  if (cursorCreatedAt && cursorId) {
    sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.all<ReportRow>(sql, params);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => toReport(db, row)),
    nextCursor: rows.length > limit && last ? encodeCursor(CURSOR_SCOPES.reports, [last.created_at, last.id]) : null,
    total: null,
  };
}

export type ModerationAction =
  | { kind: 'dismiss'; note?: string }
  | { kind: 'remove-game'; reason: string }
  | { kind: 'suspend-creator'; reason: string }
  | { kind: 'hide-comment'; note?: string }
  | { kind: 'restore-game' };

export interface ResolveInput {
  reportId: string;
  action: ModerationAction;
  moderator: AuthenticatedUser;
}

export function resolveReport(db: Db, input: ResolveInput): ModerationReport {
  const report = db.get<ReportRow>('SELECT * FROM reports WHERE id = ?', [input.reportId]);
  if (!report) throw errors.notFound('Report not found.');
  if (report.status !== 'open') throw errors.conflict('This report was already resolved.');
  const timestamp = nowIso();
  const targetType = report.target_type;
  const targetId = report.target_id;

  db.transaction(() => {
    switch (input.action.kind) {
      case 'dismiss': {
        db.run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?', [
          'dismissed',
          input.moderator.id,
          timestamp,
          input.action.note ?? 'No action needed.',
          report.id,
        ]);
        break;
      }
      case 'remove-game': {
        const game = db.get<GameRow>('SELECT * FROM games WHERE id = ?', [targetId]);
        if (!game) throw errors.notFound('The reported game no longer exists.');
        const wasPublished = game.status === 'published';
        db.run(
          "UPDATE games SET status = 'removed', removed_at = ?, removal_reason = ?, current_release_id = NULL, updated_at = ? WHERE id = ?",
          [timestamp, input.action.reason.slice(0, 300), timestamp, game.id],
        );
        if (game.current_release_id) {
          db.run("UPDATE releases SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?", [timestamp, game.current_release_id]);
        }
        logModerationEvent(db, input.moderator.id, wasPublished ? 'game.removed' : 'game.removed_from_draft', 'game', game.id, input.action.reason);
        resolveReportRow(db, report.id, 'actioned', input.moderator.id, timestamp, `Removed: ${input.action.reason}`);
        break;
      }
      case 'restore-game': {
        logModerationEvent(db, input.moderator.id, 'game.restored', 'game', targetId, 'Restored without publication.');
        db.run("UPDATE games SET status = 'draft', removed_at = NULL, removal_reason = NULL, updated_at = ? WHERE id = ?", [
          timestamp,
          targetId,
        ]);
        resolveReportRow(db, report.id, 'actioned', input.moderator.id, timestamp, 'Game restored as a draft.');
        break;
      }
      case 'suspend-creator': {
        const game = db.get<{ owner_id: string }>('SELECT owner_id FROM games WHERE id = ?', [targetId]);
        const userId = targetType === 'user' ? targetId : game?.owner_id;
        if (!userId) throw errors.notFound('Could not determine the account to suspend.');
        db.run("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", [timestamp, userId]);
        db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
        logModerationEvent(db, input.moderator.id, 'user.suspended', 'user', userId, input.action.reason);
        resolveReportRow(db, report.id, 'actioned', input.moderator.id, timestamp, `Suspended: ${input.action.reason}`);
        break;
      }
      case 'hide-comment': {
        db.run("UPDATE comments SET moderation_state = 'hidden', updated_at = ? WHERE id = ?", [timestamp, targetId]);
        const comment = db.get<{ game_id: string }>('SELECT game_id FROM comments WHERE id = ?', [targetId]);
        if (comment) refreshCommentCount(db, comment.game_id);
        logModerationEvent(db, input.moderator.id, 'comment.hidden', 'comment', targetId, input.action.note ?? '');
        resolveReportRow(db, report.id, 'actioned', input.moderator.id, timestamp, input.action.note ?? 'Comment hidden.');
        break;
      }
    }
  });
  const updated = db.get<ReportRow>('SELECT * FROM reports WHERE id = ?', [report.id]);
  return toReport(db, updated ?? report);
}

function resolveReportRow(db: Db, reportId: string, status: ReportRow['status'], moderatorId: string, timestamp: string, resolution: string): void {
  db.run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?', [
    status,
    moderatorId,
    timestamp,
    resolution.slice(0, 300),
    reportId,
  ]);
}

export function logModerationEvent(
  db: Db,
  actorId: string,
  action: string,
  targetType: 'game' | 'comment' | 'user' | 'release' | 'report',
  targetId: string,
  reason: string,
  metadata: Record<string, unknown> = {},
): void {
  db.run(
    `INSERT INTO moderation_events (id, actor_id, action, target_type, target_id, reason, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('moderation'), actorId, action, targetType, targetId, reason.slice(0, 300), JSON.stringify(metadata), nowIso()],
  );
}

export function openReportCount(db: Db): number {
  const row = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'");
  return Number(row?.count ?? 0);
}

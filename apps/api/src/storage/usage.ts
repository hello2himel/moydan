/**
 * Storage accounting and quotas.
 *
 * Usage is *derived* from the database (drafts + immutable versions + releases)
 * rather than from incrementally updated counters: there is no counter to drift,
 * and deletes/GC reconcile automatically. The per-user aggregate is bounded by
 * the account's own file count and is cached in `storage_usage` so quota checks
 * and the storage dashboard are O(1) reads.
 *
 * Deduplication note: a blob shared by two accounts counts once for each account
 * that references it. That is deliberately conservative for quota enforcement
 * (the platform may reclaim those bytes if the account is removed) and is
 * documented in docs/PROJECT-FORMAT.md.
 */

import { errors, formatBytes, type Limits } from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';

export interface UsageSnapshot {
  sourceBytes: number;
  releaseBytes: number;
  previewBytes: number;
  blobCount: number;
  gameCount: number;
}

export interface UsageRow {
  user_id: string;
  source_bytes: number;
  release_bytes: number;
  preview_bytes: number;
  blob_count: number;
  game_count: number;
  updated_at: string;
}

/** Compute current usage for a user directly from the file tables. */
export function computeUsage(db: Db, userId: string): UsageSnapshot {
  const source = db.get<{ bytes: number; blobs: number }>(
    `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS blobs FROM (
       SELECT files.blob_sha, MAX(files.size_bytes) AS size
       FROM (
         SELECT df.blob_sha AS blob_sha, df.size_bytes AS size_bytes, d.game_id AS game_id
         FROM draft_files df JOIN game_drafts d ON d.id = df.draft_id
         UNION ALL
         SELECT vf.blob_sha AS blob_sha, vf.size_bytes AS size_bytes, sv.game_id AS game_id
         FROM version_files vf JOIN source_versions sv ON sv.id = vf.version_id
       ) files
       JOIN games g ON g.id = files.game_id
       WHERE g.owner_id = ?
       GROUP BY files.blob_sha
     )`,
    [userId],
  );

  const release = db.get<{ bytes: number; blobs: number }>(
    `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS blobs FROM (
       SELECT rf.blob_sha AS blob_sha, MAX(rf.size_bytes) AS size
       FROM release_files rf
       JOIN releases r ON r.id = rf.release_id
       JOIN games g ON g.id = r.game_id
       WHERE g.owner_id = ? AND r.status IN ('published', 'ready_for_review')
       GROUP BY rf.blob_sha
     )`,
    [userId],
  );

  const preview = db.get<{ bytes: number; blobs: number }>(
    `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS blobs FROM (
       SELECT rf.blob_sha AS blob_sha, MAX(rf.size_bytes) AS size
       FROM release_files rf
       JOIN releases r ON r.id = rf.release_id
       JOIN games g ON g.id = r.game_id
       WHERE g.owner_id = ? AND r.status = 'failed'
       GROUP BY rf.blob_sha
     )`,
    [userId],
  );

  const games = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM games WHERE owner_id = ?', [userId]);

  return {
    sourceBytes: Number(source?.bytes ?? 0),
    releaseBytes: Number(release?.bytes ?? 0),
    previewBytes: Number(preview?.bytes ?? 0),
    blobCount: Number(source?.blobs ?? 0) + Number(release?.blobs ?? 0) + Number(preview?.blobs ?? 0),
    gameCount: Number(games?.count ?? 0),
  };
}

/** Recompute and cache the per-user aggregate. Cheap enough to call after writes. */
export function refreshUsage(db: Db, userId: string): UsageSnapshot {
  const snapshot = computeUsage(db, userId);
  db.run(
    `INSERT INTO storage_usage (user_id, source_bytes, release_bytes, preview_bytes, blob_count, game_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       source_bytes = excluded.source_bytes,
       release_bytes = excluded.release_bytes,
       preview_bytes = excluded.preview_bytes,
       blob_count = excluded.blob_count,
       game_count = excluded.game_count,
       updated_at = excluded.updated_at`,
    [
      userId,
      snapshot.sourceBytes,
      snapshot.releaseBytes,
      snapshot.previewBytes,
      snapshot.blobCount,
      snapshot.gameCount,
      nowIso(),
    ],
  );
  return snapshot;
}

export function readUsage(db: Db, userId: string): UsageSnapshot {
  const row = db.get<UsageRow>(
    'SELECT user_id, source_bytes, release_bytes, preview_bytes, blob_count, game_count, updated_at FROM storage_usage WHERE user_id = ?',
    [userId],
  );
  if (!row) return refreshUsage(db, userId);
  return {
    sourceBytes: row.source_bytes,
    releaseBytes: row.release_bytes,
    previewBytes: row.preview_bytes,
    blobCount: row.blob_count,
    gameCount: row.game_count,
  };
}

export interface QuotaCheckInput {
  userId: string;
  /** Bytes the operation would add to the *source* bucket. */
  additionalSourceBytes?: number;
  /** Bytes the operation would add to the *release* bucket. */
  additionalReleaseBytes?: number;
  limits: Limits;
}

/**
 * Enforce per-account quotas before doing expensive work. Errors carry the exact
 * limit that was hit so the UI can explain it.
 */
export function assertWithinQuota(db: Db, input: QuotaCheckInput): void {
  const usage = readUsage(db, input.userId);
  const limits = input.limits;
  const nextSource = usage.sourceBytes + (input.additionalSourceBytes ?? 0);
  if (nextSource > limits.quotaUserSourceBytes) {
    throw errors.quotaExceeded(
      `This upload would exceed your source storage quota (${formatBytes(limits.quotaUserSourceBytes)}). Delete an old project or draft to free space.`,
      {
        bucket: 'source',
        limitBytes: limits.quotaUserSourceBytes,
        usedBytes: usage.sourceBytes,
        requestedBytes: input.additionalSourceBytes ?? 0,
      },
    );
  }
  const nextRelease = usage.releaseBytes + (input.additionalReleaseBytes ?? 0);
  if (nextRelease > limits.quotaUserReleaseBytes) {
    throw errors.quotaExceeded(
      `This release would exceed your published storage quota (${formatBytes(limits.quotaUserReleaseBytes)}). Remove an unused published version to free space.`,
      {
        bucket: 'release',
        limitBytes: limits.quotaUserReleaseBytes,
        usedBytes: usage.releaseBytes,
        requestedBytes: input.additionalReleaseBytes ?? 0,
      },
    );
  }
  if (usage.gameCount >= limits.maxGamesPerUser) {
    throw errors.quotaExceeded(`You have reached the maximum of ${limits.maxGamesPerUser} games.`, {
      bucket: 'games',
      limit: limits.maxGamesPerUser,
      used: usage.gameCount,
    });
  }
}

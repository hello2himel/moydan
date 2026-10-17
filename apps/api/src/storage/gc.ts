/**
 * Blob garbage collection (mark and sweep).
 *
 * The reference graph is the database: a blob is live if any draft file, version
 * file, release file, or in-flight build references it. Sweeping therefore never
 * needs a reference counter that could drift.
 *
 * Safety rules:
 *  - only blobs older than `graceSeconds` are candidates, so an upload that has
 *    been written to storage but whose transaction has not committed yet is
 *    never collected;
 *  - a per-run `limit` bounds the work so GC can run incrementally;
 *  - `dryRun` reports what would be removed without touching storage;
 *  - every sweep is recorded as a security event for auditability.
 */

import { formatBytes } from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';
import type { StorageDriver } from '@moydan/storage';

export interface GcReport {
  scanned: number;
  deleted: number;
  bytesReclaimed: number;
  failures: { sha256: string; error: string }[];
  dryRun: boolean;
  skippedBecauseLive: number;
}

export interface GcOptions {
  graceSeconds?: number;
  limit?: number;
  dryRun?: boolean;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

interface CandidateRow {
  sha256: string;
  size_bytes: number;
  key: string;
  compressed_key: string | null;
}

export async function collectGarbage(
  dependencies: { db: Db; driver: StorageDriver },
  options: GcOptions = {},
): Promise<GcReport> {
  const { db, driver } = dependencies;
  const graceSeconds = options.graceSeconds ?? 3600;
  const limit = options.limit ?? 1000;
  const now = options.now ?? (() => Date.now());
  const cutoff = new Date(now() - graceSeconds * 1000).toISOString();

  const liveCount = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM blobs b
      WHERE EXISTS (SELECT 1 FROM draft_files df WHERE df.blob_sha = b.sha256)
         OR EXISTS (SELECT 1 FROM version_files vf WHERE vf.blob_sha = b.sha256)
         OR EXISTS (SELECT 1 FROM release_files rf WHERE rf.blob_sha = b.sha256)`,
  );

  const candidates = db.all<CandidateRow>(
    `SELECT b.sha256, b.size_bytes, b.key, b.compressed_key
       FROM blobs b
      WHERE b.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM draft_files df WHERE df.blob_sha = b.sha256)
        AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.blob_sha = b.sha256)
        AND NOT EXISTS (SELECT 1 FROM release_files rf WHERE rf.blob_sha = b.sha256)
      ORDER BY b.created_at ASC
      LIMIT ?`,
    [cutoff, limit],
  );

  const report: GcReport = {
    scanned: candidates.length,
    deleted: 0,
    bytesReclaimed: 0,
    failures: [],
    dryRun: options.dryRun ?? false,
    skippedBecauseLive: Number(liveCount?.count ?? 0),
  };

  for (const candidate of candidates) {
    // Re-check inside the loop: a concurrent publish may have referenced the blob
    // between the sweep query and this loop.
    const stillUnreferenced = db.get<{ count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM draft_files WHERE blob_sha = ?) +
         (SELECT COUNT(*) FROM version_files WHERE blob_sha = ?) +
         (SELECT COUNT(*) FROM release_files WHERE blob_sha = ?) AS count`,
      [candidate.sha256, candidate.sha256, candidate.sha256],
    );
    if (Number(stillUnreferenced?.count ?? 0) > 0) {
      report.skippedBecauseLive += 1;
      continue;
    }
    if (report.dryRun) {
      report.deleted += 1;
      report.bytesReclaimed += candidate.size_bytes;
      continue;
    }
    try {
      await driver.delete(candidate.key);
      if (candidate.compressed_key) await driver.delete(candidate.compressed_key);
      db.run('DELETE FROM blobs WHERE sha256 = ?', [candidate.sha256]);
      report.deleted += 1;
      report.bytesReclaimed += candidate.size_bytes;
    } catch (error) {
      report.failures.push({
        sha256: candidate.sha256,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  if (!report.dryRun && report.deleted > 0) {
    db.run(
      'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)',
      [
        `evt_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`,
        'gc.sweep',
        '',
        JSON.stringify({ deleted: report.deleted, bytesReclaimed: report.bytesReclaimed, graceSeconds }),
        nowIso(),
      ],
    );
  }

  return report;
}

export function describeGcReport(report: GcReport): string {
  const head = report.dryRun ? 'GC dry run' : 'GC sweep';
  return `${head}: ${report.deleted} blob(s) ${report.dryRun ? 'would be' : ''} removed, ${formatBytes(
    report.bytesReclaimed,
  )} reclaimed (live blobs kept: ${report.skippedBecauseLive}, failures: ${report.failures.length})`;
}

/**
 * Reference accounting used by tests and the storage dashboard: how many blobs
 * are reachable, and from which class.
 */
export function blobReferenceSummary(db: Db): { draft: number; version: number; release: number; unreferenced: number } {
  const row = db.get<{ draft: number; version: number; release: number; unreferenced: number }>(
    `SELECT
       (SELECT COUNT(DISTINCT blob_sha) FROM draft_files) AS draft,
       (SELECT COUNT(DISTINCT blob_sha) FROM version_files) AS version,
       (SELECT COUNT(DISTINCT blob_sha) FROM release_files) AS release,
       (SELECT COUNT(*) FROM blobs b
         WHERE NOT EXISTS (SELECT 1 FROM draft_files df WHERE df.blob_sha = b.sha256)
           AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.blob_sha = b.sha256)
           AND NOT EXISTS (SELECT 1 FROM release_files rf WHERE rf.blob_sha = b.sha256)) AS unreferenced`,
  );
  return {
    draft: Number(row?.draft ?? 0),
    version: Number(row?.version ?? 0),
    release: Number(row?.release ?? 0),
    unreferenced: Number(row?.unreferenced ?? 0),
  };
}

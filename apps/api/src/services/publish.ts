/**
 * Build jobs and releases (server side of the publish pipeline).
 *
 * Flow:
 *   1. `startBuild` validates the draft, freezes it into an immutable source
 *      version, creates a `build_jobs` row plus a `releases` row in the
 *      `building` state. The job is idempotent per (tree hash, toolchain).
 *   2. An isolated worker claims the job over HTTP, fetches the source, bundles
 *      it without ever executing creator code, and streams artifact files back.
 *   3. `finishBuild` verifies the artifact against the database rows (not the
 *      worker's claims), then flips the release to `ready_for_review`.
 *   4. `publishRelease` makes that release the game's public release. Releases
 *      are immutable: changes create a new sequence.
 */

import {
  ARTIFACT_MANIFEST_VERSION,
  BUILD_TOOLCHAIN_ID,
  checkArtifactPath,
  errors,
  formatBytes,
  isCompressible,
  newId,
  randomToken,
  safeJsonParse,
  stableStringify,
  type Limits,
} from '@moydan/core';
import type { Config } from '../config.ts';
import { nowIso, type Db } from '../db/client.ts';
import { sha256Hex } from '../storage/blobs.ts';
import { assertWithinQuota, refreshUsage } from '../storage/usage.ts';
import { hashToken } from '../lib/password.ts';
import {
  computeTreeHash,
  createVersion,
  listDraftFiles,
  manifestOfVersion,
  validateDraft,
  type GameRow,
  type ProjectDeps,
  type SourceVersionRow,
} from './projects.ts';
import { refreshPlayMetrics } from './play.ts';
import type { ArtifactManifest } from './catalog.ts';

export interface BuildJobRow {
  id: string;
  game_id: string;
  version_id: string;
  status: 'queued' | 'building' | 'validation_failed' | 'ready_for_review' | 'published' | 'failed' | 'cancelled';
  idempotency_key: string;
  requested_by: string | null;
  attempts: number;
  worker_id: string | null;
  lease_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  diagnostics_json: string;
  log_text: string;
  release_id: string | null;
  toolchain: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface PublishDeps extends ProjectDeps {
  config: Config;
}

export interface StartBuildResult {
  job: BuildJobRow;
  version: SourceVersionRow;
  releaseId: string;
  reused: boolean;
}

const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 20 * 1024;

export async function startBuild(
  deps: PublishDeps,
  input: { game: GameRow; userId: string; note?: string },
): Promise<StartBuildResult> {
  const db = deps.db;
  const validation = await validateDraft(deps, input.game.id);
  if (!validation.ok || !validation.manifest) {
    throw errors.validationFailed('Fix the reported problems before building a release.', {
      issues: validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }

  const jobsToday = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM build_jobs WHERE requested_by = ? AND created_at > ?',
    [input.userId, new Date(Date.now() - 86_400_000).toISOString()],
  );
  if (Number(jobsToday?.count ?? 0) >= deps.limits.maxBuildJobsPerDay) {
    throw errors.quotaExceeded(`Build limit reached (${deps.limits.maxBuildJobsPerDay} per day). Try again tomorrow.`, {
      limit: deps.limits.maxBuildJobsPerDay,
    });
  }

  const draftFiles = listDraftFiles(db, input.game.id);
  const treeHash = computeTreeHash(draftFiles);
  // The key is scoped to the game *and* the toolchain. Two projects created from
  // the same starter template have an identical tree hash, and a source remix
  // shares every blob with its parent by design, so a tree-only key would hand one
  // game's release to another account.
  const idempotencyKey = sha256Hex(
    new TextEncoder().encode(`${input.game.id}:${treeHash}:${BUILD_TOOLCHAIN_ID}`),
  );
  const existing = db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE idempotency_key = ?', [idempotencyKey]);
  if (existing) {
    const reusable = ['queued', 'building', 'ready_for_review', 'published'].includes(existing.status);
    const version = db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [existing.version_id]);
    if (reusable && version && existing.release_id) {
      return { job: existing, version, releaseId: existing.release_id, reused: true };
    }
    // A previous attempt failed: reset the same job (the tree is unchanged) and
    // discard the incomplete release's file rows. Blobs are reclaimed by GC.
    db.transaction(() => {
      db.run('DELETE FROM release_files WHERE release_id = ?', [existing.release_id]);
      db.run(
        `UPDATE releases SET status = 'building', artifact_manifest_json = '{}', artifact_hash = '',
           total_bytes = 0, first_playable_bytes = 0, file_count = 0, entry_path = 'index.html',
           verified_at = NULL, published_at = NULL, withdrawn_at = NULL WHERE id = ?`,
        [existing.release_id],
      );
      db.run(
        `UPDATE build_jobs SET status = 'queued', attempts = 0, worker_id = NULL, lease_expires_at = NULL,
           error_code = NULL, error_message = NULL, diagnostics_json = '[]', log_text = '',
           started_at = NULL, finished_at = NULL WHERE id = ?`,
        [existing.id],
      );
    });
    return { job: { ...existing, status: 'queued', attempts: 0 }, version: version as SourceVersionRow, releaseId: existing.release_id as string, reused: false };
  }

  const version = await createVersion(deps, {
    gameId: input.game.id,
    createdBy: input.userId,
    kind: 'release',
    note: input.note ?? '',
    remixParams: null,
  });

  assertWithinQuota(db, {
    userId: input.game.owner_id,
    limits: deps.limits,
    additionalReleaseBytes: version.total_bytes,
  });

  const timestamp = nowIso();
  const job: BuildJobRow = {
    id: newId('buildJob'),
    game_id: input.game.id,
    version_id: version.id,
    status: 'queued',
    idempotency_key: idempotencyKey,
    requested_by: input.userId,
    attempts: 0,
    worker_id: null,
    lease_expires_at: null,
    error_code: null,
    error_message: null,
    diagnostics_json: '[]',
    log_text: '',
    release_id: null,
    toolchain: BUILD_TOOLCHAIN_ID,
    created_at: timestamp,
    started_at: null,
    finished_at: null,
  };

  const releaseId = newId('release');
  db.transaction(() => {
    db.run(
      `INSERT INTO build_jobs (id, game_id, version_id, status, idempotency_key, requested_by, attempts, worker_id,
         lease_expires_at, error_code, error_message, diagnostics_json, log_text, release_id, toolchain,
         created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.game_id,
        job.version_id,
        job.status,
        job.idempotency_key,
        job.requested_by,
        job.attempts,
        job.worker_id,
        job.lease_expires_at,
        job.error_code,
        job.error_message,
        job.diagnostics_json,
        job.log_text,
        releaseId,
        job.toolchain,
        job.created_at,
        job.started_at,
        job.finished_at,
      ],
    );
    const nextSequence = db.get<{ sequence: number | null }>(
      'SELECT MAX(sequence) AS sequence FROM releases WHERE game_id = ?',
      [input.game.id],
    );
    const manifest = manifestOfVersion(version);
    db.run(
      `INSERT INTO releases (id, game_id, version_id, sequence, status, manifest_version, artifact_manifest_json,
         artifact_hash, total_bytes, first_playable_bytes, file_count, entry_path, engine_name, engine_version,
         runtime_api_version, spec_json, created_by, created_at, verified_at, published_at, withdrawn_at)
       VALUES (?, ?, ?, ?, 'building', ?, '{}', '', 0, 0, 0, 'index.html', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        releaseId,
        input.game.id,
        version.id,
        Number(nextSequence?.sequence ?? 0) + 1,
        ARTIFACT_MANIFEST_VERSION,
        manifest.engine.name,
        manifest.engine.version,
        manifest.runtime.apiVersion,
        JSON.stringify({
          orientation: manifest.orientation,
          viewport: manifest.viewport,
          input: manifest.input,
          capabilities: manifest.capabilities,
        }),
        input.userId,
        timestamp,
      ],
    );
    db.run('UPDATE build_jobs SET release_id = ? WHERE id = ?', [releaseId, job.id]);
    db.run(
      `INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, '', ?, ?)`,
      [newId('event'), 'build.started', input.userId, JSON.stringify({ gameId: input.game.id, versionId: version.id, toolchain: job.toolchain }), timestamp],
    );
  });

  const stored = db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [job.id]);
  return { job: stored ?? job, version, releaseId, reused: false };
}

export interface ClaimedJob {
  job: BuildJobRow;
  version: SourceVersionRow;
  releaseId: string;
}

/** Claim one queued (or lease-expired) job for a worker. */
export function claimBuildJob(deps: PublishDeps, workerId: string): ClaimedJob | null {
  const db = deps.db;
  const limits = deps.limits;
  const now = nowIso();
  const claimed = db.transaction(() => {
    const candidates = db.all<BuildJobRow>(
      `SELECT * FROM build_jobs
        WHERE status = 'queued' OR (status = 'building' AND (lease_expires_at IS NULL OR lease_expires_at < ?))
        ORDER BY created_at ASC LIMIT 5`,
      [now],
    );
    for (const job of candidates) {
      if (job.attempts >= limits.maxBuildAttempts) {
        db.run(
          `UPDATE build_jobs SET status = 'failed', error_code = 'attempts_exhausted',
             error_message = 'The build failed repeatedly; check the log and try again.',
             finished_at = ? WHERE id = ?`,
          [now, job.id],
        );
        db.run("UPDATE releases SET status = 'failed' WHERE id = ?", [job.release_id]);
        continue;
      }
      const lease = new Date(Date.now() + limits.buildJobLeaseSeconds * 1000).toISOString();
      db.run(
        `UPDATE build_jobs SET status = 'building', worker_id = ?, attempts = attempts + 1,
           lease_expires_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        [workerId, lease, now, job.id],
      );
      const fresh = db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [job.id]);
      if (fresh) return { job: fresh, versionId: fresh.version_id, releaseId: fresh.release_id as string };
    }
    return null;
  });
  if (!claimed) return null;
  const version = db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [claimed.versionId]);
  if (!version) return null;
  return { job: claimed.job, version, releaseId: claimed.releaseId };
}

export function heartbeatBuildJob(deps: PublishDeps, jobId: string, workerId: string): { ok: boolean; leaseSeconds: number } {
  const job = deps.db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [jobId]);
  if (!job || job.status !== 'building' || job.worker_id !== workerId) return { ok: false, leaseSeconds: 0 };
  const lease = new Date(Date.now() + deps.limits.buildJobLeaseSeconds * 1000).toISOString();
  deps.db.run('UPDATE build_jobs SET lease_expires_at = ? WHERE id = ?', [lease, jobId]);
  return { ok: true, leaseSeconds: deps.limits.buildJobLeaseSeconds };
}

function requireLeasedJob(db: Db, jobId: string, workerId: string): { job: BuildJobRow; releaseId: string } {
  const job = db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [jobId]);
  if (!job) throw errors.notFound('Build job not found.');
  if (job.status !== 'building') throw errors.conflict(`Build job is "${job.status}", not "building".`);
  if (job.worker_id !== workerId) throw errors.forbidden('This job is leased to another worker.');
  if (!job.release_id) throw errors.internal('Build job has no release row.');
  return { job, releaseId: job.release_id };
}

export interface AppendArtifactInput {
  path: string;
  content: Uint8Array;
  contentType: string;
  entry?: boolean;
}

export interface AppendArtifactResult {
  sha256: string;
  size: number;
  storedBytes: number;
  encoding: 'br' | null;
}

/**
 * Store one artifact file. Rows are written immediately against the release row
 * so a crash mid-upload leaves recoverable state; `finishBuild` validates the
 * complete set before the release ever becomes visible.
 */
export async function appendArtifact(
  deps: PublishDeps,
  jobId: string,
  workerId: string,
  input: AppendArtifactInput,
): Promise<AppendArtifactResult> {
  const { releaseId } = requireLeasedJob(deps.db, jobId, workerId);
  const problem = checkArtifactPath(input.path);
  if (problem) throw errors.validationFailed(`Artifact path "${input.path}" is not publishable: ${problem.message}`);
  if (input.content.byteLength > deps.limits.maxArtifactBytes) {
    throw errors.payloadTooLarge(`Artifact "${input.path}" is ${formatBytes(input.content.byteLength)}, above the limit.`, {
      path: input.path,
      limitBytes: deps.limits.maxArtifactBytes,
    });
  }
  const count = deps.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM release_files WHERE release_id = ?', [releaseId]);
  if (Number(count?.count ?? 0) >= deps.limits.maxArtifactFiles) {
    throw errors.quotaExceeded(`Artifact file limit reached (${deps.limits.maxArtifactFiles}).`, {
      limit: deps.limits.maxArtifactFiles,
    });
  }
  const compress = isCompressible(input.contentType);
  const ingest = await deps.blobs.ingest(input.content, { class: 'artifact', contentType: input.contentType, compress });
  const encoding = ingest.encodings.find((entry) => entry.encoding === 'br') ?? ingest.encodings[0] ?? null;
  deps.db.transaction(() => {
    deps.db.run(
      `INSERT INTO release_files (id, release_id, path, blob_sha, size_bytes, content_type, encoding, is_entry)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(release_id, path, encoding) DO UPDATE SET blob_sha = excluded.blob_sha, size_bytes = excluded.size_bytes`,
      [newId('blob'), releaseId, input.path, ingest.sha256, input.content.byteLength, input.contentType, input.entry ? 1 : 0],
    );
    if (encoding) {
      deps.db.run(
        `INSERT INTO release_files (id, release_id, path, blob_sha, size_bytes, content_type, encoding, is_entry)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(release_id, path, encoding) DO UPDATE SET blob_sha = excluded.blob_sha, size_bytes = excluded.size_bytes`,
        [newId('blob'), releaseId, input.path, encoding.sha256, encoding.size, input.contentType, encoding.encoding],
      );
    }
  });
  return {
    sha256: ingest.sha256,
    size: input.content.byteLength,
    storedBytes: ingest.size,
    encoding: encoding ? (encoding.encoding as 'br') : null,
  };
}

export interface FinishBuildInput {
  manifest: ArtifactManifest;
  log?: string;
}

export async function finishBuild(deps: PublishDeps, jobId: string, workerId: string, input: FinishBuildInput): Promise<{ releaseId: string }> {
  const { job, releaseId } = requireLeasedJob(deps.db, jobId, workerId);
  const rows = deps.db.all<{ path: string; blob_sha: string; size_bytes: number; content_type: string; encoding: string | null; is_entry: number }>(
    'SELECT path, blob_sha, size_bytes, content_type, encoding, is_entry FROM release_files WHERE release_id = ? AND (encoding IS NULL OR encoding = \'\') ORDER BY path ASC',
    [releaseId],
  );
  if (rows.length === 0) throw errors.validationFailed('The build produced no artifact files.');

  const entryRow = rows.find((row) => row.is_entry === 1);
  if (!entryRow) throw errors.validationFailed('The artifact has no entry document (index.html).');
  const declaredEntry = input.manifest?.entry;
  if (declaredEntry && declaredEntry !== entryRow.path) {
    throw errors.validationFailed(`The build declared entry "${declaredEntry}" but uploaded "${entryRow.path}".`);
  }

  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  // "First playable" is what a player must download before the first frame: the
  // entry document plus the bundles it loads as module scripts. Engine code is
  // inlined into those bundles, so a Phaser game counts here, while optional
  // assets loaded later do not.
  const directoryOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  const entryDirectory = directoryOf(entryRow.path);
  const firstPlayableFiles = rows.filter(
    (row) => row.path === entryRow.path || (row.content_type.startsWith('text/javascript') && directoryOf(row.path) === entryDirectory),
  );
  const firstPlayableBytes = firstPlayableFiles.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  if (totalBytes > deps.limits.maxArtifactBytes) {
    throw errors.payloadTooLarge(`Artifact is ${formatBytes(totalBytes)}; the limit is ${formatBytes(deps.limits.maxArtifactBytes)}.`, {
      limitBytes: deps.limits.maxArtifactBytes,
      actualBytes: totalBytes,
    });
  }
  if (rows.length > deps.limits.maxArtifactFiles) {
    throw errors.quotaExceeded(`Artifact has ${rows.length} files; the limit is ${deps.limits.maxArtifactFiles}.`);
  }
  if (firstPlayableBytes > deps.limits.maxFirstPlayableBytes) {
    throw errors.buildFailed(
      `The first playable payload is ${formatBytes(firstPlayableBytes)} (entry document plus its bundles); the budget is ${formatBytes(deps.limits.maxFirstPlayableBytes)}. Split the game or lazy-load optional assets.`,
      { limitBytes: deps.limits.maxFirstPlayableBytes, actualBytes: firstPlayableBytes },
    );
  }

  const version = deps.db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [job.version_id]);
  if (!version) throw errors.internal('Build job references a missing source version.');
  const manifest = manifestOfVersion(version);

  const canonical = rows.map((row) => ({
    path: row.path,
    size: Number(row.size_bytes),
    contentType: row.content_type,
    sha256: row.blob_sha,
  }));
  const artifactHash = sha256Hex(new TextEncoder().encode(stableStringify(canonical)));
  const artifactManifest: ArtifactManifest = {
    version: ARTIFACT_MANIFEST_VERSION,
    entry: entryRow.path,
    files: canonical.map((file) => ({ path: file.path, size: file.size, contentType: file.contentType, sha256: file.sha256 })),
    totalBytes,
    firstPlayableBytes,
  };

  const timestamp = nowIso();
  const logText = (input.log ?? '').slice(0, MAX_LOG_BYTES);
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE releases SET status = 'ready_for_review', artifact_manifest_json = ?, artifact_hash = ?,
         total_bytes = ?, first_playable_bytes = ?, file_count = ?, entry_path = ?, engine_name = ?,
         engine_version = ?, runtime_api_version = ?, verified_at = ? WHERE id = ?`,
      [
        JSON.stringify(artifactManifest),
        artifactHash,
        totalBytes,
        firstPlayableBytes,
        rows.length,
        entryRow.path,
        manifest.engine.name,
        manifest.engine.version,
        manifest.runtime.apiVersion,
        timestamp,
        releaseId,
      ],
    );
    deps.db.run(
      "UPDATE build_jobs SET status = 'ready_for_review', finished_at = ?, lease_expires_at = NULL, log_text = ? WHERE id = ?",
      [timestamp, logText, jobId],
    );
  });
  if (job.requested_by) refreshUsage(deps.db, job.requested_by);
  return { releaseId };
}

export function failBuild(
  deps: PublishDeps,
  jobId: string,
  workerId: string,
  input: { code: string; message: string; diagnostics?: { code: string; message: string; path?: string }[]; log?: string },
): void {
  const journal = deps.db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [jobId]);
  if (!journal || journal.worker_id !== workerId) throw errors.forbidden('This job is leased to another worker.');
  const timestamp = nowIso();
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE build_jobs SET status = 'failed', error_code = ?, error_message = ?, diagnostics_json = ?,
         log_text = ?, finished_at = ?, lease_expires_at = NULL WHERE id = ?`,
      [
        input.code.slice(0, 64),
        input.message.slice(0, 500),
        JSON.stringify(input.diagnostics ?? []),
        (input.log ?? '').slice(0, MAX_LOG_BYTES),
        timestamp,
        jobId,
      ],
    );
    if (journal.release_id) deps.db.run("UPDATE releases SET status = 'failed' WHERE id = ?", [journal.release_id]);
  });
}

// --- Releases ----------------------------------------------------------------

export function findBuildJob(db: Db, jobId: string): BuildJobRow | null {
  return db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [jobId]) ?? null;
}

export function listBuildJobs(db: Db, gameId: string, limit = 20): BuildJobRow[] {
  return db.all<BuildJobRow>('SELECT * FROM build_jobs WHERE game_id = ? ORDER BY created_at DESC LIMIT ?', [gameId, limit]);
}

export interface ReleaseRowLite {
  id: string;
  game_id: string;
  version_id: string;
  sequence: number;
  status: 'building' | 'ready_for_review' | 'published' | 'failed' | 'withdrawn';
  published_at: string | null;
  created_at: string;
}

export function listReleases(db: Db, gameId: string, limit = 20): ReleaseRowLite[] {
  return db.all<ReleaseRowLite>('SELECT * FROM releases WHERE game_id = ? ORDER BY sequence DESC LIMIT ?', [gameId, limit]);
}

export function getReleaseRow(db: Db, releaseId: string): ReleaseRowLite | null {
  return db.get<ReleaseRowLite>('SELECT * FROM releases WHERE id = ?', [releaseId]) ?? null;
}

export function publishRelease(deps: PublishDeps, input: { game: GameRow; releaseId: string; userId: string }): void {
  const db = deps.db;
  const release = getReleaseRow(db, input.releaseId);
  if (!release || release.game_id !== input.game.id) throw errors.notFound('Release not found.');
  if (release.status !== 'ready_for_review' && release.status !== 'published') {
    throw errors.conflict(`A release in state "${release.status}" cannot be published.`);
  }
  const timestamp = nowIso();
  db.transaction(() => {
    db.run('UPDATE releases SET status = \'published\', published_at = COALESCE(published_at, ?) WHERE id = ?', [
      timestamp,
      release.id,
    ]);
    db.run(
      `UPDATE games SET status = 'published', current_release_id = ?, current_version_id = ?,
         published_at = COALESCE(published_at, ?), removed_at = NULL, removal_reason = NULL, updated_at = ? WHERE id = ?`,
      [release.id, release.version_id, timestamp, timestamp, input.game.id],
    );
    db.run("UPDATE build_jobs SET status = 'published' WHERE release_id = ?", [release.id]);
    if (input.game.is_remix === 1) {
      const relation = db.get<{ parent_game_id: string }>('SELECT parent_game_id FROM remix_relations WHERE child_game_id = ?', [
        input.game.id,
      ]);
      if (relation) {
        db.run(
          `INSERT INTO game_metrics (game_id, remix_count, updated_at)
           VALUES (?, (SELECT COUNT(*) FROM remix_relations WHERE parent_game_id = ?), ?)
           ON CONFLICT(game_id) DO UPDATE SET remix_count = excluded.remix_count, updated_at = excluded.updated_at`,
          [relation.parent_game_id, relation.parent_game_id, timestamp],
        );
      }
    }
    db.run(
      'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        newId('event'),
        'release.published',
        input.userId,
        '',
        JSON.stringify({ gameId: input.game.id, releaseId: release.id, versionId: release.version_id }),
        timestamp,
      ],
    );
  });
}

export function unpublishGame(deps: PublishDeps, input: { game: GameRow; userId: string }): void {
  const timestamp = nowIso();
  deps.db.transaction(() => {
    deps.db.run("UPDATE games SET status = 'unpublished', updated_at = ? WHERE id = ?", [timestamp, input.game.id]);
    deps.db.run(
      'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId('event'), 'game.unpublished', input.userId, '', JSON.stringify({ gameId: input.game.id }), timestamp],
    );
  });
}

export function republishGame(deps: PublishDeps, input: { game: GameRow; userId: string }): void {
  const release = input.game.current_release_id ? getReleaseRow(deps.db, input.game.current_release_id) : null;
  if (!release || release.status !== 'published') {
    throw errors.conflict('There is no previously published release to restore. Build and publish a new one.');
  }
  const timestamp = nowIso();
  deps.db.transaction(() => {
    deps.db.run("UPDATE games SET status = 'published', updated_at = ? WHERE id = ?", [timestamp, input.game.id]);
    deps.db.run(
      'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [newId('event'), 'game.republished', input.userId, '', JSON.stringify({ gameId: input.game.id }), timestamp],
    );
  });
}

export function withdrawRelease(deps: PublishDeps, input: { game: GameRow; releaseId: string; userId: string; reason: string }): void {
  const release = getReleaseRow(deps.db, input.releaseId);
  if (!release || release.game_id !== input.game.id) throw errors.notFound('Release not found.');
  if (release.status === 'withdrawn') return;
  const timestamp = nowIso();
  deps.db.transaction(() => {
    deps.db.run("UPDATE releases SET status = 'withdrawn', withdrawn_at = ? WHERE id = ?", [timestamp, release.id]);
    if (input.game.current_release_id === release.id) {
      deps.db.run("UPDATE games SET status = 'unpublished', current_release_id = NULL, updated_at = ? WHERE id = ?", [
        timestamp,
        input.game.id,
      ]);
    }
    deps.db.run(
      'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        newId('event'),
        'release.withdrawn',
        input.userId,
        '',
        JSON.stringify({ gameId: input.game.id, releaseId: release.id, reason: input.reason.slice(0, 200) }),
        timestamp,
      ],
    );
  });
}

// --- Preview grants ----------------------------------------------------------

export interface PreviewGrant {
  token: string;
  expiresAt: string;
}

export function createPreviewGrant(deps: PublishDeps, input: { game: GameRow; releaseId: string; userId: string }): PreviewGrant {
  const release = getReleaseRow(deps.db, input.releaseId);
  if (!release || release.game_id !== input.game.id) throw errors.notFound('Release not found.');
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  deps.db.run(
    'INSERT INTO preview_grants (id, release_id, game_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId('event'), release.id, input.game.id, input.userId, hashToken(token), nowIso(), expiresAt],
  );
  return { token, expiresAt };
}

export function resolvePreviewGrant(db: Db, releaseId: string, token: string): { gameId: string } | null {
  const row = db.get<{ game_id: string; expires_at: string }>(
    'SELECT game_id, expires_at FROM preview_grants WHERE release_id = ? AND token_hash = ?',
    [releaseId, hashToken(token)],
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { gameId: row.game_id };
}

/** Recompute the derived counters used by the creator dashboard. */
export function refreshGameDashboardMetrics(db: Db, gameId: string): void {
  refreshPlayMetrics(db, gameId);
}

export function parseDiagnostics(raw: string): { code: string; message: string; path?: string }[] {
  const parsed = safeJsonParse<{ code: string; message: string; path?: string }[]>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export function estimateVersionBytes(files: { size_bytes: number }[]): number {
  return files.reduce((sum, file) => sum + file.size_bytes, 0);
}

export function limitsSummary(limits: Limits): Record<string, number> {
  return {
    artifactBytes: limits.maxArtifactBytes,
    artifactFiles: limits.maxArtifactFiles,
    firstPlayableBytes: limits.maxFirstPlayableBytes,
  };
}

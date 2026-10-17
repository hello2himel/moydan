/**
 * Build execution, independent of transport.
 *
 * The same pipeline serves two callers:
 *
 *   1. the long-running worker loop, which claims jobs over the API's internal
 *      HTTP protocol (see `main.ts`);
 *   2. `runLocalBuild`, which runs the whole `startBuild -> build -> finish ->
 *      publish` sequence in-process with a database handle, so seeding, tests and
 *      the CLI can produce a published release without any HTTP server running.
 *
 * Only the *transport* differs. The steps below are the same, in the same order,
 * and they are the platform's correctness boundary:
 *
 *   - the build runs in an isolated child process (never in this process, never
 *     in a request handler) and its workspace is deleted afterwards;
 *   - every artifact byte comes back through the API's `appendArtifact`, which
 *     verifies the digest and stores the blob, so a compromised compile step
 *     cannot make the platform publish bytes it did not hash;
 *   - `finishBuild` re-derives the manifest from the *database rows*, so a
 *     worker that lies about its output still gets a verified artifact;
 *   - any failure is reported through `failBuild` with diagnostics. There is no
 *     path that leaves a release half published: a failed build leaves an
 *     orphan release row in state `failed`, which nothing serves.
 */

import {
  errors,
  newId,
  type GameManifest,
  type Limits,
  type ProjectFileRole,
} from '@moydan/core';
import type { Config } from '../../api/src/config.ts';
import { nowIso, type Db } from '../../api/src/db/client.ts';
import type { BlobStore } from '../../api/src/storage/blobs.ts';
import type { ArtifactManifest } from '../../api/src/services/catalog.ts';
import {
  appendArtifact,
  failBuild,
  finishBuild,
  publishRelease,
  startBuild,
  type BuildJobRow,
  type PublishDeps,
} from '../../api/src/services/publish.ts';
import {
  getGame,
  listVersionFiles,
  manifestOfVersion,
  type SourceVersionRow,
} from '../../api/src/services/projects.ts';
import { runIsolatedBuild } from './isolate.ts';
import { writeReleaseIndex } from './release-index.ts';
import { BuildFailure, failureFromError, formatFailureLog, type FailurePayload } from './failure.ts';

export type { ArtifactManifest };

export interface LocalBuildDeps {
  db: Db;
  blobs: BlobStore;
  limits: Limits;
  config: Config;
}

export interface VersionFileRef {
  path: string;
  blobSha: string;
  size: number;
  contentType: string;
  role: ProjectFileRole;
}

export interface BuildReleaseInput {
  job: BuildJobRow;
  version: SourceVersionRow;
  releaseId: string;
  files: VersionFileRef[];
  manifest: GameManifest;
  /** Workspace *root*: a fresh per-job directory is created inside it. */
  outDir: string;
}

export interface BuildReleaseResult {
  files: Array<{ path: string; content: Uint8Array; contentType: string; entry: boolean }>;
  manifest: ArtifactManifest;
  log: string;
}

/**
 * Compile one immutable source version and return the artifact.
 *
 * Fail closed: a missing blob, an unreadable manifest, a broken import, a
 * missing vendored engine or a blown budget all throw before a single byte is
 * handed to the publish step.
 */
export async function buildRelease(deps: LocalBuildDeps, input: BuildReleaseInput): Promise<BuildReleaseResult> {
  const manifest = input.manifest ?? manifestOfVersion(input.version);
  const entryProblem = entryMustBePresent(manifest, input.files);
  if (entryProblem) throw entryProblem;

  const sourceFiles: Array<{ path: string; content: Uint8Array }> = [];
  const log: string[] = [`build ${input.job.id} release ${input.releaseId} version ${input.version.id}`];
  for (const file of [...input.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const object = await deps.blobs.read(file.blobSha, { verify: true });
    if (!object) {
      throw errors.storageError(`Source file "${file.path}" is missing from object storage.`, { path: file.path });
    }
    if (file.size > 0 && object.body.byteLength !== file.size) {
      throw errors.storageError(`Source file "${file.path}" has an unexpected size.`, {
        path: file.path,
        expectedBytes: file.size,
        actualBytes: object.body.byteLength,
      });
    }
    sourceFiles.push({ path: file.path, content: object.body });
  }
  log.push(`sources ${sourceFiles.length} files`);

  const built = await runIsolatedBuild({
    config: {
      repoRoot: deps.config.repoRoot,
      workspaceRoot: input.outDir,
      toolchainDir: deps.config.build.toolchainDir,
      timeoutMs: deps.config.build.timeoutMs,
      memoryMb: deps.config.build.memoryMb,
      useDocker: deps.config.build.useDocker,
      containerImage: deps.config.build.containerImage,
    },
    jobId: input.job.id,
    releaseId: input.releaseId,
    manifest,
    limits: deps.limits,
    sourceFiles,
  });
  log.push(built.log);
  return { files: built.files, manifest: built.manifest as ArtifactManifest, log: log.join('\n') };
}

function entryMustBePresent(manifest: GameManifest, files: VersionFileRef[]): BuildFailure | null {
  if (!manifest.entry) {
    return new BuildFailure('validation_failed', 'The stored manifest has no entry point.', {
      diagnostics: [{ code: 'entry_missing', message: 'game.json must declare "entry".' }],
    });
  }
  if (!files.some((file) => file.path === manifest.entry)) {
    return new BuildFailure('validation_failed', `The entry point "${manifest.entry}" is not part of this version.`, {
      diagnostics: [{ code: 'entry_missing', message: `"${manifest.entry}" is not in the immutable version.`, path: manifest.entry }],
    });
  }
  return null;
}

/**
 * Build and publish one game end to end, in-process.
 *
 * Intended for seeding, tests and the CLI: it needs a database handle and a
 * blob store but no HTTP server, and it performs the same steps (and the same
 * verifications) as the worker loop.
 */
export async function runLocalBuild(
  deps: LocalBuildDeps,
  input: { gameId: string; userId: string; note?: string },
): Promise<{ releaseId: string; jobId: string }> {
  const publish = publishDepsOf(deps);
  const game = getGame(deps.db, input.gameId);
  const started = await startBuild(publish, { game, userId: input.userId, note: input.note ?? '' });

  if (started.job.status === 'published') {
    return { releaseId: started.releaseId, jobId: started.job.id };
  }
  if (started.job.status === 'ready_for_review') {
    // A previous attempt already produced a verified artifact; only the publish
    // step is missing (the creator pressed "build" again).
    publishRelease(publish, { game, releaseId: started.releaseId, userId: input.userId });
    return { releaseId: started.releaseId, jobId: started.job.id };
  }

  const workerId = localWorkerId();
  const job = claimJobForBuild(publish, workerId, started.job.id);
  const version = deps.db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [job.version_id]);
  if (!version) throw errors.internal('The build job references a missing source version.');
  const files: VersionFileRef[] = listVersionFiles(deps.db, version.id).map((file) => ({
    path: file.path,
    blobSha: file.blob_sha,
    size: file.size_bytes,
    contentType: file.content_type,
    role: file.role,
  }));

  let log = '';
  try {
    const built = await buildRelease(deps, {
      job,
      version,
      releaseId: started.releaseId,
      files,
      manifest: manifestOfVersion(version),
      outDir: deps.config.build.workspaceRoot,
    });
    log = built.log;
    for (const file of built.files) {
      const problem = fileByteBudget(deps.limits, file.content.byteLength, file.path);
      if (problem) throw problem;
      await appendArtifact(publish, job.id, workerId, {
        path: file.path,
        content: file.content,
        contentType: file.contentType,
        entry: file.entry,
      });
    }
    await finishBuild(publish, job.id, workerId, { manifest: built.manifest, log: built.log });
    try {
      await writeReleaseIndex(deps.blobs, started.releaseId, built.manifest);
    } catch (error) {
      // The release is already verified; a missing content index only means the
      // origin cannot serve this release yet. Surface it without losing the build.
      log = `${log}\nwarning: could not write the release index (${error instanceof Error ? error.message : String(error)})`;
    }
    publishRelease(publish, { game, releaseId: started.releaseId, userId: input.userId });
    return { releaseId: started.releaseId, jobId: job.id };
  } catch (error) {
    const payload = failureFromError(error);
    reportFailure(publish, job.id, workerId, payload, log);
    throw error instanceof Error ? error : new BuildFailure(payload.code, payload.message);
  }
}

/**
 * Lease one specific job for this process.
 *
 * Mirrors `claimBuildJob` in the API but is scoped to a job id, because an
 * in-process caller knows exactly which project it asked to build and must not
 * pick up somebody else's queue entry.
 */
export function claimJobForBuild(deps: PublishDeps, workerId: string, jobId: string): BuildJobRow {
  const now = nowIso();
  return deps.db.transaction(() => {
    const job = deps.db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [jobId]);
    if (!job) throw errors.notFound('Build job not found.');
    if (job.status === 'published' || job.status === 'ready_for_review') return job;
    if (job.status === 'failed' || job.status === 'validation_failed' || job.status === 'cancelled') {
      throw errors.conflict(`This build job is "${job.status}" and cannot be retried as-is.`);
    }
    const leaseExpired = job.lease_expires_at === null || Date.parse(job.lease_expires_at) < Date.now();
    if (job.status === 'building' && !leaseExpired && job.worker_id !== workerId) {
      throw errors.conflict('Another worker is already building this project.');
    }
    if (job.attempts >= deps.limits.maxBuildAttempts) {
      throw errors.buildFailed('The build already failed the maximum number of times. Fix the reported problems and build again.');
    }
    const lease = new Date(Date.now() + deps.limits.buildJobLeaseSeconds * 1000).toISOString();
    deps.db.run(
      `UPDATE build_jobs SET status = 'building', worker_id = ?, attempts = attempts + 1,
         lease_expires_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
      [workerId, lease, now, job.id],
    );
    const fresh = deps.db.get<BuildJobRow>('SELECT * FROM build_jobs WHERE id = ?', [job.id]);
    if (!fresh) throw errors.internal('The build job vanished while it was being claimed.');
    return fresh;
  });
}

/** Turn a failure into a `failed` job with diagnostics; never throw. */
export function reportFailure(deps: PublishDeps, jobId: string, workerId: string, payload: FailurePayload, log = ''): void {
  try {
    failBuild(deps, jobId, workerId, {
      code: payload.code,
      message: payload.message,
      diagnostics: payload.diagnostics,
      log: log ? `${log}\n${formatFailureLog(payload)}` : formatFailureLog(payload),
    });
  } catch {
    // The lease was lost (another worker owns it, or the job is already
    // terminal). Reporting must never mask the original failure.
  }
}

function fileByteBudget(limits: Limits, size: number, path: string): BuildFailure | null {
  if (size <= limits.maxArtifactBytes) return null;
  return new BuildFailure('payload_too_large', `Artifact "${path}" is larger than the per-file limit.`, {
    diagnostics: [{ code: 'too_large', message: `${size} bytes exceeds ${limits.maxArtifactBytes} bytes`, path }],
  });
}

export function publishDepsOf(deps: LocalBuildDeps): PublishDeps {
  return {
    db: deps.db,
    blobs: deps.blobs,
    limits: deps.limits,
    repoRoot: deps.config.repoRoot,
    config: deps.config,
  };
}

/** Identity of an in-process builder, distinguishable from a networked worker. */
export function localWorkerId(): string {
  return `local-${newId('buildJob').slice(4)}`;
}

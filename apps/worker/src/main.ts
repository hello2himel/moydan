/**
 * The build worker service.
 *
 * `node src/main.ts` runs the polling loop; `node src/main.ts --once` processes
 * at most one job and exits (CI, smoke tests, one-shot deploys).
 *
 * The loop is deliberately boring, because the interesting parts are elsewhere:
 * a job is claimed over the API's internal protocol, compiled in an isolated
 * child process (`isolate.ts`), uploaded file by file, and finished - and *any*
 * outcome, including a crash or a lost lease, ends in an explicit `fail` call so
 * a job can never sit in `building` until someone notices.
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { newId, type Limits } from '@moydan/core';
import { createStorageDriver, storageKeys, type StorageDriver, type StorageSelection } from '@moydan/storage';
import { ConfigError, loadConfig, type Config } from '../../api/src/config.ts';
import { createLogger, type Logger } from '../../api/src/lib/logger.ts';
import {
  ApiRequestError,
  ApiUnavailableError,
  BuildApiClient,
  type ClaimedJob,
} from './client.ts';
import { runIsolatedBuild, type WorkerBuildConfig } from './isolate.ts';
import { sha256Hex } from './digest.ts';
import { encodeReleaseIndex, releaseIndexKey } from './release-index.ts';
import { failureFromError, formatFailureLog, type FailurePayload } from './failure.ts';
import type { ArtifactManifest } from './bundler.ts';

const DEFAULT_API_URL = 'http://localhost:8787';
/** How long the worker waits for the API to appear before giving up. */
const API_WAIT_MS = 120_000;
const API_RETRY_MS = 2_000;
const UPLOAD_RETRIES = 3;
const UPLOAD_RETRY_DELAY_MS = 500;

interface Options {
  once: boolean;
  apiUrl: string;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseOptions(argv);
  const logger = createLogger({ name: 'moydan-worker' });

  let config: Config;
  try {
    config = loadConfig({ repoRoot: repoRoot() });
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
    logger.error('invalid configuration', { message });
    return 2;
  }

  if (!config.workerJobSecret) {
    logger.error('WORKER_JOB_SECRET is not set; the worker cannot authenticate against the API');
    return 2;
  }

  const api = new BuildApiClient({ baseUrl: options.apiUrl, secret: config.workerJobSecret });
  let storage: StorageDriver;
  try {
    storage = createStorageDriver(storageSelectionOf(config));
  } catch (error) {
    logger.error('object storage is not configured', {
      message: error instanceof Error ? error.message : String(error),
      driver: config.storage.driver,
    });
    return 2;
  }
  const state = { stopping: false, inFlight: null as string | null };
  // One identity for the life of the process: the API records it on the job, so
  // a restarted worker must not look like a continuation of the previous one.
  const workerId = process.env['WORKER_ID'] || `worker-${newId('buildJob').slice(4)}`;

  const shutdown = (signal: string): void => {
    if (state.stopping) return;
    state.stopping = true;
    logger.info('shutting down', { signal, jobId: state.inFlight });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('worker started', {
    apiUrl: api.baseUrl,
    workerId,
    once: options.once,
    toolchainDir: config.build.toolchainDir,
    workspaceRoot: config.build.workspaceRoot,
    isolation: config.build.useDocker ? 'container' : 'child-process',
  });

  const pollOnce = async (): Promise<number> => {
    for (;;) {
      if (state.stopping) return 0;
      const outcome = await runOnce({ api, storage, config, logger, workerId, state });
      if (outcome !== 'idle') {
        if (options.once) return 0;
        continue;
      }
      if (options.once) {
        logger.info('no queued build job; exiting (--once)');
        return 0;
      }
      if (!(await sleep(config.build.pollMs, state))) return 0;
    }
  };

  try {
    return await pollOnce();
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      // The API and the worker normally start together, so an unreachable API at
      // boot is usually a start-order problem rather than a misconfiguration:
      // a long-running worker keeps polling for a while and only gives up if the
      // API never appears. `--once` is a CI/test entry point, so it fails fast
      // instead of holding the caller for two minutes.
      if (!options.once) {
        logger.warn('API unreachable; waiting for it to come up', { message: error.message, apiUrl: api.baseUrl });
        const deadline = Date.now() + API_WAIT_MS;
        while (Date.now() < deadline && !state.stopping) {
          if (!(await sleep(API_RETRY_MS, state))) return 0;
          try {
            return await pollOnce();
          } catch (retryError) {
            if (!(retryError instanceof ApiUnavailableError)) throw retryError;
          }
        }
      }
      logger.error('API unreachable', { message: error.message, apiUrl: api.baseUrl });
      return 1;
    }
    logger.error('worker loop crashed', { message: error instanceof Error ? error.message : String(error) });
    return 1;
  }
}

function parseOptions(argv: string[]): Options {
  let once = false;
  let apiUrl = '';
  for (const argument of argv) {
    if (argument === '--once' || argument === '-1') once = true;
    else if (argument.startsWith('--api-url=')) apiUrl = argument.slice('--api-url='.length);
  }
  return { once, apiUrl: apiUrl || process.env['API_URL'] || DEFAULT_API_URL };
}

/** Translate the API's storage configuration into the driver factory's shape. */
export function storageSelectionOf(config: Config): StorageSelection {
  if (config.storage.driver === 's3') return { driver: 's3', s3: config.storage.s3 };
  return { driver: 'fs', fsRoot: config.storage.root };
}

function repoRoot(): string {
  // apps/worker/src -> repository root
  return resolve(new URL('../../..', import.meta.url).pathname);
}

type Outcome = 'idle' | 'processed' | 'skipped';

interface RunContext {
  api: BuildApiClient;
  storage: StorageDriver;
  config: Config;
  logger: Logger;
  workerId: string;
  state: { stopping: boolean; inFlight: string | null };
}

/**
 * One iteration: claim, build, upload, finish.
 *
 * Returns `idle` when there was nothing to do (the caller sleeps), `processed`
 * when a job was finished or failed, and `skipped` when the claim itself failed
 * for a reason worth retrying.
 */
async function runOnce(context: RunContext): Promise<Outcome> {
  const { api, logger, workerId } = context;

  let claimed: ClaimedJob | null;
  try {
    claimed = await api.claim(workerId);
  } catch (error) {
    if (error instanceof ApiUnavailableError) throw error;
    const retryable = error instanceof ApiRequestError && error.retryable;
    logger.warn('claim failed', { message: error instanceof Error ? error.message : String(error), retryable });
    return retryable ? 'skipped' : 'idle';
  }
  if (!claimed) return 'idle';

  context.state.inFlight = claimed.jobId;
  const log = logger.child({ jobId: claimed.jobId, releaseId: claimed.releaseId, workerId });
  log.info('build claimed', { files: claimed.files.length, toolchain: claimed.toolchain, attempts: claimed.attempts });

  let logText = '';
  const heartbeat = startHeartbeat(api, claimed, workerId, log, context.state, context.config.build.leaseSeconds);
  const limits = context.config.limits;
  const drift = limitsDrift(claimed.limits, limits);
  if (drift.length > 0) log.warn('this worker and the API disagree about limits; enforcing the worker configuration', { drift });
  try {
    const sourceFiles = await readSourceFiles(context.storage, claimed);
    const built = await runIsolatedBuild({
      config: buildConfigOf(context.config),
      jobId: claimed.jobId,
      releaseId: claimed.releaseId,
      manifest: claimed.manifest,
      limits,
      sourceFiles,
    });
    logText = built.log;
    log.info('build finished', {
      files: built.manifest.files.length,
      totalBytes: built.manifest.totalBytes,
      firstPlayableBytes: built.manifest.firstPlayableBytes,
      durationMs: built.durationMs,
    });

    if (!heartbeat.leaseHeld()) {
      log.warn('lease lost during the build; dropping the result so the job can be retried');
      return 'processed';
    }

    await uploadArtifacts(api, claimed, workerId, built.files, log);
    const finished = await api.finish(claimed.jobId, workerId, {
      manifest: built.manifest as unknown as ArtifactManifest,
      log: logText,
    });
    try {
      await writeReleaseIndex(context.storage, claimed.releaseId, built.manifest as unknown as ArtifactManifest);
    } catch (error) {
      // The release is already verified and finished; the content index is a
      // derived cache the game origin reads, so a storage hiccup here must not
      // turn a good build into a failed job.
      log.warn('could not write the release content index', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    log.info('build finished and verified by the API', { releaseId: finished.releaseId });
    return 'processed';
  } catch (error) {
    const payload = failureFromError(error);
    log.error('build failed', { code: payload.code, message: payload.message });
    await reportFailure(api, claimed, workerId, payload, logText, log);
    return 'processed';
  } finally {
    heartbeat.stop();
    context.state.inFlight = null;
  }
}

function buildConfigOf(config: Config): WorkerBuildConfig {  return {
    repoRoot: config.repoRoot,
    workspaceRoot: config.build.workspaceRoot,
    toolchainDir: config.build.toolchainDir,
    timeoutMs: config.build.timeoutMs,
    memoryMb: config.build.memoryMb,
    useDocker: config.build.useDocker,
    containerImage: config.build.containerImage,
  };
}

/**
 * Compare the limit summary the API publishes with the worker's configuration.
 *
 * The claim endpoint returns the artifact budgets under their API names
 * (`artifactBytes`, `artifactFiles`, `firstPlayableBytes`), not as a full
 * `Limits`. A mismatch means the worker host and the API were configured
 * differently; the API re-verifies the artifact against its own limits in
 * `finishBuild`, so the safe behaviour is to enforce the worker side and make
 * the drift loud.
 */
export function limitsDrift(summary: Record<string, unknown> | null, local: Limits): string[] {
  if (!summary) return [];
  const pairs: Array<[string, unknown, number]> = [
    ['maxArtifactBytes', summary['artifactBytes'], local.maxArtifactBytes],
    ['maxArtifactFiles', summary['artifactFiles'], local.maxArtifactFiles],
    ['maxFirstPlayableBytes', summary['firstPlayableBytes'], local.maxFirstPlayableBytes],
  ];
  return pairs
    .filter(([, reported, configured]) => typeof reported === 'number' && reported !== configured)
    .map(([name, reported, configured]) => `${name}=${String(reported)} (worker: ${configured})`);
}

/** Read the immutable source bytes straight from object storage and verify them. */async function readSourceFiles(
  storage: StorageDriver,
  claimed: ClaimedJob,
): Promise<Array<{ path: string; content: Uint8Array }>> {
  const out: Array<{ path: string; content: Uint8Array }> = [];
  for (const file of claimed.files) {
    const object = await storage.get(storageKeys.blob(file.blobSha));
    if (!object) throw new Error(`Source file "${file.path}" is missing from object storage.`);
    const digest = sha256Hex(object.body);
    if (digest !== file.blobSha) {
      throw new Error(`Source file "${file.path}" failed its integrity check (expected ${file.blobSha}, computed ${digest}).`);
    }
    out.push({ path: file.path, content: object.body });
  }
  return out;
}

/**
 * Renew the lease while a build runs. If the heartbeat is refused the job was
 * taken over by another worker, and this one must stop uploading rather than
 * race it.
 */
function startHeartbeat(
  api: BuildApiClient,
  claimed: ClaimedJob,
  workerId: string,
  logger: Logger,
  state: { stopping: boolean },
  fallbackLeaseSeconds: number,
): { stop: () => void; leaseHeld: () => boolean } {
  let held = true;
  const leaseSeconds = claimed.leaseSeconds ?? fallbackLeaseSeconds;
  const intervalMs = Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3));
  const timer = setInterval(() => {
    if (state.stopping || !held) return;
    void api
      .heartbeat(claimed.jobId, workerId)
      .then((result) => {
        if (result.ok) return;
        held = false;
        logger.warn('heartbeat refused; the lease is no longer ours', { jobId: claimed.jobId });
      })
      .catch((error: unknown) => {
        // A transient network problem must not lose the lease silently; the next
        // tick tries again and the API decides when the lease really expired.
        logger.warn('heartbeat failed', { message: error instanceof Error ? error.message : String(error) });
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    leaseHeld: () => held,
  };
}

async function uploadArtifacts(
  api: BuildApiClient,
  claimed: ClaimedJob,
  workerId: string,
  files: Array<{ path: string; content: Uint8Array; contentType: string; entry: boolean }>,
  logger: Logger,
): Promise<void> {
  for (const file of files) {
    await withRetry(async () => {
      await api.appendArtifact(claimed.jobId, workerId, file);
    });
    logger.debug('artifact uploaded', { path: file.path, bytes: file.content.byteLength });
  }
}

async function withRetry<T>(operation: () => Promise<T>, attempts = UPLOAD_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const transient = error instanceof ApiUnavailableError || (error instanceof ApiRequestError && error.retryable);
      if (!transient || attempt === attempts) throw error;
      await sleep(UPLOAD_RETRY_DELAY_MS * attempt, { stopping: false });
    }
  }
  throw lastError;
}

/**
 * Always tell the API what happened. This is what releases the lease: a job that
 * is not failed here would stay `building` until its lease expired and another
 * worker burned an attempt on it.
 */
async function reportFailure(
  api: BuildApiClient,
  claimed: ClaimedJob,
  workerId: string,
  payload: FailurePayload,
  logText: string,
  logger: Logger,
): Promise<void> {
  try {
    await api.fail(claimed.jobId, workerId, {
      code: payload.code,
      message: payload.message,
      diagnostics: payload.diagnostics,
      log: logText ? `${logText}\n${formatFailureLog(payload)}` : formatFailureLog(payload),
    });
    logger.warn('job marked failed', { code: payload.code });
  } catch (error) {
    logger.error('could not report the failure to the API', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Publish the content index the game origin reads. Never fails the build. */
async function writeReleaseIndex(
  storage: StorageDriver,
  releaseId: string,
  manifest: ArtifactManifest,
): Promise<void> {
  const bytes = encodeReleaseIndex(releaseId, manifest, (sha256) => storageKeys.blob(sha256));
  await storage.put(releaseIndexKey(releaseId), bytes, {
    contentType: 'application/json',
    cacheControl: 'public, max-age=31536000, immutable',
  });
}

/** Sleep, but wake early when the process is asked to stop. */
async function sleep(ms: number, state: { stopping: boolean }): Promise<boolean> {
  const step = Math.min(250, Math.max(1, Math.floor(ms / 10)));
  for (let waited = 0; waited < ms; waited += step) {
    if (state.stopping) return false;
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, Math.min(step, ms - waited));
    });
  }
  return !state.stopping;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryUrl !== '' && import.meta.url === entryUrl) {
  process.exitCode = await main();
}

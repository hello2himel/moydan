/**
 * Configurable platform limits.
 *
 * Every limit is expressed as data so that it can be configured per deployment
 * (see `.env.example`), surfaced in validation errors, and asserted in tests.
 * Nothing in the platform hard-codes a magic number: application code reads a
 * `Limits` object.
 */

export interface Limits {
  /** Upload + project structure. */
  maxFileBytes: number;
  maxProjectFiles: number;
  maxSourceBytes: number;
  maxArchiveBytes: number;
  maxArchiveExpandedBytes: number;
  /** Maximum expansion ratio (expanded / compressed) for zip archives. */
  maxArchiveRatio: number;
  maxArchiveEntries: number;
  /** Build inputs/outputs. */
  maxManifestBytes: number;
  maxArtifactBytes: number;
  maxArtifactFiles: number;
  maxFirstPlayableBytes: number;
  /** Build execution. */
  buildTimeoutMs: number;
  buildMemoryMb: number;
  buildJobLeaseSeconds: number;
  maxBuildJobsPerDay: number;
  maxBuildAttempts: number;
  /** Per-account storage accounting. */
  quotaUserSourceBytes: number;
  quotaUserReleaseBytes: number;
  /** Abuse resistance. */
  maxUploadsPerHour: number;
  maxCommentsPerMinute: number;
  maxReportsPerHour: number;
  maxGamesPerUser: number;
  /** Runtime (browser) budgets handed to the game host. */
  runtimeMaxInitMs: number;
  runtimeHeartbeatMs: number;
  runtimeMaxMessageBytes: number;
  runtimeMessagesPerSecond: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 4 * 1024 * 1024,
  maxProjectFiles: 400,
  maxSourceBytes: 20 * 1024 * 1024,
  maxArchiveBytes: 16 * 1024 * 1024,
  maxArchiveExpandedBytes: 64 * 1024 * 1024,
  maxArchiveRatio: 100,
  maxArchiveEntries: 600,
  maxManifestBytes: 256 * 1024,
  maxArtifactBytes: 24 * 1024 * 1024,
  maxArtifactFiles: 400,
  maxFirstPlayableBytes: 4 * 1024 * 1024,
  buildTimeoutMs: 120_000,
  buildMemoryMb: 768,
  buildJobLeaseSeconds: 300,
  maxBuildJobsPerDay: 50,
  maxBuildAttempts: 2,
  quotaUserSourceBytes: 50 * 1024 * 1024,
  quotaUserReleaseBytes: 100 * 1024 * 1024,
  maxUploadsPerHour: 120,
  maxCommentsPerMinute: 8,
  maxReportsPerHour: 20,
  maxGamesPerUser: 50,
  runtimeMaxInitMs: 12_000,
  runtimeHeartbeatMs: 2_000,
  runtimeMaxMessageBytes: 8 * 1024,
  runtimeMessagesPerSecond: 30,
};

export const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS) as (keyof Limits)[];

/** Environment variable name for a limit, e.g. `maxFileBytes` -> `MAX_FILE_BYTES`. */
export function limitEnvName(key: keyof Limits): string {
  return `QUOTA_${key.replace(/[A-Z]/g, (character) => `_${character}`).toUpperCase()}`;
}

const ENV_ALIASES: Partial<Record<keyof Limits, string>> = {
  maxFileBytes: 'MAX_FILE_BYTES',
  maxProjectFiles: 'MAX_PROJECT_FILES',
  maxSourceBytes: 'MAX_SOURCE_BYTES',
  maxArchiveBytes: 'MAX_ARCHIVE_BYTES',
  maxArchiveExpandedBytes: 'MAX_ARCHIVE_EXPANDED_BYTES',
  maxArchiveRatio: 'MAX_ARCHIVE_RATIO',
  maxArtifactBytes: 'MAX_ARTIFACT_BYTES',
  maxFirstPlayableBytes: 'MAX_FIRST_PLAYABLE_BYTES',
  buildTimeoutMs: 'BUILD_TIMEOUT_MS',
  buildMemoryMb: 'BUILD_MEMORY_MB',
  buildJobLeaseSeconds: 'BUILD_JOB_LEASE_SECONDS',
  maxBuildJobsPerDay: 'MAX_BUILD_JOBS_PER_DAY',
  quotaUserSourceBytes: 'QUOTA_USER_SOURCE_BYTES',
  quotaUserReleaseBytes: 'QUOTA_USER_RELEASE_BYTES',
  maxUploadsPerHour: 'MAX_UPLOADS_PER_HOUR',
};

/**
 * Build a `Limits` object from environment variables. Unknown or invalid values
 * fall back to the documented default so a typo can never disable a limit.
 */
export function limitsFromEnv(env: Record<string, string | undefined>, base: Limits = DEFAULT_LIMITS): Limits {
  const out: Limits = { ...base };
  for (const key of LIMIT_KEYS) {
    const envName = ENV_ALIASES[key] ?? limitEnvName(key);
    const raw = env[envName] ?? env[limitEnvName(key)];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) continue;
    (out[key] as number) = parsed;
  }
  return out;
}

/** Human readable byte size, used in error messages and the UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

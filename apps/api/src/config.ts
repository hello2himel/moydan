/**
 * Runtime configuration.
 *
 * Configuration is read from the environment (optionally seeded from `.env`),
 * validated once, and exposed as a frozen object. Production runs *fail fast*
 * when a required value is missing or unsafe (default secrets, game content
 * sharing the application's origin, non-HTTPS origins).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { DEFAULT_LIMITS, limitsFromEnv, type Limits } from '@moydan/core';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  appOrigin: string;
  apiPort: number;
  host: string;
  sessionSecret: string;
  workerJobSecret: string;
  databaseFile: string;
  storage:
    | { driver: 'fs'; root: string }
    | { driver: 's3'; s3: S3Config };
  gameOrigin: string;
  cdnBaseUrl: string | null;
  frameAncestors: string[];
  limits: Limits;
  build: {
    pollMs: number;
    leaseSeconds: number;
    timeoutMs: number;
    memoryMb: number;
    workspaceRoot: string;
    toolchainDir: string;
    useDocker: boolean;
    containerImage: string;
  };
  rateLimits: {
    defaultPerMinute: number;
    authPerMinute: number;
    writePerMinute: number;
    uploadPerMinute: number;
  };
  adminEmails: string[];
  /** Root directory of the repository (used to resolve relative paths). */
  repoRoot: string;
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const DEFAULT_DEV_SECRET = 'dev-only-insecure-session-secret-change-me';
export const DEFAULT_DEV_WORKER_SECRET = 'dev-only-insecure-worker-secret-change-me';

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function absolutize(value: string, repoRoot: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  /** Skip fail-fast checks (used by unit tests). */
  allowUnsafe?: boolean;
}

let cached: Config | null = null;

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? resolve(import.meta.dirname, '..', '..', '..');
  if (!options.env) loadDotEnv(resolve(repoRoot, '.env'));

  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  const nodeEnv = nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

  const storageDriver = (env.STORAGE_DRIVER ?? 'fs').toLowerCase();
  const fsRoot = absolutize(env.STORAGE_FS_ROOT ?? './var/storage', repoRoot);

  let storage: Config['storage'];
  if (storageDriver === 's3') {
    storage = {
      driver: 's3',
      s3: {
        endpoint: env.S3_ENDPOINT ?? '',
        region: env.S3_REGION ?? 'auto',
        bucket: env.S3_BUCKET ?? 'moydan',
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      },
    };
  } else {
    storage = { driver: 'fs', root: fsRoot };
  }

  const appOrigin = (env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '');
  const gameOrigin = (env.GAME_ORIGIN ?? 'http://localhost:5174').replace(/\/$/, '');
  const frameAncestors = (env.GAME_FRAME_ANCESTORS ?? appOrigin)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const config: Config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    appOrigin,
    apiPort: intFromEnv(env, 'API_PORT', 8787),
    host: env.HOST ?? '127.0.0.1',
    sessionSecret: env.SESSION_SECRET ?? DEFAULT_DEV_SECRET,
    workerJobSecret: env.WORKER_JOB_SECRET ?? DEFAULT_DEV_WORKER_SECRET,
    databaseFile: absolutize((env.DATABASE_URL ?? 'file:./var/moydan.db').replace(/^file:/, ''), repoRoot),
    storage,
    gameOrigin,
    cdnBaseUrl: env.CDN_BASE_URL ? env.CDN_BASE_URL.replace(/\/$/, '') : null,
    frameAncestors,
    limits: limitsFromEnv(env),
    build: {
      pollMs: intFromEnv(env, 'WORKER_POLL_MS', 500),
      leaseSeconds: intFromEnv(env, 'BUILD_JOB_LEASE_SECONDS', DEFAULT_LIMITS.buildJobLeaseSeconds),
      timeoutMs: intFromEnv(env, 'BUILD_TIMEOUT_MS', DEFAULT_LIMITS.buildTimeoutMs),
      memoryMb: intFromEnv(env, 'BUILD_MEMORY_MB', DEFAULT_LIMITS.buildMemoryMb),
      workspaceRoot: absolutize(env.BUILD_WORKSPACE_ROOT ?? './var/builds', repoRoot),
      toolchainDir: absolutize(env.BUILD_TOOLCHAIN_DIR ?? './vendor/toolchain', repoRoot),
      useDocker: (env.BUILD_USE_DOCKER ?? '0') === '1',
      containerImage: env.BUILD_CONTAINER_IMAGE ?? 'node:22-alpine',
    },
    rateLimits: {
      defaultPerMinute: intFromEnv(env, 'RATE_LIMIT_DEFAULT_PER_MIN', 300),
      authPerMinute: intFromEnv(env, 'RATE_LIMIT_AUTH_PER_MIN', 20),
      writePerMinute: intFromEnv(env, 'RATE_LIMIT_WRITE_PER_MIN', 120),
      uploadPerMinute: intFromEnv(env, 'RATE_LIMIT_UPLOAD_PER_MIN', 30),
    },
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    repoRoot,
  };

  if (!options.allowUnsafe) assertConfigSafety(config);
  if (!options.env) cached = config;
  return config;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export class ConfigError extends Error {}

/**
 * Production safety checks. These exist because getting any of them wrong
 * silently weakens the platform's security boundary.
 */
export function assertConfigSafety(config: Config): void {
  const problems: string[] = [];
  if (config.isProduction) {
    if (config.sessionSecret === DEFAULT_DEV_SECRET || config.sessionSecret.length < 32) {
      problems.push('SESSION_SECRET must be set to a random value of at least 32 characters in production');
    }
    if (config.workerJobSecret === DEFAULT_DEV_WORKER_SECRET || config.workerJobSecret.length < 32) {
      problems.push('WORKER_JOB_SECRET must be set to a random value of at least 32 characters in production');
    }
    if (!config.appOrigin.startsWith('https://')) problems.push('APP_ORIGIN must use https in production');
    if (!config.gameOrigin.startsWith('https://')) problems.push('GAME_ORIGIN must use https in production');
    const appHost = safeHost(config.appOrigin);
    const gameHost = safeHost(config.gameOrigin);
    if (appHost && gameHost && appHost === gameHost) {
      problems.push(
        'GAME_ORIGIN must be a different origin than APP_ORIGIN: untrusted game code must not share the application origin',
      );
    }
    if (config.storage.driver === 'fs') {
      problems.push('STORAGE_DRIVER=fs is a development adapter; configure S3-compatible object storage in production');
    }
    if (config.storage.driver === 's3') {
      const s3 = config.storage.s3;
      if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
        problems.push('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for STORAGE_DRIVER=s3');
      }
    }
    if (config.build.useDocker === false) {
      problems.push(
        'BUILD_USE_DOCKER=0 keeps builds in a child process; enable container isolation for production builds',
      );
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Absolute URL helpers used when returning asset/artifact URLs to clients. */
export function gameOriginBase(config: Config): string {
  return config.cdnBaseUrl ?? config.gameOrigin;
}

export function releaseAssetUrl(config: Config, releaseId: string, path: string): string {
  const base = gameOriginBase(config);
  const clean = path.replace(/^\/+/, '');
  return `${base}/r/${encodeURIComponent(releaseId)}/${clean}`;
}

export function previewAssetUrl(config: Config, releaseId: string, token: string, path: string): string {
  const base = gameOriginBase(config);
  const clean = path.replace(/^\/+/, '');
  return `${base}/preview/${encodeURIComponent(releaseId)}/${encodeURIComponent(token)}/${clean}`;
}

export function appUrl(config: Config, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${config.appOrigin}${clean}`;
}

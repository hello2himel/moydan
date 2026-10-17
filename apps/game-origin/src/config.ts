/**
 * Configuration for the game content origin.
 *
 * This service runs *without* `SESSION_SECRET`, `WORKER_JOB_SECRET` and
 * `DATABASE_URL`. It has no accounts, no cookies and no write paths: it only
 * reads immutable objects from object storage and streams them to a browser
 * sandbox. Anything it could see would be exposed to creator-authored code, so
 * the configuration it accepts is deliberately the smallest set that lets it
 * serve artifacts.
 *
 * The one policy it does enforce is the trust boundary itself: this origin must
 * never be reachable under the same host as the application origin.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface OriginS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface OriginConfig {
  host: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  appOrigin: string;
  gameOrigin: string;
  /** Origins allowed to frame game documents (the application, in practice). */
  frameAncestors: string[];
  /** Base URL of the API, used only to validate preview grants. */
  apiUrl: string;
  storage:
    | { driver: 'fs'; root: string }
    | { driver: 's3'; s3: OriginS3Config };
  /** Hard cap on a single response body. */
  maxResponseBytes: number;
  /** Hard cap on a single range response body. */
  maxRangeBytes: number;
  /** Cache lifetime for preview responses (release content is immutable). */
  previewCacheSeconds: number;
  /** How long a validated preview grant may be reused, in milliseconds. */
  grantCacheMs: number;
  /** How long a parsed release index may be reused, in milliseconds. */
  indexCacheMs: number;
  /** Repository root, used to locate `packages/sdk/src/index.ts` at startup. */
  repoRoot: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class OriginConfigError extends Error {}

export interface LoadOriginConfigOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RANGE_BYTES = 8 * 1024 * 1024;

export function loadOriginConfig(options: LoadOriginConfigOptions = {}): OriginConfig {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? resolve(import.meta.dirname, '..', '..', '..');
  const appOrigin = (env['APP_ORIGIN'] ?? 'http://localhost:5173').replace(/\/$/, '');
  const gameOrigin = (env['GAME_ORIGIN'] ?? 'http://localhost:5174').replace(/\/$/, '');
  const frameAncestors = (env['GAME_FRAME_ANCESTORS'] ?? appOrigin)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const driver = (env['STORAGE_DRIVER'] ?? 'fs').toLowerCase();
  const fsRoot = env['STORAGE_FS_ROOT'] ?? './var/storage';
  const storage: OriginConfig['storage'] =
    driver === 's3'
      ? {
          driver: 's3',
          s3: {
            endpoint: env['S3_ENDPOINT'] ?? '',
            region: env['S3_REGION'] ?? 'auto',
            bucket: env['S3_BUCKET'] ?? 'moydan',
            accessKeyId: env['S3_ACCESS_KEY_ID'] ?? '',
            secretAccessKey: env['S3_SECRET_ACCESS_KEY'] ?? '',
            forcePathStyle: (env['S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
          },
        }
      : { driver: 'fs', root: isAbsolute(fsRoot) ? fsRoot : resolve(repoRoot, fsRoot) };

  const config: OriginConfig = {
    host: env['HOST'] ?? '127.0.0.1',
    port: intFromEnv(env, 'GAME_ORIGIN_PORT', intFromEnv(env, 'ORIGIN_PORT', 5174)),
    nodeEnv: nodeEnvOf(env),
    appOrigin,
    gameOrigin,
    frameAncestors: frameAncestors.length > 0 ? frameAncestors : [appOrigin],
    apiUrl: (env['API_URL'] ?? 'http://localhost:8787').replace(/\/$/, ''),
    storage,
    maxResponseBytes: intFromEnv(env, 'ORIGIN_MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES),
    maxRangeBytes: intFromEnv(env, 'ORIGIN_MAX_RANGE_BYTES', DEFAULT_MAX_RANGE_BYTES),
    previewCacheSeconds: intFromEnv(env, 'ORIGIN_PREVIEW_CACHE_SECONDS', 60),
    grantCacheMs: intFromEnv(env, 'ORIGIN_GRANT_CACHE_MS', 5_000),
    indexCacheMs: intFromEnv(env, 'ORIGIN_INDEX_CACHE_MS', 5_000),
    repoRoot,
    logLevel: logLevelOf(env),
  };

  assertBoundary(config);
  return config;
}

/**
 * The trust boundary check. Untrusted creator code runs on this origin, so
 * sharing a host with the authenticated application would hand every game the
 * application's cookies and DOM. Refuse to start rather than misconfigure.
 */
export function assertBoundary(config: OriginConfig): void {
  const appHost = hostOf(config.appOrigin);
  const gameHost = hostOf(config.gameOrigin);
  if (appHost !== null && gameHost !== null && appHost === gameHost) {
    throw new OriginConfigError(
      `GAME_ORIGIN (${config.gameOrigin}) must be a different host than APP_ORIGIN (${config.appOrigin}): untrusted game code must never share the application origin.`,
    );
  }
  if (config.nodeEnv === 'production') {
    if (!config.gameOrigin.startsWith('https://')) {
      throw new OriginConfigError('GAME_ORIGIN must use https in production.');
    }
    if (config.storage.driver !== 's3') {
      throw new OriginConfigError('STORAGE_DRIVER=fs is a development adapter; configure S3-compatible object storage in production.');
    }
    const s3 = config.storage.s3;
    if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
      throw new OriginConfigError('S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for STORAGE_DRIVER=s3.');
    }
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function logLevelOf(env: NodeJS.ProcessEnv): 'debug' | 'info' | 'warn' | 'error' {
  const raw = env['LOG_LEVEL'];
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function nodeEnvOf(env: NodeJS.ProcessEnv): 'development' | 'test' | 'production' {
  const raw = env['NODE_ENV'];
  return raw === 'production' || raw === 'test' ? raw : 'development';
}

/** Repository root of the checkout this service is running from. */
export function defaultRepoRoot(): string {
  const candidate = resolve(import.meta.dirname, '..', '..', '..');
  return existsSync(resolve(candidate, 'packages', 'sdk', 'src', 'index.ts')) ? candidate : process.cwd();
}

/**
 * Shared integration harness.
 *
 * Every integration test gets its own throw-away environment: a temporary
 * directory holding a real SQLite file, a real `fs` object-storage root and a
 * real Fastify app driven through `app.inject()`. Nothing listens on a port and
 * nothing ever touches a developer's `var/` directory.
 *
 * The harness also owns the two accounts almost every suite needs (a creator and
 * a second creator) plus the small number of shortcuts that would otherwise be
 * copy-pasted into ten files.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { GameCard, Paginated, SessionResponse } from '@moydan/core';
import { createStorageDriver, type StorageDriver } from '@moydan/storage';
import { loadConfig, type Config } from '../src/config.ts';
import { Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { createMemoryLogger, type Logger } from '../src/lib/logger.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { buildApp } from '../src/app.ts';
import { runLocalBuild } from '../../worker/src/pipeline.ts';

/** The repository root: templates and the vendored toolchain live under it. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export const SESSION_COOKIE = 'moydan_session';
export const CSRF_COOKIE = 'moydan_csrf';

export interface TestAccount {
  id: string;
  email: string;
  password: string;
  handle: string;
  displayName: string;
  role: 'user' | 'admin';
  /** Value of the `moydan_session` cookie for this account. */
  sessionToken: string;
  /** Value of the readable `moydan_csrf` cookie; must be echoed in `x-csrf-token`. */
  csrfToken: string;
}

export type InjectMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface ApiOptions {
  payload?: unknown;
  /** Send the account's session cookie (and its CSRF header) with the request. */
  account?: TestAccount | null;
  /** Send the account's session token as `Authorization: Bearer` instead. */
  bearer?: string | null;
  headers?: Record<string, string>;
  /** Skip the CSRF header while still sending the session cookie. */
  withoutCsrf?: boolean;
  /** Only the session cookie, no CSRF header at all. */
  cookieOnly?: boolean;
}

export type Api = (method: InjectMethod, url: string, options?: ApiOptions) => Promise<InjectResponse>;

/** The response object `app.inject()` resolves with (light-my-request). */
export type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

export interface CreateEnvOptions {
  /** Extra environment variables, merged over the test defaults. */
  env?: Record<string, string>;
  /** Accounts registered up front, in order. */
  accounts?: { handle: string; email: string; role?: 'user' | 'admin' }[];
  /** Build jobs per day allowed before the quota is enforced. */
  maxBuildJobsPerDay?: number;
  /** Comments per minute allowed by the social service. */
  maxCommentsPerMinute?: number;
  /** Byte ceiling for an imported zip archive. */
  maxArchiveBytes?: number;
  /** Per-account source quota in bytes. */
  quotaUserSourceBytes?: number;
  /** Per-account published-release quota in bytes. */
  quotaUserReleaseBytes?: number;
  /** Games each account may own. */
  maxGamesPerUser?: number;
  /** Largest single file the project service will accept. */
  maxFileBytes?: number;
  /** Largest total source tree a single project may hold. */
  maxSourceBytes?: number;
}

export interface TestEnv {
  root: string;
  config: Config;
  db: Db;
  blobs: BlobStore;
  driver: StorageDriver;
  logger: Logger;
  app: FastifyInstance;
  api: Api;
  alice: TestAccount;
  bob: TestAccount;
  register(identity: { handle: string; email: string; role?: 'user' | 'admin' }): Promise<TestAccount>;
  login(email: string, password: string): Promise<TestAccount>;
  createGame(
    owner: TestAccount,
    options?: { template?: string; slug?: string; title?: string; licenseSpdx?: string; description?: string },
  ): Promise<string>;
  publish(gameId: string, owner: TestAccount): Promise<{ releaseId: string; jobId: string }>;
  close(): Promise<void>;
}

const DEFAULT_PASSWORD = 'correct-horse-battery-staple';

/** Generous HTTP rate limits: per-endpoint business limits are asserted separately. */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  RATE_LIMIT_DEFAULT_PER_MIN: '10000',
  RATE_LIMIT_AUTH_PER_MIN: '1000',
  RATE_LIMIT_WRITE_PER_MIN: '10000',
  RATE_LIMIT_UPLOAD_PER_MIN: '1000',
  MAX_BUILD_JOBS_PER_DAY: '100',
};

function cookieValue(setCookie: string[], name: string): string | null {
  for (const entry of setCookie) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(entry);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

export async function createEnv(options: CreateEnvOptions = {}): Promise<TestEnv> {
  // Unique per call: two envs can be alive at once and must never share state.
  const root = mkdtempSync(join(tmpdir(), 'moydan-api-test-'));
  const storageRoot = join(root, 'storage');
  const config = loadConfig({
    env: { ...BASE_ENV, ...options.env } as NodeJS.ProcessEnv,
    repoRoot: REPO_ROOT,
    allowUnsafe: true,
  });
  if (options.maxBuildJobsPerDay !== undefined) config.limits.maxBuildJobsPerDay = options.maxBuildJobsPerDay;
  if (options.maxCommentsPerMinute !== undefined) config.limits.maxCommentsPerMinute = options.maxCommentsPerMinute;
  if (options.maxArchiveBytes !== undefined) config.limits.maxArchiveBytes = options.maxArchiveBytes;
  if (options.quotaUserSourceBytes !== undefined) config.limits.quotaUserSourceBytes = options.quotaUserSourceBytes;
  if (options.quotaUserReleaseBytes !== undefined) config.limits.quotaUserReleaseBytes = options.quotaUserReleaseBytes;
  if (options.maxGamesPerUser !== undefined) config.limits.maxGamesPerUser = options.maxGamesPerUser;
  if (options.maxFileBytes !== undefined) config.limits.maxFileBytes = options.maxFileBytes;
  if (options.maxSourceBytes !== undefined) config.limits.maxSourceBytes = options.maxSourceBytes;

  config.databaseFile = join(root, 'test.db');
  config.storage = { driver: 'fs', root: storageRoot };
  // Builds materialise their workspace here, never in the repository's var/.
  config.build.workspaceRoot = join(root, 'builds');

  let db: Db | null = null;
  let app: FastifyInstance | null = null;
  try {
    db = new Db(config.databaseFile);
    migrate(db);
    const driver = createStorageDriver({ driver: 'fs', fsRoot: storageRoot });
    const blobs = new BlobStore(db, driver);
    const logger = createMemoryLogger();
    app = await buildApp({ config, db, blobs, logger });
    await app.ready();
    return await assemble({ root, config, db, blobs, driver, logger, app, options });
  } catch (error) {
    // A half-built environment (a rejected handle, a failed migration) must not
    // leave a temporary directory behind for the next run to trip over.
    if (app) await app.close().catch(() => undefined);
    if (db) db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

interface Assembly {
  root: string;
  config: Config;
  db: Db;
  blobs: BlobStore;
  driver: StorageDriver;
  logger: Logger;
  app: FastifyInstance;
  options: CreateEnvOptions;
}

/** Register the fixture accounts and expose the request helper. */
async function assemble(parts: Assembly): Promise<TestEnv> {
  const { root, config, db, blobs, driver, logger, app, options } = parts;

  const api: Api = async (method, url, callOptions = {}) => {
    let headers: Record<string, string> = {};
    let cookies: Record<string, string> | undefined;
    if (callOptions.account) {
      // A browser sends both cookies; `x-csrf-token` echoes the readable one.
      cookies = { [SESSION_COOKIE]: callOptions.account.sessionToken };
      if (!callOptions.cookieOnly) cookies[CSRF_COOKIE] = callOptions.account.csrfToken;
      if (!callOptions.cookieOnly && !callOptions.withoutCsrf) {
        headers['x-csrf-token'] = callOptions.account.csrfToken;
      }
      // Explicit headers win, so a test can forge or omit the CSRF token.
      headers = { ...headers, ...callOptions.headers };
    } else {
      headers = { ...callOptions.headers };
    }
    if (callOptions.bearer) headers['authorization'] = `Bearer ${callOptions.bearer}`;
    const injected = await app.inject({
      method,
      url,
      ...(callOptions.payload !== undefined ? { payload: callOptions.payload as never } : {}),
      headers,
      ...(cookies ? { cookies } : {}),
    });
    return injected;
  };

  const register = async (identity: { handle: string; email: string; role?: 'user' | 'admin' }): Promise<TestAccount> => {
    const payload = {
      email: identity.email,
      password: DEFAULT_PASSWORD,
      handle: identity.handle,
      displayName: identity.handle,
    };
    const response = await api('POST', '/api/auth/register', { payload });
    if (response.statusCode !== 200) {
      throw new Error(`register(${identity.handle}) failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<SessionResponse>();
    const setCookie = response.headers['set-cookie'];
    const values = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
    const sessionToken = cookieValue(values, SESSION_COOKIE);
    if (!sessionToken) throw new Error('register did not set a session cookie');
    return {
      id: body.user.id,
      email: identity.email,
      password: DEFAULT_PASSWORD,
      handle: identity.handle,
      displayName: identity.handle,
      role: body.user.role,
      sessionToken,
      csrfToken: body.user.csrfToken,
    };
  };

  const login = async (email: string, password: string): Promise<TestAccount> => {
    const response = await api('POST', '/api/auth/login', { payload: { email, password } });
    if (response.statusCode !== 200) {
      throw new Error(`login(${email}) failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<SessionResponse>();
    const setCookie = response.headers['set-cookie'];
    const values = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
    const sessionToken = cookieValue(values, SESSION_COOKIE);
    if (!sessionToken) throw new Error('login did not set a session cookie');
    return {
      id: body.user.id,
      email,
      password,
      handle: body.user.handle,
      displayName: body.user.displayName,
      role: body.user.role,
      sessionToken,
      csrfToken: body.user.csrfToken,
    };
  };

  const identities = options.accounts ?? [
    { handle: 'alice', email: 'alice@test.moydan.local' },
    { handle: 'bob', email: 'bob@test.moydan.local' },
  ];
  const created: TestAccount[] = [];
  for (const identity of identities) created.push(await register(identity));
  const alice = created[0];
  const bob = created[1];
  if (!alice || !bob) throw new Error('createEnv requires at least two accounts');

  const createGame = async (
    owner: TestAccount,
    gameOptions: { template?: string; slug?: string; title?: string; licenseSpdx?: string; description?: string } = {},
  ): Promise<string> => {
    const template = gameOptions.template ?? 'bounce-dodge';
    const title = gameOptions.title ?? 'Bounce Dodge';
    const slug = gameOptions.slug ?? `${template}`;
    const response = await api('POST', '/api/games', {
      account: owner,
      payload: {
        title,
        slug,
        description: gameOptions.description ?? `Integration fixture for ${template}.`,
        licenseSpdx: gameOptions.licenseSpdx ?? 'MIT',
        template,
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`createGame(${slug}) failed: ${response.statusCode} ${response.body}`);
    }
    const gameId = response.json<{ game: { id: string } }>().game.id;

    // Every starter template ships byte-identical source, so two projects built
    // from it have the same tree hash. Give each fixture a unique marker comment
    // so a test can build more than one template game in the same environment.
    // Best effort: an environment with a deliberately tiny per-file or quota
    // limit cannot accept the rewritten entry file, and those suites never build.
    const original = await api('GET', `/api/games/${gameId}/draft/files/src/main.ts`, { account: owner });
    if (original.statusCode === 200) {
      const marked = `${original.body}\n// moydan integration fixture ${gameId}\n`;
      await api('PUT', `/api/games/${gameId}/draft/files/src/main.ts`, { account: owner, ...raw(marked) });
    }
    return gameId;
  };

  const publish = async (gameId: string, owner: TestAccount): Promise<{ releaseId: string; jobId: string }> =>
    runLocalBuild({ db, blobs, limits: config.limits, config }, { gameId, userId: owner.id });

  const close = async (): Promise<void> => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };

  return { root, config, db, blobs, driver, logger, app, api, alice, bob, register, login, createGame, publish, close };
}

/** Read a `Paginated<GameCard>` body from a feed or listing response. */
export function gameItems(body: unknown): GameCard[] {
  return (body as Paginated<GameCard>).items;
}

export function errorCode(response: InjectResponse): string {
  return response.json<{ error: { code: string } }>().error.code;
}

/** Raw bytes payload helper for the file routes, which never parse JSON. */
export function raw(content: string | Uint8Array, contentType = 'application/octet-stream'): ApiOptions {
  return {
    headers: { 'content-type': contentType },
    payload: typeof content === 'string' ? content : Buffer.from(content),
  };
}
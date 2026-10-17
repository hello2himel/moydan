/**
 * The game content origin.
 *
 * A second, deliberately tiny HTTP service whose only job is to hand untrusted
 * creator code to a browser sandbox, from a *different origin* than the
 * application:
 *
 *   GET /health                         - liveness
 *   GET /sdk/moydan-sdk.js              - the compiled creator SDK
 *   GET /r/:releaseId/*                 - published artifact files
 *   GET /preview/:releaseId/:token/*    - unpublished artifact files, grant checked
 *
 * It has no database, no session, no cookie and no write path. Everything it
 * serves is read from object storage, and the security headers in `headers.ts`
 * (whose comment block explains the trust boundary) are applied to every single
 * response. Read that file before changing anything here.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStorageDriver, type StorageDriver } from '@moydan/storage';
import { createLogger, type Logger } from '../../api/src/lib/logger.ts';
import { ArtifactCorrupt, ArtifactStore, ArtifactTooLarge } from './artifacts.ts';
import { defaultRepoRoot, loadOriginConfig, OriginConfigError, type OriginConfig } from './config.ts';
import { PreviewGrantVerifier } from './grants.ts';
import { artifactHeaders, releaseCacheControl, securityHeaders, sdkHeaders } from './headers.ts';
import { contentRangeHeader, parseRange, slice, unsatisfiedRangeHeader } from './ranges.ts';
import { buildSdkBundle, type SdkBundle } from './sdk.ts';

export interface OriginServerOptions {
  config?: OriginConfig;
  /** Injectable for tests; defaults to the driver implied by the config. */
  storage?: StorageDriver;
  logger?: Logger;
}

export interface OriginServer {
  app: FastifyInstance;
  config: OriginConfig;
  logger: Logger;
}

interface ReleaseParams {
  releaseId: string;
  '*': string;
}

interface PreviewParams {
  releaseId: string;
  token: string;
  '*': string;
}

export async function buildOriginServer(options: OriginServerOptions = {}): Promise<OriginServer> {
  const config = options.config ?? loadOriginConfig({ repoRoot: defaultRepoRoot() });
  const logger = options.logger ?? createLogger({ name: 'moydan-game-origin', level: config.logLevel });
  // `config.storage` is this process's own config shape ({ driver, root }); the
  // shared factory takes a `StorageSelection` ({ driver, fsRoot, s3 }).
  const storage =
    options.storage ??
    createStorageDriver(
      config.storage.driver === 's3'
        ? { driver: 's3', s3: config.storage.s3 }
        : { driver: 'fs', fsRoot: config.storage.root },
    );
  const artifacts = new ArtifactStore(storage, {
    indexTtlMs: config.indexCacheMs,
    maxResponseBytes: config.maxResponseBytes,
  });
  const grants = new PreviewGrantVerifier({
    apiUrl: config.apiUrl,
    cacheMs: config.grantCacheMs,
    logger,
  });
  const sdk: SdkBundle = await buildSdkBundle({ repoRoot: config.repoRoot });
  logger.info('sdk compiled', { bytes: sdk.size, sha256: sdk.sha256.slice(0, 12) });

  const app = Fastify({
    logger: false,
    trustProxy: true,
    disableRequestLogging: true,
    // Artifact paths can be up to the platform's project path limit long.
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 512 },
  });

  // Every response carries the sandbox policy, and never a cookie.
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(securityHeaders(config))) reply.header(name, value);
    reply.removeHeader('set-cookie');
    logger.debug('request', {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
    });
    return payload;
  });

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).type('text/plain; charset=utf-8').send('not found'),
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ArtifactTooLarge) return reply.code(413).type('text/plain; charset=utf-8').send(error.message);
    if (error instanceof ArtifactCorrupt) {
      logger.error('artifact digest mismatch', { url: request.url, message: error.message });
      return reply.code(502).type('text/plain; charset=utf-8').send('stored artifact failed its integrity check');
    }
    const status = clientErrorStatus(error);
    logger.error('origin error', { url: request.url, message: messageOf(error) });
    return reply
      .code(status)
      .type('text/plain; charset=utf-8')
      .send(status === 404 ? 'not found' : 'the game origin is unavailable');
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/sdk/moydan-sdk.js', async (_request, reply) =>
    reply.code(200).headers(sdkHeaders()).send(Buffer.from(sdk.code)),
  );

  app.get<{ Params: ReleaseParams }>('/r/:releaseId/*', async (request, reply) =>
    serveArtifact(request, reply, artifacts, config, { preview: false, releaseId: request.params.releaseId }),
  );

  app.get<{ Params: PreviewParams }>('/preview/:releaseId/:token/*', async (request, reply) => {
    const { releaseId, token } = request.params;
    const allowed = await grants.verify(releaseId, token);
    if (!allowed) {
      logger.warn('preview denied', { releaseId });
      return reply.code(403).type('text/plain; charset=utf-8').send('preview link is invalid or expired');
    }
    return serveArtifact(request, reply, artifacts, config, { preview: true, releaseId });
  });

  // This origin is not an API origin: no preflight, no CORS headers, ever.
  const refusePreflight = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await reply.code(405).header('allow', 'GET, HEAD').type('text/plain; charset=utf-8').send('method not allowed');
  };
  app.options('/r/:releaseId/*', refusePreflight);
  app.options('/preview/:releaseId/:token/*', refusePreflight);

  return { app, config, logger };
}

interface ServeOptions {
  preview: boolean;
  releaseId: string;
}

async function serveArtifact(
  request: FastifyRequest<{ Params: ReleaseParams }>,
  reply: FastifyReply,
  artifacts: ArtifactStore,
  config: OriginConfig,
  options: ServeOptions,
): Promise<FastifyReply> {
  const path = request.params['*'] ?? '';
  const immutable = !options.preview;
  const asset = await artifacts.read(options.releaseId, path, {
    acceptEncoding: String(request.headers['accept-encoding'] ?? ''),
    immutable,
  });
  if (!asset) {
    return reply.code(404).type('text/plain; charset=utf-8').send('not found');
  }

  const cacheControl = releaseCacheControl(options.preview, config.previewCacheSeconds);
  const headers = artifactHeaders({
    contentType: asset.contentType,
    etag: asset.etag,
    cacheControl,
    sha256: asset.sha256,
  });
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);

  if (matchesEtag(request.headers['if-none-match'], asset.etag)) {
    return reply.code(304).removeHeader('content-type').send();
  }

  const size = asset.body.byteLength;
  const range = parseRange(request.headers['range'], size);
  if (range.kind === 'unsatisfiable') {
    return reply.code(416).header('content-range', unsatisfiedRangeHeader(size)).send();
  }
  if (range.kind === 'range') {
    const partial = slice(asset.body, range.range);
    if (partial.byteLength > config.maxRangeBytes) {
      return reply.code(413).type('text/plain; charset=utf-8').send('requested range is too large');
    }
    return reply
      .code(206)
      .header('content-range', contentRangeHeader(range.range, size))
      .header('content-length', String(partial.byteLength))
      .send(Buffer.from(partial));
  }

  return reply.code(200).header('content-length', String(size)).send(Buffer.from(asset.body));
}

/** RFC 9110 weak comparison: `W/"x"` matches `"x"`. */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const values = Array.isArray(header) ? header : [header];
  const normalize = (value: string): string => value.trim().replace(/^W\//, '');
  const target = normalize(etag);
  for (const value of values) {
    if (value.trim() === '*') return true;
    if (normalize(value) === target) return true;
  }
  return false;
}

/** 4xx is the caller's problem and keeps its status; everything else is a 502 here. */
function clientErrorStatus(error: unknown): number {
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 500 ? candidate : 502;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Boot the service. Exits non-zero on a configuration or build failure. */
export async function startOrigin(): Promise<void> {
  let server: OriginServer;
  try {
    server = await buildOriginServer();
  } catch (error) {
    const message = error instanceof OriginConfigError || error instanceof Error ? error.message : String(error);
    createLogger({ name: 'moydan-game-origin' }).error('could not start', { message });
    process.exitCode = 2;
    return;
  }
  const { app, config, logger } = server;
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  logger.info('game origin listening', {
    host: config.host,
    port: config.port,
    gameOrigin: config.gameOrigin,
    appOrigin: config.appOrigin,
    storage: config.storage.driver,
  });
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryUrl !== '' && import.meta.url === entryUrl) {
  await startOrigin();
}

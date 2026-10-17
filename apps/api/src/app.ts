/**
 * Fastify application assembly.
 *
 * The app is built from explicit dependencies so tests can create a fully
 * functional API against a temporary database and storage root, and so the
 * same code serves development, tests and production.
 *
 * Cross-cutting behaviour lives here, in one request lifecycle:
 *   - session resolution (cookie or bearer token);
 *   - CSRF enforcement for cookie-authenticated writes;
 *   - consistent AppError -> JSON error bodies;
 *   - request logging with secrets redacted.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { errors, isAppError, AppError, licensePolicy, publicationLicenseOptions, LIMIT_KEYS } from '@moydan/core';
import type { ApiDeps } from './routes/context.ts';
import { authRoutes } from './routes/auth.ts';
import { profileRoutes } from './routes/profiles.ts';
import { metaRoutes } from './routes/meta.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { projectRoutes } from './routes/projects.ts';
import { feedRoutes } from './routes/feed.ts';
import { socialRoutes } from './routes/social.ts';
import { playRoutes } from './routes/play.ts';
import { moderationRoutes } from './routes/moderation.ts';
import { internalRoutes } from './routes/internal.ts';
import { resolveSession, touchSession, verifyCsrf, SESSION_COOKIE } from './services/identity.ts';

export interface BuildAppOptions extends ApiDeps {
  /** Disable rate limiting in tests that hammer the same route. */
  enableRateLimit?: boolean;
  bodyLimitBytes?: number;
}

const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/register']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db, blobs, logger } = options;
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: options.bodyLimitBytes ?? 16 * 1024 * 1024 + 256 * 1024,
    disableRequestLogging: true,
  });

  await app.register(cookie, { secret: undefined });

  if (options.enableRateLimit !== false) {
    await app.register(rateLimit, {
      global: false,
      max: config.rateLimits.defaultPerMinute,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.user?.id ?? request.ip,
      errorResponseBuilder: () => ({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Slow down and try again in a minute.',
        },
      }),
    });
  }

  // Uploads arrive as raw bytes; the route decides how to interpret them from
  // the path, never from a client-supplied content type.
  for (const contentType of ['application/octet-stream', 'application/zip', 'application/x-zip-compressed']) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  }

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('authViaCookie', false);
  app.decorateRequest('csrfValid', false);

  app.addHook('onRequest', async (request) => {
    const cookieToken = request.cookies[SESSION_COOKIE] ?? null;
    const header = String(request.headers.authorization ?? '');
    const bearerToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
    const token = bearerToken ?? cookieToken;
    request.sessionToken = token;
    request.authViaCookie = Boolean(cookieToken && !bearerToken);
    if (!token) return;
    const user = resolveSession({ db, adminEmails: config.adminEmails }, token);
    request.user = user;
    if (user && request.authViaCookie) {
      const provided = String(request.headers['x-csrf-token'] ?? '');
      request.csrfValid = verifyCsrf({ db }, token, provided);
    }
  });

  app.addHook('onResponse', async (request) => {
    if (request.user && request.sessionToken) touchSession(db, request.sessionToken);
  });

  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (!request.user || !request.authViaCookie) return;
    if (CSRF_EXEMPT_PATHS.has(request.routeOptions.url ?? '')) return;
    if (!request.csrfValid) {
      throw new AppError('forbidden', 'This request is missing a valid CSRF token.', {
        hint: 'Send the value of the moydan_csrf cookie in the x-csrf-token header.',
      });
    }
  });

  app.addHook('onRequest', async (request) => {
    const started = Date.now();
    request.raw.once('close', () => {
      logger.debug('http', {
        method: request.method,
        url: request.url,
        status: request.raw.statusCode,
        ms: Date.now() - started,
        userId: request.user?.id ?? null,
      });
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.status).send(error.toJSON());
    }
    const fastifyError = error as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: String(fastifyError.code ?? 'invalid_request'),
          message: fastifyError.message ?? 'Invalid request.',
        },
      });
    }
    logger.error('unhandled error', {
      url: request.url,
      method: request.method,
      message: fastifyError.message,
      stack: (error as Error).stack?.split('\n').slice(0, 6).join('\n'),
    });
    const internal = errors.internal();
    return reply.status(internal.status).send(internal.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Endpoint not found.' } });
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } });
  });

  app.get('/health', async () => ({ ok: true, service: 'moydan-api' }));

  await app.register(authRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api/auth' });
  await app.register(profileRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(metaRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(catalogRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(projectRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(feedRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(socialRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(playRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(moderationRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });
  await app.register(internalRoutes({ config, db, blobs, logger, now: options.now }), { prefix: '/api' });

  // The web app is served from the same origin in production builds; the API
  // only owns /api and /health, so anything else is the app's business.
  app.get('/', async () => ({
    service: 'moydan-api',
    version: '0.1.0',
    docs: [
      '/health',
      '/api/meta',
      '/api/feed/foryou',
      '/api/games/:id',
    ],
  }));

  return app;
}

export function describePlatform(): Record<string, unknown> {
  return {
    licenses: publicationLicenseOptions().map((policy) => ({
      spdx: policy.spdx,
      name: policy.name,
      family: policy.family,
      appliesToCode: policy.appliesToCode,
      allowsSourceRemix: policy.allowsSourceRemix,
      allowsParameterRemix: policy.allowsParameterRemix,
    })),
    limits: LIMIT_KEYS,
    sampleLicense: licensePolicy('MIT')?.name ?? null,
  };
}

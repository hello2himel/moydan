/**
 * Authentication routes.
 *
 * Session model:
 *   - `moydan_session`  : HttpOnly opaque token (hashed at rest in the database);
 *   - `moydan_csrf`     : readable double-submit token. State-changing requests made
 *                     with the *cookie* must send it in `x-csrf-token`.
 *
 * API clients (the CLI, scripts) may instead send `Authorization: Bearer
 * <session token>`: bearer requests are not cookie-authenticated and therefore
 * exempt from CSRF, but they can only be created by an explicit sign-in.
 */

import type { FastifyInstance } from 'fastify';
import type { SessionResponse } from '@moydan/core';
import { parseWith, clientMeta, type ApiDeps } from './context.ts';
import {
  authenticate,
  issueSession,
  loginInputShape,
  registerInputShape,
  registerUser,
  revokeSession,
  type AuthenticatedUser,
} from '../services/identity.ts';
import { SESSION_COOKIE } from '../services/identity.ts';

export const CSRF_COOKIE = 'moydan_csrf';
const SESSION_TTL_DAYS = 30;

export function sessionResponse(deps: ApiDeps, user: AuthenticatedUser, csrfToken: string): SessionResponse {
  return {
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      email: user.email,
      role: user.role,
      csrfToken,
    },
    ...(deps.config.isProduction ? {} : { devNotice: 'Development mode: email addresses are not verified.' }),
  };
}

/**
 * Normalise the sign-in identifier before it is validated.
 *
 * Addresses are compared case-insensitively and people paste them with stray
 * whitespace, but `emailShape` (rightly) rejects both. Normalising first keeps
 * validation strict and the stored value canonical, so `A@B.com ` and `a@b.com`
 * are one account instead of two.
 */
function withNormalisedEmail(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== 'string') return body;
  return { ...(body as Record<string, unknown>), email: email.trim().toLowerCase() };
}

export function authRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const cookieOptions = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: deps.config.isProduction,
      maxAge: SESSION_TTL_DAYS * 86_400,
    };
    const csrfCookieOptions = { ...cookieOptions, httpOnly: false };

    app.post('/register', { config: { rateLimit: { max: deps.config.rateLimits.authPerMinute, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = parseWith(registerInputShape, withNormalisedEmail(request.body));
      const { user, session } = registerUser(
        { db: deps.db, adminEmails: deps.config.adminEmails, now: deps.now },
        input as { email: string; password: string; handle: string; displayName: string },
      );
      reply.setCookie(SESSION_COOKIE, session.token, cookieOptions);
      reply.setCookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions);
      const profile = deps.db.get<{ handle: string; display_name: string; avatar_url: string | null }>(
        'SELECT handle, display_name, avatar_url FROM profiles WHERE user_id = ?',
        [user.id],
      );
      return sessionResponse(
        deps,
        {
          id: user.id,
          email: user.email,
          role: user.role,
          handle: profile?.handle ?? input.handle,
          displayName: profile?.display_name ?? input.displayName,
          avatarUrl: profile?.avatar_url ?? null,
        },
        session.csrfToken,
      );
    });

    app.post('/login', { config: { rateLimit: { max: deps.config.rateLimits.authPerMinute, timeWindow: '1 minute' } } }, async (request, reply) => {
      const input = parseWith(loginInputShape, withNormalisedEmail(request.body));
      const user = authenticate({ db: deps.db, adminEmails: deps.config.adminEmails, now: deps.now }, input.email, input.password);
      const session = issueSession({ db: deps.db, adminEmails: deps.config.adminEmails, now: deps.now }, user.id, clientMeta(request));
      reply.setCookie(SESSION_COOKIE, session.token, cookieOptions);
      reply.setCookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions);
      const profile = deps.db.get<{ handle: string; display_name: string; avatar_url: string | null }>(
        'SELECT handle, display_name, avatar_url FROM profiles WHERE user_id = ?',
        [user.id],
      );
      return sessionResponse(
        deps,
        {
          id: user.id,
          email: user.email,
          role: user.role,
          handle: profile?.handle ?? '',
          displayName: profile?.display_name ?? '',
          avatarUrl: profile?.avatar_url ?? null,
        },
        session.csrfToken,
      );
    });

    app.post('/logout', async (request, reply) => {
      const token = request.sessionToken;
      if (token) revokeSession(deps.db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.clearCookie(CSRF_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/session', async (request) => {
      if (!request.user) return { user: null };
      const csrf = request.cookies[CSRF_COOKIE] ?? '';
      return sessionResponse(deps, request.user, csrf);
    });
  };
}

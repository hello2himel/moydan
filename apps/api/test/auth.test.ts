/**
 * Sessions: cookie issuance, the CSRF double-submit rule, bearer clients, and
 * revocation. Everything here is asserted at the HTTP boundary because the
 * contract is "what the browser sees", not "what the service function returns".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/password.ts';
import { createEnv, errorCode, type TestEnv } from './harness.ts';
import type { SessionResponse } from '@moydan/core';

let env: TestEnv;

beforeAll(async () => {
  env = await createEnv();
});

afterAll(async () => {
  await env.close();
});

function setCookies(response: Awaited<ReturnType<TestEnv['api']>>): string[] {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
}

describe('POST /api/auth/register', () => {
  it('creates the account and returns the public session shape', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'fresh@test.moydan.local', password: 'a-long-enough-password', handle: 'fresh', displayName: 'Fresh' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionResponse>();
    expect(body.user.handle).toBe('fresh');
    expect(body.user.email).toBe('fresh@test.moydan.local');
    expect(body.user.role).toBe('user');
    expect(body.user.csrfToken).toBeTruthy();
    // A password hash or session token must never appear in the response body.
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('scrypt$');
  });

  it('sets an HttpOnly session cookie and a readable CSRF cookie', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'cookies@test.moydan.local', password: 'a-long-enough-password', handle: 'cookies', displayName: 'Cookies' },
    });
    const cookies = setCookies(response);
    const session = cookies.find((cookie) => cookie.startsWith('moydan_session='));
    const csrf = cookies.find((cookie) => cookie.startsWith('moydan_csrf='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).toBeDefined();
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('lowercases and trims the email before storing it', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: '  MiXeD@Test.Moydan.Local ', password: 'a-long-enough-password', handle: 'mixedmail', displayName: 'Mixed' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<SessionResponse>().user.email).toBe('mixed@test.moydan.local');
  });

  it('rejects a handle that is not already lowercase', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'upper@test.moydan.local', password: 'a-long-enough-password', handle: 'MixedCase', displayName: 'Mixed' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('rejects a duplicate email with 409 conflict', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: env.alice.email, password: 'a-long-enough-password', handle: 'someoneelse', displayName: 'Someone' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('conflict');
    expect(response.json<{ error: { details: { field: string } } }>().error.details.field).toBe('email');
  });

  it('rejects a duplicate handle with 409 conflict', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'other@test.moydan.local', password: 'a-long-enough-password', handle: env.alice.handle, displayName: 'Impostor' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { details: { field: string } } }>().error.details.field).toBe('handle');
  });

  it('rejects a handle the platform reserves', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'reserved@test.moydan.local', password: 'a-long-enough-password', handle: 'admin', displayName: 'Admin' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it.each([
    ['too short', 'short1'],
    ['a common password', 'password123'],
    ['padded with whitespace', ' leading and trailing '],
  ])('rejects a password that is %s', async (_label, password) => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: `weak-${password.trim().length}@test.moydan.local`, password, handle: `weak${password.trim().length}x`, displayName: 'Weak' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('rejects a malformed email address at registration', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'not-an-email', password: 'a-long-enough-password', handle: 'bademail', displayName: 'Bad' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });

  it('rejects a malformed email address at sign-in', async () => {
    const response = await env.api('POST', '/api/auth/login', {
      payload: { email: 'not-an-email', password: 'a-long-enough-password' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown body key', async () => {
    const response = await env.api('POST', '/api/auth/register', {
      payload: { email: 'extra@test.moydan.local', password: 'a-long-enough-password', handle: 'extrakey', displayName: 'Extra', role: 'admin' },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response)).toBe('validation_failed');
  });
});

describe('POST /api/auth/login', () => {
  it('issues a new session for the right credentials', async () => {
    const account = await env.login(env.bob.email, env.bob.password);
    expect(account.id).toBe(env.bob.id);
    expect(account.sessionToken).not.toBe(env.bob.sessionToken);
    const session = await env.api('GET', '/api/auth/session', { bearer: account.sessionToken });
    expect(session.statusCode).toBe(200);
    expect(session.json<SessionResponse>().user.id).toBe(env.bob.id);
  });

  it('rejects a wrong password with the same error as an unknown account', async () => {
    const wrong = await env.api('POST', '/api/auth/login', { payload: { email: env.bob.email, password: 'definitely-not-it' } });
    const unknown = await env.api('POST', '/api/auth/login', { payload: { email: 'nobody@test.moydan.local', password: 'definitely-not-it' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(errorCode(wrong)).toBe('unauthenticated');
    expect(wrong.json<{ error: { message: string } }>().error.message).toBe(
      unknown.json<{ error: { message: string } }>().error.message,
    );
  });
});

describe('GET /api/auth/session', () => {
  it('reports the signed-in account for a cookie session', async () => {
    const response = await env.api('GET', '/api/auth/session', { account: env.alice });
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionResponse>();
    expect(body.user.id).toBe(env.alice.id);
    expect(body.user.csrfToken).toBe(env.alice.csrfToken);
  });

  it('reports no user for an anonymous request', async () => {
    const response = await env.api('GET', '/api/auth/session');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: null }>().user).toBeNull();
  });

  it('ignores a session token that was never issued', async () => {
    const response = await env.api('GET', '/api/auth/session', { bearer: 'not-a-real-token' });
    expect(response.json<{ user: null }>().user).toBeNull();
  });
});

describe('CSRF', () => {
  it('rejects a cookie-authenticated write with no CSRF header', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      withoutCsrf: true,
      payload: { title: 'No CSRF', slug: 'no-csrf', description: 'x', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
    expect(response.json<{ error: { message: string } }>().error.message).toContain('CSRF');
  });

  it('rejects a cookie write carrying the wrong CSRF token', async () => {
    const response = await env.api('POST', '/api/games', {
      account: env.alice,
      headers: { 'x-csrf-token': 'forged-token' },
      payload: { title: 'Bad CSRF', slug: 'bad-csrf', description: 'x', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
  });

  it('accepts a cookie write with the matching CSRF token', async () => {
    const gameId = await env.createGame(env.alice, { slug: 'with-csrf' });
    expect(gameId).toMatch(/^gam_/);
  });

  it('never requires CSRF for a safe method', async () => {
    const response = await env.api('GET', '/api/me/profile', { account: env.alice, withoutCsrf: true });
    expect(response.statusCode).toBe(200);
  });

  it('lets a bearer client write without any CSRF token', async () => {
    const gameId = await env.createGame(env.bob, { slug: 'bearer-write' });
    expect(gameId).toMatch(/^gam_/);
  });

  it('exempts the sign-in endpoints, which have no session yet', async () => {
    const response = await env.api('POST', '/api/auth/login', {
      payload: { email: env.alice.email, password: env.alice.password },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('authorisation', () => {
  it('rejects an anonymous write with 401', async () => {
    const response = await env.api('POST', '/api/games', {
      payload: { title: 'Anon', slug: 'anon-game', description: 'x', licenseSpdx: 'MIT', template: 'bounce-dodge' },
    });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('rejects an anonymous read of an account-scoped collection', async () => {
    const response = await env.api('GET', '/api/me/saved');
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('unauthenticated');
  });

  it('rejects a viewer session presented to the worker endpoints', async () => {
    const response = await env.api('POST', '/api/internal/builds/claim', {
      account: env.alice,
      payload: { workerId: 'impostor' },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('forbidden');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session so the cookie stops working', async () => {
    const account = await env.login(env.bob.email, env.bob.password);
    expect((await env.api('GET', '/api/me/profile', { account })).statusCode).toBe(200);

    const logout = await env.api('POST', '/api/auth/logout', { account });
    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ ok: boolean }>().ok).toBe(true);

    const after = await env.api('GET', '/api/me/profile', { account });
    expect(after.statusCode).toBe(401);
    // The revoked token is useless as a bearer token too.
    const bearer = await env.api('GET', '/api/me/profile', { bearer: account.sessionToken });
    expect(bearer.statusCode).toBe(401);
  });

  it('clears both cookies', async () => {
    const account = await env.login(env.bob.email, env.bob.password);
    const logout = await env.api('POST', '/api/auth/logout', { account });
    const cleared = setCookies(logout).filter((cookie) => cookie.includes('Max-Age=0'));
    expect(cleared.some((cookie) => cookie.startsWith('moydan_session='))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith('moydan_csrf='))).toBe(true);
  });

  it('is a no-op for an anonymous caller', async () => {
    const response = await env.api('POST', '/api/auth/logout');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('leaves other sessions of the same account alone', async () => {
    const first = await env.login(env.alice.email, env.alice.password);
    const second = await env.login(env.alice.email, env.alice.password);
    await env.api('POST', '/api/auth/logout', { account: first });
    expect((await env.api('GET', '/api/me/profile', { account: first })).statusCode).toBe(401);
    expect((await env.api('GET', '/api/me/profile', { account: second })).statusCode).toBe(200);
  });
});

describe('session expiry', () => {
  it('stops resolving a session whose expiry has passed and deletes the row', async () => {
    const account = await env.login(env.alice.email, env.alice.password);
    expect((await env.api('GET', '/api/me/profile', { account })).statusCode).toBe(200);

    const expired = new Date(Date.now() - 1000).toISOString();
    const result = env.db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [
      expired,
      hashToken(account.sessionToken),
    ]);
    expect(result.changes).toBe(1);

    expect((await env.api('GET', '/api/me/profile', { account })).statusCode).toBe(401);
    const remaining = env.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM sessions WHERE expires_at = ?',
      [expired],
    );
    expect(Number(remaining?.count ?? -1)).toBe(0);
  });
});

describe('public endpoints', () => {
  it('serves a health check without authentication', async () => {
    const response = await env.api('GET', '/health');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('answers an unknown /api/ route with a JSON 404', async () => {
    const response = await env.api('GET', '/api/does-not-exist');
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('not_found');
  });
});
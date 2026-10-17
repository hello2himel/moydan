/**
 * `moydan login`, `moydan whoami`, `moydan logout` — the CLI's session.
 *
 * The API issues one opaque session token in an HttpOnly cookie. A non-browser
 * client signs in explicitly and keeps that token, then sends it as
 * `Authorization: Bearer` (bearer requests are exempt from CSRF, which is why
 * they exist at all). The token is written 0600 and only ever printed masked.
 */

import { emitKeypressEvents, type Key } from 'node:readline';
import { BUILD_TOOLCHAIN_ID, PLATFORM_NAME } from '@moydan/core';
import { clearCredentials, credentialsPath, readCredentials, writeCredentials, CREDENTIALS_VERSION, type StoredCredentials } from '../credentials.ts';
import { optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, line, maskToken, warn } from '../ui.ts';

const DEFAULT_API_ORIGIN = 'http://localhost:8787';

function apiOriginFor(args: ParsedArgs): string {
  const explicit = optionString(args, 'api', '');
  const fromEnv = process.env.MOYDAN_API_ORIGIN ?? '';
  const stored = readCredentials()?.apiOrigin ?? '';
  const origin = explicit || fromEnv || stored || DEFAULT_API_ORIGIN;
  return origin.replace(/\/+$/, '');
}

interface SessionUser {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  role: string;
}

interface SessionBody {
  user?: SessionUser | null;
  error?: { code?: string; message?: string };
}

/** Read a cookie value out of the `set-cookie` headers of a response. */
function cookieValue(response: Response, name: string): string | null {
  const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const header of headers) {
    const [pair] = header.split(';');
    if (!pair) continue;
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() === name) return decodeURIComponent(pair.slice(equals + 1).trim());
  }
  return null;
}

function promptSecret(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new CliError('stdin is not a terminal; set MOYDAN_PASSWORD instead of typing the password.'));
  }
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = '';
    emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    process.stdout.write(question);

    const finish = (error?: Error): void => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onKeypress = (sequence: string, key: Key): void => {
      if (key.ctrl && key.name === 'c') {
        finish();
        process.exit(130);
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'escape') {
        finish(new CliError('cancelled'));
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && sequence) value += sequence;
    };
    input.on('keypress', onKeypress);
  });
}

async function readBody(response: Response): Promise<SessionBody> {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as SessionBody;
  } catch {
    return { error: { message: `unexpected response body (${text.slice(0, 120)})` } };
  }
}

export async function loginCommand(args: ParsedArgs): Promise<number> {
  const unknown = unknownOptions(args, ['api', 'email']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const origin = apiOriginFor(args);
  const email = optionString(args, 'email', process.env.MOYDAN_EMAIL ?? '');
  if (!email) throw new CliError('an email address is required: --email you@example.com or MOYDAN_EMAIL', EXIT_USAGE);
  const password = process.env.MOYDAN_PASSWORD ?? (await promptSecret(`password for ${email}: `));
  if (password === '') throw new CliError('empty password', EXIT_USAGE);

  let response: Response;
  try {
    response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new CliError(`could not reach the API at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = await readBody(response);
  if (!response.ok) {
    const message = body.error?.message ?? `login failed with HTTP ${response.status}`;
    throw new CliError(`${message} (${origin})`);
  }
  const token = cookieValue(response, 'moydan_session');
  const user = body.user;
  if (!token || !user) {
    throw new CliError('the API did not return a session token; this deployment does not offer CLI bearer sessions.');
  }

  const credentials: StoredCredentials = {
    version: CREDENTIALS_VERSION,
    apiOrigin: origin,
    account: {
      id: user.id,
      handle: user.handle,
      displayName: user.displayName || user.handle,
      email: user.email,
      role: user.role,
    },
    token,
    csrfToken: cookieValue(response, 'moydan_csrf'),
    savedAt: new Date().toISOString(),
  };
  const path = writeCredentials(credentials);
  line(`signed in to ${origin} as @${user.handle} (${user.displayName || user.handle}, ${user.role})`);
  line(`token   ${maskToken(token)}`);
  line(`stored  ${path} (mode 0600)`);
  line(`toolchain ${BUILD_TOOLCHAIN_ID} · ${PLATFORM_NAME} CLI`);
  return EXIT_OK;
}

export async function whoamiCommand(args: ParsedArgs): Promise<number> {
  const unknown = unknownOptions(args, ['api']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  const path = credentialsPath();
  const credentials = readCredentials(path);
  if (!credentials) {
    line(`not signed in. No session stored at ${path}`);
    line('Run "moydan login --email you@example.com" first.');
    return EXIT_FAILURE;
  }
  const origin = optionString(args, 'api', credentials.apiOrigin);
  let response: Response;
  try {
    response = await fetch(`${origin}/api/auth/session`, {
      headers: { authorization: `Bearer ${credentials.token}`, accept: 'application/json' },
    });
  } catch (error) {
    throw new CliError(`could not reach the API at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CliError(`the stored session is no longer valid for ${origin}. Run "moydan login" again.`);
  }
  if (!response.ok) throw new CliError(`the API answered HTTP ${response.status}`);
  const body = await readBody(response);
  const user = body.user;
  if (!user) throw new CliError(`the API reports no active session for ${origin}. Run "moydan login" again.`);
  line(`origin  ${origin}`);
  line(`account @${user.handle} (${user.displayName || user.handle})`);
  line(`id      ${user.id}`);
  line(`role    ${user.role}`);
  line(`email   ${user.email}`);
  line(`token   ${maskToken(credentials.token)}`);
  line(`saved   ${credentials.savedAt}`);
  return EXIT_OK;
}

export async function logoutCommand(): Promise<number> {
  const credentials = readCredentials();
  if (!credentials) {
    line('not signed in; nothing to do');
    return EXIT_OK;
  }
  try {
    await fetch(`${credentials.apiOrigin}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.token}`, accept: 'application/json' },
    });
  } catch {
    warn(`could not reach ${credentials.apiOrigin}; removing the local session only`);
  }
  const removed = clearCredentials();
  line(removed ? `signed out of ${credentials.apiOrigin}` : 'no local session file to remove');
  return EXIT_OK;
}

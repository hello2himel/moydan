/**
 * Session credentials for the CLI.
 *
 * Why a file and not the browser: the API issues one opaque session token and
 * the CLI is a non-browser client, so `moydan login` performs an explicit
 * sign-in and keeps the token in `~/.config/moydan/credentials.json` with mode
 * 0600 (directory 0700). Nothing else on the machine may be able to read it,
 * and the CLI never prints the token — only `ui.maskToken` output.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CREDENTIALS_VERSION = 1;

export interface StoredCredentials {
  version: number;
  /** API origin the token belongs to; a token is never reused across origins. */
  apiOrigin: string;
  account: {
    id: string;
    handle: string;
    displayName: string;
    email: string;
    role: string;
  };
  /** Opaque session token, sent as `Authorization: Bearer`. */
  token: string;
  csrfToken: string | null;
  savedAt: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return resolve(configHome, 'moydan', 'credentials.json');
}

export function readCredentials(path = credentialsPath()): StoredCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredCredentials>;
    if (parsed.version !== CREDENTIALS_VERSION || typeof parsed.token !== 'string' || typeof parsed.apiOrigin !== 'string') {
      return null;
    }
    return parsed as StoredCredentials;
  } catch {
    return null;
  }
}

export function writeCredentials(value: StoredCredentials, path = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Create with restrictive permissions first so the token is never briefly
  // world-readable between write and chmod.
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearCredentials(path = credentialsPath()): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

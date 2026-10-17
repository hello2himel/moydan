/**
 * Password hashing and token utilities.
 *
 * Passwords use scrypt with a per-user random salt and an explicit, versioned
 * parameter string so parameters can be upgraded later without breaking existing
 * accounts. Comparisons are constant time.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(normalize(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(saltRaw ?? '', 'base64');
    expected = Buffer.from(hashRaw ?? '', 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(normalize(password), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

function normalize(password: string): string {
  return password.normalize('NFKC');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for hex/base64 digests of equal length. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still compare something of equal length to keep timing flat.
    const filler = Buffer.alloc(bufferA.length);
    timingSafeEqual(bufferA, filler);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Password policy: length first, no arbitrary character-class theatre. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password must be at most 200 characters';
  if (/^\s|\s$/.test(password)) return 'password must not start or end with whitespace';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'this password is too common';
  return null;
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'iloveyou123',
  'administrator',
  'moydan123',
]);

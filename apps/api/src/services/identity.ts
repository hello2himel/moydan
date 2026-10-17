/**
 * Identity: accounts, sessions, profiles and follows.
 *
 * Session model: an opaque random token stored in an HttpOnly cookie. Only the
 * SHA-256 of the token is persisted, so a database leak does not hand out live
 * sessions. A second token (the CSRF token) is returned to the client and must
 * accompany state-changing requests.
 */

import {
  errors,
  emailShape,
  handleShape,
  newId,
  schema,
  slugShape,
  type CreatorRef,
} from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';
import { generateToken, hashPassword, hashToken, passwordProblem, verifyPassword } from '../lib/password.ts';

export const SESSION_COOKIE = 'moydan_session';
export const SESSION_TTL_DAYS = 30;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_hash: string;
  user_agent: string;
  ip_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export const registerInputShape = schema.object({
  // The shared `emailShape` enforces a real address shape; a bare string here
  // would let "not-an-email" become a sign-in identifier.
  email: emailShape,
  password: schema.string({ minLength: 10, maxLength: 200 }),
  handle: handleShape,
  displayName: schema.string({ minLength: 1, maxLength: 40 }),
});

export type RegisterInput = { email: string; password: string; handle: string; displayName: string };

export const loginInputShape = schema.object({
  email: emailShape,
  password: schema.string({ minLength: 1, maxLength: 200 }),
});

export interface IdentityContext {
  db: Db;
  adminEmails: string[];
  now?: () => Date;
}

export function registerUser(context: IdentityContext, input: RegisterInput): { user: UserRow; session: IssuedSession } {
  const email = input.email.trim().toLowerCase();
  const passwordIssue = passwordProblem(input.password);
  if (passwordIssue) throw errors.validationFailed(passwordIssue, { field: 'password' });

  const handleProblem = handleShape.validate(input.handle.trim().toLowerCase());
  if (!handleProblem.ok) {
    throw errors.validationFailed('That handle is not available.', { field: 'handle', issues: handleProblem.issues });
  }
  const handle = input.handle.trim().toLowerCase();

  const existingEmail = context.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existingEmail) throw errors.conflict('An account with that email already exists.', { field: 'email' });
  const existingHandle = context.db.get<{ user_id: string }>('SELECT user_id FROM profiles WHERE handle = ?', [handle]);
  if (existingHandle) throw errors.conflict('That handle is already taken.', { field: 'handle' });

  const now = (context.now ?? (() => new Date()))().toISOString();
  const role: 'user' | 'admin' = context.adminEmails.includes(email) ? 'admin' : 'user';
  const user: UserRow = {
    id: newId('user'),
    email,
    password_hash: hashPassword(input.password),
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const profile: ProfileRow = {
    user_id: user.id,
    handle,
    display_name: input.displayName.trim(),
    bio: '',
    avatar_url: null,
    created_at: now,
    updated_at: now,
  };

  context.db.transaction(() => {
    context.db.run('INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      user.id,
      user.email,
      user.password_hash,
      user.role,
      user.status,
      user.created_at,
      user.updated_at,
    ]);
    context.db.run(
      'INSERT INTO profiles (user_id, handle, display_name, bio, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [profile.user_id, profile.handle, profile.display_name, profile.bio, profile.avatar_url, profile.created_at, profile.updated_at],
    );
    context.db.run(
      'INSERT INTO storage_usage (user_id, source_bytes, release_bytes, preview_bytes, blob_count, game_count, updated_at) VALUES (?, 0, 0, 0, 0, 0, ?)',
      [user.id, now],
    );
  });

  return { user, session: issueSession(context, user.id, { userAgent: '', ip: '' }) };
}

export function authenticate(context: IdentityContext, email: string, password: string): UserRow {
  const row = context.db.get<UserRow>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  // Always run a verification to keep timing similar for unknown accounts.
  const stored = row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = verifyPassword(password, stored);
  if (!row || !ok) throw errors.unauthenticated('Email or password is incorrect.');
  if (row.status !== 'active') throw errors.forbidden('This account is suspended.');
  return row;
}

export interface IssuedSession {
  token: string;
  csrfToken: string;
  session: SessionRow;
}

export function issueSession(
  context: IdentityContext,
  userId: string,
  meta: { userAgent: string; ip: string },
  options: { ttlDays?: number } = {},
): IssuedSession {
  const now = (context.now ?? (() => new Date()))();
  const ttlDays = options.ttlDays ?? SESSION_TTL_DAYS;
  const token = generateToken(32);
  const csrfToken = generateToken(24);
  const session: SessionRow = {
    id: newId('session'),
    user_id: userId,
    token_hash: hashToken(token),
    csrf_hash: hashToken(csrfToken),
    user_agent: meta.userAgent.slice(0, 200),
    ip_hash: meta.ip ? hashToken(meta.ip).slice(0, 32) : '',
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlDays * 86_400_000).toISOString(),
  };
  context.db.run(
    'INSERT INTO sessions (id, user_id, token_hash, csrf_hash, user_agent, ip_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      session.id,
      session.user_id,
      session.token_hash,
      session.csrf_hash,
      session.user_agent,
      session.ip_hash,
      session.created_at,
      session.last_seen_at,
      session.expires_at,
    ],
  );
  return { token, csrfToken, session };
}

export function resolveSession(context: IdentityContext, token: string | null | undefined): AuthenticatedUser | null {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = context.db.get<SessionRow & { user_id: string }>('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    context.db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
    return null;
  }
  const user = context.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [row.user_id]);
  if (!user || user.status !== 'active') return null;
  const profile = context.db.get<ProfileRow>('SELECT * FROM profiles WHERE user_id = ?', [user.id]);
  if (!profile) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    handle: profile.handle,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url,
  };
}

export function sessionCsrfToken(dependencies: { db: Db }, sessionToken: string): string | null {
  const row = dependencies.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(sessionToken)]);
  if (!row) return null;
  // The raw CSRF token is not stored; the API returns it at sign-in and the
  // client echoes it back. We can only compare hashes here.
  return null;
}

export function verifyCsrf(dependencies: { db: Db }, sessionToken: string, provided: string | null): boolean {
  if (!provided) return false;
  const row = dependencies.db.get<SessionRow>('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(sessionToken)]);
  if (!row) return false;
  return hashToken(provided) === row.csrf_hash;
}

export function touchSession(db: Db, token: string): void {
  db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [nowIso(), hashToken(token)]);
}

export function revokeSession(db: Db, token: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export function revokeAllSessions(db: Db, userId: string): number {
  const result = db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return result.changes;
}

export function creatorRefFromRow(row: { id: string; handle: string; display_name: string; avatar_url: string | null }): CreatorRef {
  return { id: row.id, handle: row.handle, displayName: row.display_name, avatarUrl: row.avatar_url };
}

export function loadCreatorRef(db: Db, userId: string): CreatorRef | null {
  const row = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [userId],
  );
  return row ? creatorRefFromRow(row) : null;
}

export interface ProfileUpdateInput {
  displayName?: string;
  bio?: string;
  avatarUrl?: string | null;
}

export const profileUpdateShape = schema.object({
  displayName: schema.string({ minLength: 1, maxLength: 40 }).optional(),
  bio: schema.string({ maxLength: 300 }).optional(),
  avatarUrl: schema
    .string({ minLength: 8, maxLength: 300, pattern: /^https:\/\/[^\s]+$/ })
    .nullable()
    .optional(),
});

export function updateProfile(db: Db, userId: string, input: ProfileUpdateInput): ProfileRow {
  const current = db.get<ProfileRow>('SELECT * FROM profiles WHERE user_id = ?', [userId]);
  if (!current) throw errors.notFound('Profile not found.');
  const next: ProfileRow = {
    ...current,
    display_name: input.displayName?.trim() ?? current.display_name,
    bio: input.bio !== undefined ? input.bio.trim() : current.bio,
    avatar_url: input.avatarUrl !== undefined ? input.avatarUrl : current.avatar_url,
    updated_at: nowIso(),
  };
  db.run('UPDATE profiles SET display_name = ?, bio = ?, avatar_url = ?, updated_at = ? WHERE user_id = ?', [
    next.display_name,
    next.bio,
    next.avatar_url,
    next.updated_at,
    userId,
  ]);
  return next;
}

export function handleAvailable(db: Db, handle: string, exceptUserId?: string): boolean {
  const parsed = handleShape.validate(handle);
  if (!parsed.ok) return false;
  const row = db.get<{ user_id: string }>('SELECT user_id FROM profiles WHERE handle = ?', [handle]);
  if (!row) return true;
  return exceptUserId !== undefined && row.user_id === exceptUserId;
}

export function suggestHandle(db: Db, base: string): string {
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const seed = normalized.length >= 3 && !slugShape.validate(normalized).ok === false ? normalized : 'player';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    if (handleAvailable(db, candidate)) return candidate;
  }
  return `player-${Date.now().toString(36).slice(-5)}`;
}

// --- Follows -----------------------------------------------------------------

export function setFollow(db: Db, followerId: string, followeeId: string, follow: boolean): { following: boolean; followers: number } {
  if (followerId === followeeId) throw errors.validationFailed('You cannot follow yourself.');
  const target = db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [followeeId]);
  if (!target) throw errors.notFound('That creator does not exist.');
  db.transaction(() => {
    if (follow) {
      db.run('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [
        followerId,
        followeeId,
        nowIso(),
      ]);
    } else {
      db.run('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?', [followerId, followeeId]);
    }
  });
  const count = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM follows WHERE followee_id = ?', [followeeId]);
  const state = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM follows WHERE follower_id = ? AND followee_id = ?',
    [followerId, followeeId],
  );
  return { following: Number(state?.count ?? 0) > 0, followers: Number(count?.count ?? 0) };
}

export function followStats(db: Db, userId: string): { followers: number; following: number } {
  const followers = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM follows WHERE followee_id = ?', [userId]);
  const following = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?', [userId]);
  return { followers: Number(followers?.count ?? 0), following: Number(following?.count ?? 0) };
}

export function isFollowing(db: Db, followerId: string | null, followeeId: string): boolean {
  if (!followerId || followerId === followeeId) return false;
  const row = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM follows WHERE follower_id = ? AND followee_id = ?',
    [followerId, followeeId],
  );
  return Number(row?.count ?? 0) > 0;
}

export function listFollowedCreatorIds(db: Db, followerId: string): string[] {
  return db
    .all<{ followee_id: string }>('SELECT followee_id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 2000', [
      followerId,
    ])
    .map((row) => row.followee_id);
}

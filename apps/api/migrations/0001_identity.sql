-- 0001_identity.sql
-- Users, profiles, sessions, follows, storage accounting and audit primitives.
--
-- Conventions used throughout the schema:
--   * identifiers are opaque platform ids (`usr_...`, `gam_...`) stored as TEXT;
--   * timestamps are ISO-8601 UTC strings so they sort lexicographically;
--   * byte counters are INTEGER;
--   * JSON columns are only used for extensible metadata, never for core
--     relationships (those get real columns, foreign keys and indexes).

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio          TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Following is a simple directed edge with a uniqueness guarantee.
CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);

-- Per-account storage accounting, maintained transactionally as blobs and
-- releases are created/removed. Separate columns per storage class so quotas can
-- be reasoned about and reported independently.
CREATE TABLE storage_usage (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  source_bytes   INTEGER NOT NULL DEFAULT 0,
  release_bytes  INTEGER NOT NULL DEFAULT 0,
  preview_bytes  INTEGER NOT NULL DEFAULT 0,
  blob_count     INTEGER NOT NULL DEFAULT 0,
  game_count     INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- Security-sensitive operations (publication, uploads, moderation, auth events)
-- leave an append-only trail.
CREATE TABLE security_events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  ip_hash     TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_security_events_kind ON security_events(kind, created_at DESC);
CREATE INDEX idx_security_events_actor ON security_events(actor_id, created_at DESC);

CREATE TABLE moderation_events (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('game', 'comment', 'user', 'release', 'report')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_moderation_target ON moderation_events(target_type, target_id, created_at DESC);

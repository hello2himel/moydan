-- 0002_projects_and_releases.sql
-- Native project storage: identity, mutable draft, immutable source versions,
-- content-addressed blobs, isolated build jobs, immutable releases, remix
-- lineage and score submissions.

-- Content-addressed blob metadata. Blob bytes never live in the database: this
-- table describes objects in the S3-compatible store. Bytes for identical
-- content are stored once (same sha256 => same object key).
CREATE TABLE blobs (
  sha256       TEXT PRIMARY KEY,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL,
  class        TEXT NOT NULL CHECK (class IN ('source', 'asset', 'artifact', 'preview', 'thumbnail', 'temporary')),
  key          TEXT NOT NULL,
  compressed_key TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_blobs_class ON blobs(class, created_at);
CREATE INDEX idx_blobs_created ON blobs(created_at);

-- Game (project) identity. `status` describes the *game*, while individual
-- releases have their own immutable status.
CREATE TABLE games (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'published', 'unpublished', 'removed', 'suspended')),
  license_spdx       TEXT NOT NULL,
  license_source     TEXT NOT NULL DEFAULT 'creator-declared',
  thumbnail_path     TEXT,
  accent_color       TEXT,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  current_release_id TEXT,
  current_version_id TEXT,
  published_at       TEXT,
  removed_at         TEXT,
  removal_reason     TEXT,
  is_remix           INTEGER NOT NULL DEFAULT 0 CHECK (is_remix IN (0, 1)),
  root_game_id       TEXT REFERENCES games(id) ON DELETE SET NULL,
  remix_depth        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE INDEX idx_games_owner ON games(owner_id, created_at DESC);
CREATE INDEX idx_games_status ON games(status, published_at DESC);
CREATE INDEX idx_games_root ON games(root_game_id);

-- The editable working copy. Exactly one draft per game.
CREATE TABLE game_drafts (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Mutable file tree of a draft. Rows point at content-addressed blobs, so
-- editing one file never rewrites the rest of the tree.
CREATE TABLE draft_files (
  draft_id     TEXT NOT NULL REFERENCES game_drafts(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  blob_sha     TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('source', 'asset', 'document', 'manifest', 'license')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (draft_id, path)
);

CREATE INDEX idx_draft_files_blob ON draft_files(blob_sha);

-- Immutable published/snapshot source versions. Publishing and remixing create
-- new rows; existing rows are never mutated.
CREATE TABLE source_versions (
  id                 TEXT PRIMARY KEY,
  game_id            TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sequence           INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('snapshot', 'release')),
  manifest_json      TEXT NOT NULL,
  manifest_hash      TEXT NOT NULL,
  tree_hash          TEXT NOT NULL,
  license_spdx       TEXT NOT NULL,
  license_notices    TEXT NOT NULL DEFAULT '[]',
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  note               TEXT NOT NULL DEFAULT '',
  parent_version_id  TEXT REFERENCES source_versions(id) ON DELETE SET NULL,
  remix_params_json  TEXT,
  total_bytes        INTEGER NOT NULL DEFAULT 0,
  file_count         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE (game_id, sequence)
);

CREATE INDEX idx_versions_game ON source_versions(game_id, sequence DESC);
CREATE INDEX idx_versions_tree ON source_versions(tree_hash);

CREATE TABLE version_files (
  version_id   TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  blob_sha     TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('source', 'asset', 'document', 'manifest', 'license')),
  PRIMARY KEY (version_id, path)
);

CREATE INDEX idx_version_files_blob ON version_files(blob_sha);

-- Isolated build jobs. `idempotency_key` prevents duplicate jobs for the same
-- (version, toolchain) pair even when requests are retried or raced.
CREATE TABLE build_jobs (
  id                TEXT PRIMARY KEY,
  game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version_id        TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'building', 'validation_failed', 'ready_for_review', 'published', 'failed', 'cancelled')),
  idempotency_key   TEXT NOT NULL UNIQUE,
  requested_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  worker_id         TEXT,
  lease_expires_at  TEXT,
  error_code        TEXT,
  error_message     TEXT,
  diagnostics_json  TEXT NOT NULL DEFAULT '[]',
  log_text          TEXT NOT NULL DEFAULT '',
  release_id        TEXT,
  toolchain         TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  UNIQUE (version_id, toolchain)
);

CREATE INDEX idx_build_jobs_status ON build_jobs(status, created_at);
CREATE INDEX idx_build_jobs_game ON build_jobs(game_id, created_at DESC);

-- Immutable releases. A release is a complete, verified artifact set. Rows are
-- never mutated after `published`: a new release gets a new row and sequence.
CREATE TABLE releases (
  id                     TEXT PRIMARY KEY,
  game_id                TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  version_id             TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  sequence               INTEGER NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'building'
                           CHECK (status IN ('building', 'ready_for_review', 'published', 'failed', 'withdrawn')),
  manifest_version       INTEGER NOT NULL DEFAULT 1,
  artifact_manifest_json TEXT NOT NULL DEFAULT '{}',
  artifact_hash          TEXT NOT NULL DEFAULT '',
  total_bytes            INTEGER NOT NULL DEFAULT 0,
  first_playable_bytes   INTEGER NOT NULL DEFAULT 0,
  file_count             INTEGER NOT NULL DEFAULT 0,
  entry_path             TEXT NOT NULL DEFAULT 'index.html',
  engine_name            TEXT NOT NULL DEFAULT '',
  engine_version         TEXT NOT NULL DEFAULT '',
  runtime_api_version    TEXT NOT NULL DEFAULT '',
  spec_json              TEXT NOT NULL DEFAULT '{}',
  created_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  verified_at            TEXT,
  published_at           TEXT,
  withdrawn_at           TEXT,
  UNIQUE (game_id, sequence)
);

CREATE INDEX idx_releases_status ON releases(status, created_at DESC);
CREATE INDEX idx_releases_game ON releases(game_id, sequence DESC);

CREATE TABLE release_files (
  id           TEXT PRIMARY KEY,
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  blob_sha     TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  encoding     TEXT,
  is_entry     INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0, 1)),
  UNIQUE (release_id, path, encoding)
);

CREATE INDEX idx_release_files_release ON release_files(release_id);
CREATE INDEX idx_release_files_blob ON release_files(blob_sha);

-- Remix lineage. One row per remixed game, capturing the *exact* parent version
-- so that later changes to the parent can never distort historical attribution.
CREATE TABLE remix_relations (
  id                     TEXT PRIMARY KEY,
  child_game_id          TEXT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
  child_version_id       TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  parent_game_id         TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  parent_version_id      TEXT NOT NULL REFERENCES source_versions(id) ON DELETE RESTRICT,
  parent_release_id      TEXT REFERENCES releases(id) ON DELETE RESTRICT,
  root_game_id           TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  parent_creator_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parent_creator_handle  TEXT NOT NULL,
  parent_title           TEXT NOT NULL,
  child_creator_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode                   TEXT NOT NULL CHECK (mode IN ('source', 'parameters')),
  license_spdx           TEXT NOT NULL,
  parent_license_spdx    TEXT NOT NULL,
  attribution_text       TEXT NOT NULL,
  params_json            TEXT,
  shared_blob_count      INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  CHECK (child_game_id <> parent_game_id)
);

CREATE INDEX idx_remix_parent ON remix_relations(parent_game_id, created_at DESC);
CREATE INDEX idx_remix_root ON remix_relations(root_game_id);

-- Client-submitted scores. These are explicitly *unverified*: they are useful
-- for the creator's dashboard and never presented as tamper-proof competition.
CREATE TABLE game_scores (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  session_id   TEXT NOT NULL,
  value        REAL NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'points',
  difficulty   TEXT,
  duration_ms  INTEGER,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_scores_release ON game_scores(release_id, value DESC);
CREATE INDEX idx_scores_game ON game_scores(game_id, created_at DESC);

-- Short-lived grants for previewing an unpublished build. The token is hashed.
CREATE TABLE preview_grants (
  id           TEXT PRIMARY KEY,
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX idx_preview_grants_release ON preview_grants(release_id, expires_at);

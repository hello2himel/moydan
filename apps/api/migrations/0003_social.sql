-- 0003_social.sql
-- Reactions, saved games, comments, reports, feed signals.

CREATE TABLE reactions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('like', 'love', 'fire', 'wow')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX idx_reactions_game ON reactions(game_id, created_at DESC);

-- Saved games are independent from reactions: saving never implies reacting.
CREATE TABLE saved_collections (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE saved_games (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  collection_id TEXT REFERENCES saved_collections(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id)
);

CREATE INDEX idx_saved_games_user ON saved_games(user_id, created_at DESC, game_id);
CREATE INDEX idx_saved_games_game ON saved_games(game_id);

CREATE TABLE comments (
  id               TEXT PRIMARY KEY,
  game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  author_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  moderation_state TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_state IN ('visible', 'hidden', 'removed')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  edited_at        TEXT,
  deleted_at       TEXT
);

CREATE INDEX idx_comments_game ON comments(game_id, created_at DESC, id);
CREATE INDEX idx_comments_parent ON comments(parent_id, created_at);
CREATE INDEX idx_comments_author ON comments(author_id, created_at DESC);

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('game', 'comment', 'user')),
  target_id    TEXT NOT NULL,
  reason_code  TEXT NOT NULL CHECK (reason_code IN ('spam', 'abuse', 'copyright', 'malware', 'broken', 'other')),
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TEXT,
  resolution   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  UNIQUE (reporter_id, target_type, target_id)
);

CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

-- Denormalised counters used by the transparent feed ranking. They are updated
-- in the same transaction as the underlying write and can be rebuilt with
-- `npm run metrics`.
CREATE TABLE game_metrics (
  game_id            TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  play_count         INTEGER NOT NULL DEFAULT 0,
  score_submissions  INTEGER NOT NULL DEFAULT 0,
  best_score         REAL,
  reaction_count     INTEGER NOT NULL DEFAULT 0,
  comment_count      INTEGER NOT NULL DEFAULT 0,
  save_count         INTEGER NOT NULL DEFAULT 0,
  remix_count        INTEGER NOT NULL DEFAULT 0,
  distinct_players   INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_game_metrics_popularity ON game_metrics(reaction_count, save_count);

-- "Already seen" bookkeeping so the For You feed can avoid repeating games for
-- an active user without storing a per-impression event stream.
CREATE TABLE feed_impressions (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  feed     TEXT NOT NULL CHECK (feed IN ('foryou', 'following', 'saved')),
  seen_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, game_id, feed)
);

CREATE INDEX idx_feed_impressions_user ON feed_impressions(user_id, feed, seen_at DESC);

-- Play sessions give creators honest, coarse analytics (no tracking of
-- individuals beyond the account that started the session).
CREATE TABLE play_sessions (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at   TEXT NOT NULL,
  first_frame_at TEXT,
  ended_at     TEXT,
  outcome      TEXT CHECK (outcome IN ('completed', 'abandoned', 'error')),
  error_code   TEXT
);

CREATE INDEX idx_play_sessions_release ON play_sessions(release_id, started_at DESC);
CREATE INDEX idx_play_sessions_game ON play_sessions(game_id, started_at DESC);

#!/usr/bin/env node
/**
 * `npm run metrics` - rebuild every derived counter from the source rows.
 *
 * `game_metrics` is a cache that the social and play services keep up to date
 * inside their own transactions. This command proves the cache can always be
 * rebuilt from `reactions`, `comments`, `saved_games`, `remix_relations`,
 * `play_sessions` and `game_scores`, so a drifted counter is recoverable instead
 * of permanent.
 *
 * Usage: node src/db/metrics-cli.ts [--json]
 */

import { loadConfig } from '../config.ts';
import { Db, nowIso } from './client.ts';
import { createLogger } from '../lib/logger.ts';
import { rebuildAllMetrics } from '../services/play.ts';
import { refreshGameDashboardMetrics } from '../services/publish.ts';

interface GameMetricRow {
  game_id: string;
  title: string;
  slug: string;
  play_count: number;
  score_submissions: number;
  best_score: number | null;
  reaction_count: number;
  comment_count: number;
  save_count: number;
  remix_count: number;
  distinct_players: number;
  updated_at: string;
}

const asJson = process.argv.includes('--json');

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

const config = loadConfig();
// The JSON/table report goes to stdout; the structured log goes to stderr so
// `--json` stays machine readable when the output is piped.
const logger = createLogger({ name: 'metrics', sink: (line) => process.stderr.write(`${line}\n`) });
const db = new Db(config.databaseFile);
try {
  rebuildAllMetrics(db);
  for (const game of db.all<{ id: string }>('SELECT id FROM games')) {
    refreshGameDashboardMetrics(db, game.id);
  }

  const rows = db.all<GameMetricRow>(
    `SELECT m.game_id AS game_id, g.title AS title, g.slug AS slug, m.play_count AS play_count,
            m.score_submissions AS score_submissions, m.best_score AS best_score,
            m.reaction_count AS reaction_count, m.comment_count AS comment_count,
            m.save_count AS save_count, m.remix_count AS remix_count,
            m.distinct_players AS distinct_players, m.updated_at AS updated_at
       FROM game_metrics m JOIN games g ON g.id = m.game_id
      ORDER BY m.play_count DESC, m.reaction_count DESC, g.created_at ASC`,
  );

  if (asJson) {
    console.log(JSON.stringify({ rebuiltAt: nowIso(), games: rows }, null, 2));
  } else {
    const header = `${pad('GAME', 30)}${pad('PLAYS', 7)}${pad('PLAYERS', 9)}${pad('SCORES', 8)}${pad('BEST', 9)}${pad('REACT', 7)}${pad('CMNT', 6)}${pad('SAVES', 7)}${pad('RMX', 5)}`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const row of rows) {
      console.log(
        `${pad(`${row.title} (${row.slug})`, 30)}${pad(String(row.play_count), 7)}${pad(String(row.distinct_players), 9)}` +
          `${pad(String(row.score_submissions), 8)}${pad(row.best_score === null ? '-' : String(row.best_score), 9)}` +
          `${pad(String(row.reaction_count), 7)}${pad(String(row.comment_count), 6)}${pad(String(row.save_count), 7)}` +
          `${pad(String(row.remix_count), 5)}`,
      );
    }
    console.log('-'.repeat(header.length));
    console.log(`${rows.length} game(s) rebuilt at ${nowIso()} against ${config.databaseFile}`);
  }
  logger.info('metrics.done', { games: rows.length });
} finally {
  db.close();
}
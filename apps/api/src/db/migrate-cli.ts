#!/usr/bin/env node
/**
 * `npm run migrate` - apply pending migrations.
 *
 * Usage:
 *   node src/db/migrate-cli.ts [--dry-run]
 */

import { loadConfig } from '../config.ts';
import { Db } from './client.ts';
import { migrate } from './migrate.ts';

const config = loadConfig();
const dryRun = process.argv.includes('--dry-run');
const db = new Db(config.databaseFile);
try {
  const result = migrate(db, { dryRun, log: (message) => console.log(`[migrate] ${message}`) });
  if (dryRun) {
    console.log(`[migrate] dry run against ${config.databaseFile}`);
    console.log(`[migrate] already applied: ${result.alreadyApplied.length}`);
  }
  console.log(`[migrate] applied ${result.applied.length} migration(s): ${result.applied.join(', ') || 'none'}`);
} finally {
  db.close();
}

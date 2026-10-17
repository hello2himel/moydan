/**
 * Migration runner.
 *
 * - migrations are plain `.sql` files in `apps/api/migrations`, applied in name
 *   order inside a transaction each;
 * - applied migrations are recorded with a checksum so edits to an already
 *   applied migration are detected (and refused) instead of silently diverging;
 * - `--dry-run` lists what would be applied without touching the database.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Db, nowIso } from './client.ts';

export interface MigrationFile {
  version: string;
  path: string;
  sql: string;
  checksum: string;
}

export function migrationsDir(): string {
  return resolve(import.meta.dirname, '..', '..', 'migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return files.map((name) => {
    const path = join(dir, name);
    const sql = readFileSync(path, 'utf8');
    return {
      version: name.replace(/\.sql$/, ''),
      path,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

interface AppliedRow {
  version: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  drift: { version: string; expected: string; actual: string }[];
}

export function migrate(db: Db, options: { dir?: string; dryRun?: boolean; log?: (message: string) => void } = {}): MigrationResult {
  const log = options.log ?? (() => {});
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = db.all<AppliedRow>('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const migrations = loadMigrations(options.dir);

  const drift: MigrationResult['drift'] = [];
  for (const migration of migrations) {
    const existing = appliedByVersion.get(migration.version);
    if (existing && existing.checksum !== migration.checksum) {
      drift.push({ version: migration.version, expected: existing.checksum, actual: migration.checksum });
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `Migration checksum mismatch for: ${drift
        .map((entry) => entry.version)
        .join(', ')}. Never edit an applied migration; add a new one instead.`,
    );
  }

  const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
  if (options.dryRun) {
    return { applied: [], alreadyApplied: [...appliedByVersion.keys()], drift };
  }

  const appliedNow: string[] = [];
  for (const migration of pending) {
    log(`applying ${migration.version}`);
    db.transaction(() => {
      // `exec` runs multiple statements; DDL in SQLite is transactional.
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.checksum,
        nowIso(),
      ]);
    });
    appliedNow.push(migration.version);
  }
  return { applied: appliedNow, alreadyApplied: [...appliedByVersion.keys()], drift };
}

export function migrationsDirectoryForTests(): string {
  return dirname(migrationsDir());
}

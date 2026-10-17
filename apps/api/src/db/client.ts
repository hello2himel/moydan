/**
 * Thin, typed database access layer over `node:sqlite`.
 *
 * The platform keeps SQL explicit (no ORM): migrations are plain SQL files, the
 * query layer is small, and every write that must be atomic uses `transaction()`
 * which maps to `BEGIN IMMEDIATE` so concurrent writers cannot interleave.
 *
 * `node:sqlite` only binds null, number, bigint, string and Uint8Array values,
 * so `normalizeParams` converts booleans to 0/1 and rejects anything else
 * instead of silently storing "[object Object]".
 */

import { DatabaseSync, type StatementSync as SQLiteStatement } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type SqlParam = null | number | bigint | string | Uint8Array | boolean | undefined;
export type SqlParams = SqlParam[] | Record<string, SqlParam>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string, options: { readonly?: boolean } = {}) {
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.raw = new DatabaseSync(file, { readOnly: options.readonly ?? false });
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (file !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const statement = this.raw.prepare(sql);
    return statement.get(...(spread(params) as SQLInputValues)) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    const statement = this.raw.prepare(sql);
    return statement.all(...(spread(params) as SQLInputValues)) as unknown as T[];
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const statement = this.raw.prepare(sql);
    const result = statement.run(...(spread(params) as SQLInputValues));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: (result.lastInsertRowid ?? 0) as number | bigint,
    };
  }

  /** Run `fn` in an immediate transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // The transaction is already gone; surface the original error.
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * `node:sqlite` takes either positional parameters or a single named-parameter
 * object; the overloads are separate, so each call site needs the concrete shape.
 */
type SQLInputValues = Parameters<SQLiteStatement['get']>;

function spread(params: SqlParams): unknown[] | [Record<string, unknown>] {
  return Array.isArray(params) ? (params.map(normalizeParam) as unknown[]) : [named(params)];
}
function named(params: Record<string, SqlParam>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key.startsWith('$') || key.startsWith(':') ? key : `$${key}`] = normalizeParam(value);
  }
  return out;
}

function normalizeParam(value: SqlParam): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('refusing to bind a non-finite number; store JSON-encoded metadata instead');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  throw new Error(`unsupported SQL parameter of type ${typeof value}`);
}

/** Booleans are stored as 0/1: helpers keep the conversion in one place. */
export function toDbBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromDbBool(value: number | null): boolean {
  return value === 1;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

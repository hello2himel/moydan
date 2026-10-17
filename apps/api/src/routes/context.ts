/**
 * Shared request helpers for route modules.
 *
 * Routes are plain `(app, opts)` plugins closed over an `ApiDeps` object, so
 * every dependency (database, blob store, configuration, logger) is explicit
 * and a test can build the same app against a temporary database.
 */

import type { FastifyRequest } from 'fastify';
import { errors, type Shape } from '@moydan/core';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { BlobStore } from '../storage/blobs.ts';
import type { AuthenticatedUser } from '../services/identity.ts';
import type { Logger } from '../lib/logger.ts';

export interface ApiDeps {
  config: Config;
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  /** Injectable clock used by tests. */
  now?: () => Date;
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) throw errors.unauthenticated();
  return request.user;
}

export function optionalUser(request: FastifyRequest): AuthenticatedUser | null {
  return request.user ?? null;
}

export function parseWith<T>(shape: Shape<T>, value: unknown): T {
  const result = shape.validate(value);
  if (!result.ok) {
    throw errors.validationFailed(
      result.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
      { issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
    );
  }
  return result.value;
}

export function clientMeta(request: FastifyRequest): { ip: string; userAgent: string } {
  return {
    ip: request.ip || '',
    userAgent: String(request.headers['user-agent'] ?? ''),
  };
}

/**
 * Normalise `request.query` for schema validation.
 *
 * Two things make the raw query object unusable as-is:
 *   - Fastify's query parser produces an object whose prototype `isPlainObject`
 *     (and therefore every schema in the platform) rejects;
 *   - query values always arrive as strings, so a schema that declares a number
 *     (`limit`) would reject every client that sends it.
 *
 * Only the keys the caller names are coerced, so an id that *looks* numeric is
 * still validated as the string the contract says it is.
 */
export function queryOf(request: FastifyRequest, numericKeys: readonly string[] = []): Record<string, unknown> {
  const source = { ...((request.query ?? {}) as Record<string, unknown>) };
  for (const key of numericKeys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) source[key] = parsed;
    }
  }
  return source;
}

export function appendPagination(query: FastifyRequest['query']): string {
  const params = new URLSearchParams();
  const source = (query ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') params.set(key, value);
  }
  return params.toString();
}

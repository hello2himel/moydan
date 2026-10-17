/**
 * Moderation endpoints: filing reports and the admin queue.
 *
 * Admin is a server-side check on the resolved session, never a request flag.
 * Resolutions go through the moderation service so every privileged action is
 * journalled and the caller gets the resulting report state back.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors, schema } from '@moydan/core';
import { parseWith, queryOf, requireUser, type ApiDeps } from './context.ts';
import type { AuthenticatedUser } from '../services/identity.ts';
import {
  createReport,
  listReports,
  REPORT_REASONS,
  resolveReport,
  toReport,
  type ModerationAction,
} from '../services/moderation.ts';

const MAX_DETAILS_LENGTH = 1000;
const DEFAULT_REPORT_LIMIT = 25;
const MAX_REPORT_LIMIT = 100;

const reportShape = schema.object({
  targetType: schema.enum(['game', 'comment', 'user'] as const),
  targetId: schema.string({ minLength: 3, maxLength: 64 }),
  reasonCode: schema.enum(REPORT_REASONS),
  details: schema.string({ maxLength: MAX_DETAILS_LENGTH }).optional(),
});

const reportsQueryShape = schema.object(
  {
    status: schema.enum(['open', 'actioned', 'dismissed', 'all'] as const).optional(),
    cursor: schema.string({ minLength: 1, maxLength: 512 }).optional(),
    limit: schema.number({ min: 1, max: MAX_REPORT_LIMIT, integer: true }).optional(),
  },
  { allowUnknown: true },
);

const actionShape = schema.union<ModerationAction>(
  schema.object({ kind: schema.literal('dismiss'), note: schema.string({ maxLength: 300 }).optional() }),
  schema.object({ kind: schema.literal('remove-game'), reason: schema.string({ minLength: 3, maxLength: 300 }) }),
  schema.object({ kind: schema.literal('suspend-creator'), reason: schema.string({ minLength: 3, maxLength: 300 }) }),
  schema.object({ kind: schema.literal('hide-comment'), note: schema.string({ maxLength: 300 }).optional() }),
  schema.object({ kind: schema.literal('restore-game') }),
);
const resolveShape = schema.object({ action: actionShape });

function requireAdmin(request: FastifyRequest): AuthenticatedUser {
  const viewer = requireUser(request);
  if (viewer.role !== 'admin') throw errors.forbidden('Moderator access only.');
  return viewer;
}

/**
 * Fastify's query parser builds objects with a prototype `isPlainObject` (and
 * therefore every schema in the platform) rejects, so queries are re-homed on a
 * plain object before validation.
 */

export function moderationRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/reports', async (request) => {
      const viewer = requireUser(request);
      const input = parseWith(reportShape, request.body);
      const row = createReport(deps.db, {
        reporterId: viewer.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reasonCode: input.reasonCode,
        details: input.details ?? '',
      });
      return toReport(deps.db, row);
    });

    app.get('/admin/reports', async (request) => {
      requireAdmin(request);
      const query = parseWith(reportsQueryShape, queryOf(request, ['limit']));
      return listReports(deps.db, {
        status: query.status,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_REPORT_LIMIT,
      });
    });

    app.post<{ Params: { reportId: string } }>('/admin/reports/:reportId/resolve', async (request) => {
      const moderator = requireAdmin(request);
      const input = parseWith(resolveShape, request.body);
      return resolveReport(deps.db, {
        reportId: String(request.params.reportId),
        action: input.action,
        moderator,
      });
    });
  };
}
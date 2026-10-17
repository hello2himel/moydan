/**
 * Play sessions.
 *
 * The web player is untrusted input: a session can be started without an account
 * (so anonymous visitors can be counted), but the session id is a capability
 * that only the sandboxed host holds, and a session that belongs to an account
 * can only be finished by that account. Reports are claims, never proof.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  defaultRemixParameterValues,
  errors,
  safeJsonParse,
  schema,
  type RemixParameterValues,
} from '@moydan/core';
import { releaseAssetUrl } from '../config.ts';
import { optionalUser, parseWith, type ApiDeps } from './context.ts';
import { canViewGame, manifestOfGame, releaseSpec, type ReleaseRow } from '../services/catalog.ts';
import { findGameRow, type GameRow } from '../services/projects.ts';
import {
  createPlaySession,
  findPlaySession,
  heartbeatPlaySession,
  reportPlaySession,
  type PlaySessionRow,
  type ReportInput,
} from '../services/play.ts';

const idShape = schema.string({ minLength: 3, maxLength: 64 });

const createSessionShape = schema.object({ gameId: idShape, releaseId: idShape });
const heartbeatShape = schema.object({
  frames: schema.number({ min: 0, max: 100_000_000, integer: true }),
  fps: schema.number({ min: 0, max: 10_000 }).optional(),
});
const reportShape = schema.object({
  outcome: schema.enum(['completed', 'abandoned', 'error'] as const),
  errorCode: schema.string({ maxLength: 64 }).optional(),
  score: schema.number({ min: -1e12, max: 1e12 }).optional(),
  scoreUnit: schema.string({ minLength: 1, maxLength: 16 }).optional(),
  difficulty: schema.string({ minLength: 1, maxLength: 24 }).optional(),
  durationMs: schema.number({ min: 0, max: 24 * 60 * 60 * 1000, integer: true }).optional(),
  meta: schema.json({ maxBytes: 2048 }).optional(),
});

function playSessionView(deps: ApiDeps, game: GameRow, release: ReleaseRow, request: FastifyRequest) {
  const spec = releaseSpec(release);
  const manifest = manifestOfGame(deps.db, game, release);
  const storedParams = release.version_id
    ? safeJsonParse<RemixParameterValues>(
        deps.db.get<{ remix_params_json: string | null }>('SELECT remix_params_json FROM source_versions WHERE id = ?', [
          release.version_id,
        ])?.remix_params_json ?? 'null',
      )
    : null;
  const limits = deps.config.limits;
  return {
    entryUrl: releaseAssetUrl(deps.config, release.id, release.entry_path),
    params: { ...defaultRemixParameterValues(manifest?.remix?.parameters ?? []), ...(storedParams ?? {}) } as RemixParameterValues,
    capabilities: spec.capabilities,
    apiVersion: release.runtime_api_version,
    locale: negotiateLocale(request),
    viewport: spec.viewport,
    orientation: spec.orientation,
    limits: {
      runtimeMaxInitMs: limits.runtimeMaxInitMs,
      runtimeHeartbeatMs: limits.runtimeHeartbeatMs,
      runtimeMaxMessageBytes: limits.runtimeMaxMessageBytes,
      runtimeMessagesPerSecond: limits.runtimeMessagesPerSecond,
    },
  };
}

/** Best-effort locale from `Accept-Language`; the runtime falls back to `en`. */
function negotiateLocale(request: FastifyRequest): string {
  const header = String(request.headers['accept-language'] ?? '');
  const first = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z]{2,8}(-[a-z0-9]{2,8})*$/.test(first) ? first : 'en';
}

/**
 * Load a session the caller is allowed to finish. An anonymous session is
 * protected only by its id (a capability token); an owned session additionally
 * requires the matching account.
 */
function loadOwnedSession(deps: ApiDeps, sessionId: string, request: FastifyRequest): PlaySessionRow {
  const session = findPlaySession(deps.db, sessionId);
  if (!session) throw errors.notFound('Play session not found.');
  if (!session.user_id) return session;
  const viewer = optionalUser(request);
  if (!viewer || viewer.id !== session.user_id) throw errors.forbidden('This play session belongs to another account.');
  return session;
}

export function playRoutes(deps: ApiDeps) {
  const writeLimit = { max: deps.config.rateLimits.writePerMinute, timeWindow: '1 minute' } as const;

  return async function register(app: FastifyInstance): Promise<void> {
    app.post('/play/sessions', { config: { rateLimit: writeLimit } }, async (request) => {
      const input = parseWith(createSessionShape, request.body);
      const viewer = optionalUser(request);
      const game = findGameRow(deps.db, input.gameId);
      if (!game || !canViewGame(game, viewer)) throw errors.notFound('Game not found.');

      const release = deps.db.get<{ id: string; game_id: string; status: string }>(
        'SELECT id, game_id, status FROM releases WHERE id = ?',
        [input.releaseId],
      );
      if (!release || release.game_id !== game.id) throw errors.notFound('Release not found.');
      // Only a published release may be started by a visitor: previews and
      // half-finished builds are reachable through preview grants instead.
      if (release.status !== 'published') throw errors.notFound('This release is not published.');

      const fullRelease = deps.db.get<ReleaseRow>('SELECT * FROM releases WHERE id = ?', [release.id]);
      if (!fullRelease) throw errors.notFound('Release not found.');

      const session = createPlaySession(deps.db, {
        gameId: game.id,
        releaseId: fullRelease.id,
        userId: viewer?.id ?? null,
      });
      return { sessionId: session.id, ...playSessionView(deps, game, fullRelease, request) };
    });

    app.post<{ Params: { sessionId: string } }>(
      '/play/sessions/:sessionId/heartbeat',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const input = parseWith(heartbeatShape, request.body);
        const session = loadOwnedSession(deps, String(request.params.sessionId), request);
        return heartbeatPlaySession(deps.db, session, { frames: input.frames, fps: input.fps });
      },
    );

    app.post<{ Params: { sessionId: string } }>(
      '/play/sessions/:sessionId/report',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const body = parseWith(reportShape, request.body);
        const session = loadOwnedSession(deps, String(request.params.sessionId), request);
        const input: ReportInput = {
          outcome: body.outcome,
          ...(body.errorCode !== undefined ? { errorCode: body.errorCode } : {}),
          ...(body.score !== undefined ? { score: body.score } : {}),
          ...(body.scoreUnit !== undefined ? { scoreUnit: body.scoreUnit } : {}),
          ...(body.difficulty !== undefined ? { difficulty: body.difficulty } : {}),
          ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
          ...(body.meta !== undefined ? { meta: body.meta } : {}),
        };
        return reportPlaySession(deps.db, session, input);
      },
    );
  };
}
/**
 * Social interactions: reactions, saves, comments and share links.
 *
 * Every write here is scoped to the authenticated viewer and to a game that
 * viewer is allowed to see. Unpublished games resolve to 404 for everybody but
 * the owner and admins, so a draft cannot be reacted to, commented on or shared
 * by guessing an id.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors, schema } from '@moydan/core';
import { optionalUser, parseWith, queryOf, requireUser, type ApiDeps } from './context.ts';
import { appUrl } from '../config.ts';
import { canViewGame } from '../services/catalog.ts';
import { findGameRow, type GameRow } from '../services/projects.ts';
import {
  createComment,
  deleteComment,
  listComments,
  REACTION_TYPES,
  setReaction,
  setSaved,
  updateComment,
  type ReactionType,
} from '../services/social.ts';

const MAX_COMMENT_LIMIT = 50;
const DEFAULT_COMMENT_LIMIT = 20;

const reactionShape = schema.object({ type: schema.enum(REACTION_TYPES) });
const commentShape = schema.object({
  body: schema.string({ minLength: 1, maxLength: 2000 }),
  parentId: schema.string({ minLength: 3, maxLength: 64 }).nullable().optional(),
});
const commentPatchShape = schema.object({ body: schema.string({ minLength: 1, maxLength: 2000 }) });
const commentsQueryShape = schema.object(
  {
    cursor: schema.string({ minLength: 1, maxLength: 512 }).optional(),
    limit: schema.number({ min: 1, max: MAX_COMMENT_LIMIT, integer: true }).optional(),
    parentId: schema.string({ minLength: 3, maxLength: 64 }).optional(),
  },
  { allowUnknown: true },
);

function socialDeps(deps: ApiDeps) {
  return { db: deps.db, limits: deps.config.limits };
}

/**
 * Fastify's query parser builds objects with a prototype `isPlainObject` (and
 * therefore every schema in the platform) rejects, so queries are re-homed on a
 * plain object before validation.
 */

/** A game the viewer may act on; unpublished games stay invisible to strangers. */
function loadActableGame(deps: ApiDeps, gameId: string, request: FastifyRequest): GameRow {
  const viewer = optionalUser(request);
  const game = findGameRow(deps.db, gameId);
  if (!game || !canViewGame(game, viewer)) throw errors.notFound('Game not found.');
  return game;
}

export function socialRoutes(deps: ApiDeps) {
  const writeLimit = { max: deps.config.rateLimits.writePerMinute, timeWindow: '1 minute' } as const;

  return async function register(app: FastifyInstance): Promise<void> {
    // --- Reactions -----------------------------------------------------------

    app.put<{ Params: { gameId: string } }>('/games/:gameId/reaction', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const game = loadActableGame(deps, String(request.params.gameId), request);
      const input = parseWith(reactionShape, request.body);
      return setReaction(socialDeps(deps), viewer, game, input.type as ReactionType);
    });

    app.delete<{ Params: { gameId: string } }>('/games/:gameId/reaction', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const game = loadActableGame(deps, String(request.params.gameId), request);
      return setReaction(socialDeps(deps), viewer, game, null);
    });

    // --- Saved games ---------------------------------------------------------

    app.put<{ Params: { gameId: string } }>('/games/:gameId/save', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const game = loadActableGame(deps, String(request.params.gameId), request);
      return setSaved(socialDeps(deps), viewer, game, true);
    });

    app.delete<{ Params: { gameId: string } }>('/games/:gameId/save', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const game = loadActableGame(deps, String(request.params.gameId), request);
      return setSaved(socialDeps(deps), viewer, game, false);
    });

    // --- Comments ------------------------------------------------------------

    app.get<{ Params: { gameId: string } }>('/games/:gameId/comments', async (request) => {
      const game = loadActableGame(deps, String(request.params.gameId), request);
      const query = parseWith(commentsQueryShape, queryOf(request, ['limit']));
      return listComments(deps.db, game.id, optionalUser(request), {
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_COMMENT_LIMIT,
        parentId: query.parentId ?? null,
      });
    });

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/comments',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const game = loadActableGame(deps, String(request.params.gameId), request);
        const input = parseWith(commentShape, request.body);
        return createComment(socialDeps(deps), viewer, {
          gameId: game.id,
          parentId: input.parentId ?? null,
          body: input.body,
        });
      },
    );

    app.patch<{ Params: { commentId: string } }>('/comments/:commentId', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const input = parseWith(commentPatchShape, request.body);
      // Authorisation (author or admin) lives in the service so the rule cannot
      // drift between the list, edit and delete paths.
      return updateComment(socialDeps(deps), viewer, String(request.params.commentId), input.body);
    });

    app.delete<{ Params: { commentId: string } }>(
      '/comments/:commentId',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        return deleteComment(socialDeps(deps), viewer, String(request.params.commentId));
      },
    );

    // --- Share ---------------------------------------------------------------

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/share',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        // Minting a share link is an authenticated action so anonymous traffic
        // cannot be used to probe which private drafts exist.
        requireUser(request);
        const game = loadActableGame(deps, String(request.params.gameId), request);
        // The share URL is stable and canonical.
        return { url: appUrl(deps.config, `/games/${game.id}`), title: game.title };
      },
    );
  };
}
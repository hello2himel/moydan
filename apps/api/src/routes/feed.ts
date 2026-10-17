/**
 * Feeds.
 *
 * The feed endpoints are the only reads that record ranking signals, so the
 * viewer is passed to the service rather than resolved again: impressions are
 * attributed to an authenticated account and never to an anonymous scroll,
 * which keeps "what you have seen" a property of a person instead of a NAT.
 */

import type { FastifyInstance } from 'fastify';
import { schema } from '@moydan/core';
import { optionalUser, parseWith, queryOf, requireUser, type ApiDeps } from './context.ts';
import { loadFollowingFeed, loadForYouFeed, loadSavedGames } from '../services/feed.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const feedQueryShape = schema.object(
  {
    limit: schema.number({ min: 1, max: MAX_LIMIT, integer: true }).optional(),
    cursor: schema.string({ minLength: 1, maxLength: 512 }).optional(),
  },
  { allowUnknown: true },
);


export function feedRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get('/feed/foryou', async (request) => {
      const query = parseWith(feedQueryShape, queryOf(request, ['limit']));
      const viewer = optionalUser(request);
      // `loadForYouFeed` calls recordImpressions() itself and only when a
      // viewer id is present: an anonymous request must leave no trace.
      return loadForYouFeed(deps.db, deps.config, {
        viewerId: viewer?.id ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_LIMIT,
      });
    });

    app.get('/feed/following', async (request) => {
      const viewer = requireUser(request);
      const query = parseWith(feedQueryShape, queryOf(request, ['limit']));
      return loadFollowingFeed(deps.db, deps.config, viewer.id, {
        viewerId: viewer.id,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_LIMIT,
      });
    });

    app.get('/me/saved', async (request) => {
      const viewer = requireUser(request);
      const query = parseWith(feedQueryShape, queryOf(request, ['limit']));
      return loadSavedGames(deps.db, deps.config, viewer.id, {
        viewerId: viewer.id,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_LIMIT,
      });
    });
  };
}
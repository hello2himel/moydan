/**
 * Public game reads: the game page, source viewing, release details, scores.
 */

import type { FastifyInstance } from 'fastify';
import { checkPathSafety, contentTypeForPath, errors, type ReleaseDetail } from '@moydan/core';
import { optionalUser, requireUser, type ApiDeps } from './context.ts';
import {
  artifactManifestOf,
  canViewGame,
  currentPublicRelease,
  findRelease,
  lineageOf,
  loadGameCard,
  releaseSummary,
} from '../services/catalog.ts';
import { findGameRow, listVersionFiles, type GameRow } from '../services/projects.ts';
import { remixCapabilities } from '../services/remix.ts';
import { listScores } from '../services/play.ts';

function loadVisibleGame(deps: ApiDeps, gameId: string, viewer: { id: string; role: 'user' | 'admin' } | null): GameRow {
  const game = findGameRow(deps.db, gameId);
  if (!game || !canViewGame(game, viewer)) throw errors.notFound('Game not found.');
  return game;
}

export function catalogRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get<{ Params: { gameId: string } }>('/games/:gameId', async (request) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const card = loadGameCard(deps.db, deps.config, game, viewer?.id ?? null);
      if (!card) throw errors.notFound('Game not found.');
      return card;
    });

    app.get<{ Params: { gameId: string } }>('/games/:gameId/remix-options', async (request) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const capabilities = remixCapabilities(deps.db, game);
      return {
        gameId: game.id,
        title: game.title,
        licenseSpdx: game.license_spdx,
        allowed: capabilities.allowed,
        reason: capabilities.reason,
        modes: capabilities.modes,
        parameters: capabilities.parameters,
        allowedChildLicenses: capabilities.allowedChildLicenses,
      };
    });

    app.get<{ Params: { gameId: string } }>('/games/:gameId/lineage', async (request) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const card = loadGameCard(deps.db, deps.config, game, viewer?.id ?? null);
      return { origin: card?.remixOrigin ?? null, ancestors: lineageOf(deps.db, game.id) };
    });

    app.get<{ Params: { gameId: string } }>('/games/:gameId/scores', async (request) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const limit = Number((request.query as { limit?: string }).limit ?? 10);
      return listScores(deps.db, game.id, Number.isFinite(limit) ? limit : 10);
    });

    // --- Source viewing ------------------------------------------------------

    app.get<{ Params: { gameId: string } }>('/games/:gameId/source', async (request) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const release = currentPublicRelease(deps.db, game);
      const versionId = release?.version_id ?? game.current_version_id;
      if (!versionId) throw errors.notFound('This game has no frozen source yet.');
      const version = deps.db.get<{ license_spdx: string; tree_hash: string; kind: string; created_at: string }>(
        'SELECT license_spdx, tree_hash, kind, created_at FROM source_versions WHERE id = ?',
        [versionId],
      );
      if (!version) throw errors.notFound('This game has no frozen source yet.');
      const card = loadGameCard(deps.db, deps.config, game, viewer?.id ?? null);
      const visible = card?.source?.visible ?? false;
      const isOwner = viewer?.id === game.owner_id || viewer?.role === 'admin';
      if (!visible && !isOwner) {
        throw errors.forbidden(card?.source?.visibilityNote ?? 'The source of this game is not public.');
      }
      const files = listVersionFiles(deps.db, versionId).map((file) => ({
        path: file.path,
        size: file.size_bytes,
        contentType: file.content_type,
        role: file.role,
      }));
      return {
        versionId,
        licenseSpdx: version.license_spdx,
        treeHash: version.tree_hash,
        kind: version.kind,
        createdAt: version.created_at,
        visible,
        files,
      };
    });

    app.get<{ Params: { gameId: string; '*': string } }>('/games/:gameId/source/files/*', async (request, reply) => {
      const viewer = optionalUser(request);
      const game = loadVisibleGame(deps, String(request.params.gameId), viewer);
      const path = String(request.params['*'] ?? '');
      if (checkPathSafety(path)) throw errors.notFound('File not found.');
      const release = currentPublicRelease(deps.db, game);
      const versionId = release?.version_id ?? game.current_version_id;
      if (!versionId) throw errors.notFound('File not found.');
      const card = loadGameCard(deps.db, deps.config, game, viewer?.id ?? null);
      const isOwner = viewer?.id === game.owner_id || viewer?.role === 'admin';
      if (!card?.source?.visible && !isOwner) {
        throw errors.forbidden(card?.source?.visibilityNote ?? 'The source of this game is not public.');
      }
      const file = deps.db.get<{ blob_sha: string; content_type: string }>(
        'SELECT blob_sha, content_type FROM version_files WHERE version_id = ? AND path = ?',
        [versionId, path],
      );
      if (!file) throw errors.notFound('File not found.');
      const object = await deps.blobs.read(file.blob_sha, { verify: false });
      if (!object) throw errors.notFound('File is missing from storage.');
      reply.header('content-type', file.content_type || contentTypeForPath(path));
      reply.header('cache-control', 'public, max-age=300');
      reply.header('x-content-type-options', 'nosniff');
      // Source files are served as attachments when they could be rendered as
      // active content: the app origin must never execute creator markup.
      if (!/^(text\/plain|image\/|audio\/|application\/json)/.test(file.content_type || '')) {
        reply.header('content-disposition', `attachment; filename="${path.split('/').pop() ?? 'file'}"`);
      }
      return reply.send(Buffer.from(object.body));
    });

    // --- Releases ------------------------------------------------------------

    app.get<{ Params: { releaseId: string } }>('/releases/:releaseId', async (request) => {
      const viewer = optionalUser(request);
      const release = findRelease(deps.db, String(request.params.releaseId));
      if (!release) throw errors.notFound('Release not found.');
      const game = findGameRow(deps.db, release.game_id);
      if (!game) throw errors.notFound('Release not found.');
      const isOwner = viewer?.id === game.owner_id || viewer?.role === 'admin';
      if (release.status !== 'published' && !isOwner) throw errors.notFound('Release not found.');
      const artifactManifest = artifactManifestOf(release);
      if (!artifactManifest) {
        if (!isOwner) throw errors.internal('Release artifact manifest is unreadable.');
        // The owner of a release that is still building, failed or withdrawn has
        // no artifact yet. Their build state and diagnostics are the useful
        // answer, not a server error.
        throw errors.notFound('This release has no artifact yet; check the build status.');
      }
      const job = deps.db.get<{ id: string }>(
        'SELECT id FROM build_jobs WHERE release_id = ? LIMIT 1',
        [release.id],
      );
      const detail: ReleaseDetail = {
        ...releaseSummary(deps.config, release),
        artifactManifest,
        buildJobId: job?.id ?? null,
        versionId: release.version_id,
      };
      return detail;
    });

    app.get<{ Params: { gameId: string } }>('/games/:gameId/releases', async (request) => {
      const viewer = requireUser(request);
      const game = findGameRow(deps.db, String(request.params.gameId));
      if (!game) throw errors.notFound('Game not found.');
      if (game.owner_id !== viewer.id && viewer.role !== 'admin') throw errors.notFound('Game not found.');
      const rows = deps.db.all<Parameters<typeof releaseSummary>[1]>(
        'SELECT * FROM releases WHERE game_id = ? ORDER BY sequence DESC LIMIT 30',
        [game.id],
      );
      return { items: rows.map((row) => releaseSummary(deps.config, row)), nextCursor: null, total: rows.length };
    });
  };
}

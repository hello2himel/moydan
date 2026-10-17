/**
 * Creator profiles, follows and account-scoped reads.
 */

import type { FastifyInstance } from 'fastify';
import { errors, isKnownLicense, publicationLicenseOptions, type PublicProfile } from '@moydan/core';
import { optionalUser, parseWith, requireUser, type ApiDeps } from './context.ts';
import {
  followStats,
  isFollowing,
  loadCreatorRef,
  profileUpdateShape,
  setFollow,
  suggestHandle,
  updateProfile,
} from '../services/identity.ts';
import { listCreatorGames } from '../services/feed.ts';
import { readUsage } from '../storage/usage.ts';

export function profileRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const publicProfile = (userId: string, viewerId: string | null): PublicProfile => {
      const row = deps.db.get<{
        id: string;
        handle: string;
        display_name: string;
        bio: string;
        avatar_url: string | null;
        created_at: string;
      }>(
        `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.bio AS bio,
                p.avatar_url AS avatar_url, p.created_at AS created_at
           FROM users u JOIN profiles p ON p.user_id = u.id
          WHERE u.id = ? AND u.status = 'active'`,
        [userId],
      );
      if (!row) throw errors.notFound('That creator does not exist.');
      const published = deps.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM games WHERE owner_id = ? AND status = 'published'",
        [userId],
      );
      const remixes = deps.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM games WHERE owner_id = ? AND is_remix = 1',
        [userId],
      );
      const plays = deps.db.get<{ total: number | null }>(
        `SELECT SUM(m.play_count) AS total FROM game_metrics m JOIN games g ON g.id = m.game_id
          WHERE g.owner_id = ? AND g.status = 'published'`,
        [userId],
      );
      const stats = followStats(deps.db, userId);
      return {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bio: row.bio,
        createdAt: row.created_at,
        stats: {
          publishedGames: Number(published?.count ?? 0),
          remixes: Number(remixes?.count ?? 0),
          followers: stats.followers,
          following: stats.following,
          totalPlays: Number(plays?.total ?? 0),
        },
        isViewer: viewerId === userId,
        viewerFollows: isFollowing(deps.db, viewerId, userId),
      };
    };

    app.get('/me/profile', async (request) => {
      const viewer = requireUser(request);
      if (!viewer) throw errors.unauthenticated();
      return publicProfile(viewer.id, viewer.id);
    });

    app.patch('/me/profile', async (request) => {
      const viewer = requireUser(request);
      const input = parseWith(profileUpdateShape, request.body);
      updateProfile(deps.db, viewer.id, input);
      return publicProfile(viewer.id, viewer.id);
    });

    app.get('/me/storage', async (request) => {
      const viewer = requireUser(request);
      const usage = readUsage(deps.db, viewer.id);
      const limits = deps.config.limits;
      return {
        ...usage,
        limits: {
          sourceBytes: limits.quotaUserSourceBytes,
          releaseBytes: limits.quotaUserReleaseBytes,
          games: limits.maxGamesPerUser,
          fileBytes: limits.maxFileBytes,
          projectFiles: limits.maxProjectFiles,
          projectSourceBytes: limits.maxSourceBytes,
          artifactBytes: limits.maxArtifactBytes,
          firstPlayableBytes: limits.maxFirstPlayableBytes,
        },
      };
    });

    app.get('/me/games', async (request) => {
      const viewer = requireUser(request);
      const cards = listCreatorGames(deps.db, deps.config, viewer.id, viewer.id, { includeDrafts: true });
      return { items: cards, nextCursor: null, total: cards.length };
    });

    app.get<{ Params: { handle: string } }>('/profiles/:handle', async (request) => {
      const viewer = optionalUser(request);
      const handle = String(request.params.handle ?? '').toLowerCase();
      const row = deps.db.get<{ user_id: string }>(
        "SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.handle = ? AND u.status = 'active'",
        [handle],
      );
      if (!row) throw errors.notFound('That creator does not exist.');
      return publicProfile(row.user_id, viewer?.id ?? null);
    });

    app.get<{ Params: { handle: string } }>('/profiles/:handle/games', async (request) => {
      const viewer = optionalUser(request);
      const handle = String(request.params.handle ?? '').toLowerCase();
      const row = deps.db.get<{ user_id: string }>(
        "SELECT p.user_id FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.handle = ? AND u.status = 'active'",
        [handle],
      );
      if (!row) throw errors.notFound('That creator does not exist.');
      const cards = listCreatorGames(deps.db, deps.config, row.user_id, viewer?.id ?? null, {
        includeDrafts: viewer?.id === row.user_id || viewer?.role === 'admin',
      });
      return { items: cards, nextCursor: null, total: cards.length };
    });

    app.post<{ Params: { handle: string } }>('/profiles/:handle/follow', async (request) => {
      const viewer = requireUser(request);
      const handle = String(request.params.handle ?? '').toLowerCase();
      const target = deps.db.get<{ user_id: string }>(
        "SELECT user_id FROM profiles WHERE handle = ?",
        [handle],
      );
      if (!target) throw errors.notFound('That creator does not exist.');
      return setFollow(deps.db, viewer.id, target.user_id, true);
    });

    app.delete<{ Params: { handle: string } }>('/profiles/:handle/follow', async (request) => {
      const viewer = requireUser(request);
      const handle = String(request.params.handle ?? '').toLowerCase();
      const target = deps.db.get<{ user_id: string }>(
        'SELECT user_id FROM profiles WHERE handle = ?',
        [handle],
      );
      if (!target) throw errors.notFound('That creator does not exist.');
      return setFollow(deps.db, viewer.id, target.user_id, false);
    });

    app.get('/handles/available', async (request) => {
      const query = request.query as { handle?: string };
      const candidate = String(query.handle ?? '').trim().toLowerCase();
      const taken = deps.db.get<{ user_id: string }>('SELECT user_id FROM profiles WHERE handle = ?', [candidate]);
      const suggestion = taken ? suggestHandle(deps.db, candidate) : candidate;
      return { handle: candidate, available: !taken, suggestion };
    });

    app.get('/licenses', async () => ({
      items: publicationLicenseOptions().map((policy) => ({
        spdx: policy.spdx,
        name: policy.name,
        url: policy.url,
        family: policy.family,
        appliesToCode: policy.appliesToCode,
        allowsSourceRemix: policy.allowsSourceRemix,
        allowsParameterRemix: policy.allowsParameterRemix,
        requiresAttribution: policy.requiresAttribution,
        sourceRedistributable: policy.sourceRedistributable,
      })),
    }));

    app.get<{ Params: { spdx: string } }>('/licenses/:spdx', async (request) => {
      const spdx = String(request.params.spdx ?? '');
      if (!isKnownLicense(spdx)) throw errors.notFound('Unknown licence.');
      const policy = publicationLicenseOptions().find((entry) => entry.spdx === spdx);
      return { ...policy, requiredNotices: policy?.requiredNotices ?? [] };
    });
  };
}

export function loadCreatorOr404(deps: ApiDeps, userId: string) {
  const creator = loadCreatorRef(deps.db, userId);
  if (!creator) throw errors.notFound('That creator does not exist.');
  return creator;
}

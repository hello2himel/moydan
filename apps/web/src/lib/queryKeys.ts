/**
 * Query key factory.
 *
 * Keys are centralised so cache writes (an optimistic reaction, an unsave on
 * the saved page) can find every cached copy of a `GameCard` without guessing
 * at the shape of each screen's data.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { GameCard } from '@moydan/core';

export const queryKeys = {
  session: ['session'] as const,
  meta: ['meta'] as const,
  templates: ['meta', 'templates'] as const,
  licenses: ['meta', 'licenses'] as const,
  game: (gameId: string) => ['game', gameId] as const,
  lineage: (gameId: string) => ['game', gameId, 'lineage'] as const,
  remixOptions: (gameId: string) => ['game', gameId, 'remix-options'] as const,
  scores: (gameId: string) => ['game', gameId, 'scores'] as const,
  feed: (tab: string) => ['feed', tab] as const,
  saved: ['feed', 'saved'] as const,
  comments: (gameId: string, parentId: string) => ['comments', gameId, parentId] as const,
  profile: (handle: string) => ['profile', handle] as const,
  creatorGames: (handle: string) => ['profile', handle, 'games'] as const,
  ownGames: ['me', 'games'] as const,
  ownProfile: ['me', 'profile'] as const,
  storage: ['me', 'storage'] as const,
  draft: (gameId: string) => ['draft', gameId] as const,
  draftFile: (gameId: string, path: string) => ['draft', gameId, 'file', path] as const,
  builds: (gameId: string) => ['builds', gameId] as const,
  build: (jobId: string) => ['build', jobId] as const,
  versions: (gameId: string) => ['versions', gameId] as const,
  releases: (gameId: string) => ['releases', gameId] as const,
  playSession: (releaseId: string) => ['play', releaseId] as const,
};

function isGameCard(value: unknown): value is GameCard {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function patchCard(card: GameCard, gameId: string, patch: (current: GameCard) => GameCard): GameCard {
  return card.id === gameId ? patch(card) : card;
}

/**
 * Apply `patch` to every cached copy of a game card.
 *
 * A card appears in the feed pages, the saved list, the creator listing, the
 * game page and the studio header. Keeping those in sync by hand is how counts
 * drift apart, so the optimistic write is broadcast instead.
 */
export function patchGameEverywhere(
  queryClient: QueryClient,
  gameId: string,
  patch: (card: GameCard) => GameCard,
): void {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    if (isGameCard(value)) return patchCard(value, gameId, patch);
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return { ...value, items: items.map(walk) };
    return value;
  };

  for (const query of queryClient.getQueryCache().getAll()) {
    const data: unknown = query.state.data;
    if (data === undefined) continue;
    const next = walk(data);
    if (next !== data) query.setData(next);
  }
}

/** Refetch everything that can show a card: used after a server mutation. */
export function invalidateGameViews(queryClient: QueryClient, gameId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.game(gameId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.feed('foryou') });
  void queryClient.invalidateQueries({ queryKey: queryKeys.feed('following') });
  void queryClient.invalidateQueries({ queryKey: queryKeys.saved });
  void queryClient.invalidateQueries({ queryKey: queryKeys.ownGames });
}
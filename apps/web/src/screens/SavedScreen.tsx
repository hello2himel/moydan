/**
 * Saved games.
 *
 * This is a list, not a feed: people come here to *find* something again. The
 * difference matters for two edge cases - a game the creator unpublished or a
 * moderator removed must still be visible and explained, not silently dropped,
 * because the viewer saved it on purpose.
 */

import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { GameCard } from '@moydan/core';
import { getSavedGames } from '../api/feed.ts';
import { unsaveGame } from '../api/social.ts';
import { patchGameEverywhere, queryKeys } from '../lib/queryKeys.ts';
import { formatCount, formatRelativeTime, pluralize } from '../lib/format.ts';
import { useInView } from '../lib/useInView.ts';
import { useRequireAuth } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { Skeleton } from '../components/Skeleton.tsx';

const STATUS_NOTES: Record<GameCard['status'], string | null> = {
  draft: 'This game is still a draft and was never published.',
  published: null,
  unpublished: 'The creator has unpublished this game. It cannot be played right now.',
  removed: 'This game was removed from Moydan.',
  suspended: 'This game has been suspended.',
};

function SavedCard({ game }: { game: GameCard }): ReactNode {
  const queryClient = useQueryClient();
  const unsave = useMutation({
    mutationFn: () => unsaveGame(game.id),
    onMutate: () => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, saved: false },
        stats: { ...card.stats, saves: Math.max(0, card.stats.saves - 1) },
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.saved });
    },
    onError: () => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, saved: true },
        stats: { ...card.stats, saves: card.stats.saves + 1 },
      }));
    },
  });

  const note = STATUS_NOTES[game.status];

  return (
    <li className="saved-card">
      <Link className="saved-card__link" to={`/games/${game.id}`}>
        <span
          className="saved-card__thumb"
          style={{ background: game.accentColor }}
          aria-hidden="true"
        >
          {game.thumbnailUrl ? (
            <img className="saved-card__image" src={game.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="saved-card__initial">{game.title.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="saved-card__body">
          <span className="saved-card__title">{game.title}</span>
          <span className="saved-card__creator muted small">
            <Avatar url={game.creator.avatarUrl} name={game.creator.displayName} size="xs" />@{game.creator.handle}
          </span>
          <span className="muted small">
            {formatCount(game.stats.plays)} plays &middot; saved{' '}
            {formatRelativeTime(game.publishedAt ?? game.createdAt)}
          </span>
        </span>
      </Link>
      {note ? (
        <p className="notice notice--warn saved-card__note">{note}</p>
      ) : null}
      <Button
        variant="ghost"
        busy={unsave.isPending}
        onClick={() => unsave.mutate()}
        aria-label={`Remove ${game.title} from saved`}
      >
        Remove
      </Button>
    </li>
  );
}

export function SavedScreen(): ReactNode {
  const { isPending } = useRequireAuth();
  const queryClient = useQueryClient();

  const saved = useInfiniteQuery({
    queryKey: queryKeys.saved,
    queryFn: ({ pageParam, signal }) => getSavedGames({ cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const sentinel = useInView<HTMLDivElement>({ threshold: 0, rootMargin: '400px' });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = saved;

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  useEffect(() => {
    if (sentinel.inView) loadMore();
  }, [sentinel.inView, loadMore]);

  const items = useMemo<GameCard[]>(
    () => saved.data?.pages.flatMap((page) => page.items) ?? [],
    [saved.data],
  );

  if (isPending) {
    return (
      <Page>
        <PageHeader title="Saved" />
        <p className="muted">Taking you to sign in…</p>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Saved"
        subtitle={
          saved.data?.pages[0]?.total
            ? pluralize(saved.data.pages[0].total, 'game')
            : 'Games you saved for later'
        }
        actions={
          <Button variant="ghost" onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.saved })}>
            Refresh
          </Button>
        }
      />

      {saved.isPending ? (
        <ul className="saved-grid">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="saved-card">
              <Skeleton variant="block" height="120px" />
            </li>
          ))}
        </ul>
      ) : null}

      {saved.isError ? (
        <ErrorState
          error={saved.error}
          title="Your saved games could not be loaded"
          onRetry={() => void saved.refetch()}
        />
      ) : null}

      {saved.isSuccess && items.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          description="Tap the star on any game in the feed and it will show up here."
          action={
            <Link className="btn btn--primary" to="/feed/foryou">
              Find games
            </Link>
          }
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="saved-grid">
          {items.map((game) => (
            <SavedCard key={game.id} game={game} />
          ))}
        </ul>
      ) : null}

      <div ref={sentinel.ref} className="sheet__sentinel">
        {hasNextPage ? (
          <Button variant="ghost" onClick={loadMore} busy={isFetchingNextPage}>
            Load more
          </Button>
        ) : items.length > 0 ? (
          <p className="muted small">That is everything you saved.</p>
        ) : null}
      </div>
    </Page>
  );
}
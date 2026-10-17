/**
 * The feed.
 *
 * One game per viewport with CSS scroll snapping; only the card that is mostly
 * visible is allowed to play, and the runtime pauses the others instead of
 * tearing their iframes down so scrolling back is instant.
 *
 * Paging is deliberately shallow: react-query prefetches exactly one page
 * ahead, which is enough to make the scroll seamless without a scrolling list
 * of downloads nobody asked for.
 */

import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { GameCard, Paginated } from '@moydan/core';
import { getFollowingFeed, getForYouFeed } from '../api/feed.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { useInView } from '../lib/useInView.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { FeedTabs } from '../components/FeedTabs.tsx';
import { GameCardView } from '../components/GameCardView.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { loginRedirectTarget } from '../session/useRequireAuth.ts';
import { Link, useLocation } from 'react-router-dom';

export type FeedTab = 'foryou' | 'following';

export interface FeedScreenProps {
  tab: FeedTab;
}

function FeedSkeleton(): ReactNode {
  return (
    <div className="feed-item feed-item--skeleton" aria-hidden="true">
      <Skeleton variant="block" height="100%" />
    </div>
  );
}

export function FeedScreen({ tab }: FeedScreenProps): ReactNode {
  const { user, isLoading: sessionLoading } = useSession();
  const location = useLocation();
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const needsAuth = tab === 'following' && !sessionLoading && !user;

  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      tab === 'foryou'
        ? getForYouFeed({ cursor }, signal)
        : getFollowingFeed({ cursor }, signal),
    [tab],
  );

  const feed = useInfiniteQuery({
    queryKey: queryKeys.feed(tab),
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !needsAuth,
    staleTime: 30_000,
  });

  const sentinel = useInView<HTMLDivElement>({ threshold: 0, rootMargin: '600px' });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, data } = feed;

  // Exactly one page ahead: enough to keep the scroll seamless without
  // downloading pages nobody scrolls to.
  useEffect(() => {
    if (!data || !hasNextPage || isFetchingNextPage) return;
    void queryClient.prefetchInfiniteQuery({
      queryKey: queryKeys.feed(tab),
      queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
      initialPageParam: null,
      getNextPageParam: (lastPage: Paginated<GameCard>) => lastPage.nextCursor ?? undefined,
      pages: 1,
    });
  }, [data, hasNextPage, isFetchingNextPage, queryClient, tab, fetchPage]);

  useEffect(() => {
    if (!sentinel.inView || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [sentinel.inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = useMemo<GameCard[]>(
    () => feed.data?.pages.flatMap((page) => page.items) ?? [],
    [feed.data],
  );

  const scrollToItem = useCallback((direction: 1 | -1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nodes = Array.from(scroller.querySelectorAll<HTMLElement>('.feed-item'));
    const current = scroller.scrollTop;
    const target =
      direction > 0
        ? nodes.find((node) => node.offsetTop > current + 8)
        : [...nodes].reverse().find((node) => node.offsetTop < current - 8);
    target?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  const scrollNext = useCallback(() => {
    scrollToItem(1);
  }, [scrollToItem]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      scrollToItem(1);
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      scrollToItem(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      scrollerRef.current?.scrollTo({ top: 0 });
    }
  };

  if (needsAuth) {
    return (
      <div className="page">
        <EmptyState
          title="Following needs an account"
          description="Follow creators you like and their new games show up here."
          action={
            <Link className="btn btn--primary" to={loginRedirectTarget(location.pathname)}>
              Sign in
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="feed">
      <div className="feed__tabs">
        <FeedTabs active={tab} />
      </div>

      <div
        className="feed__scroller"
        ref={scrollerRef}
        tabIndex={0}
        aria-label={tab === 'foryou' ? 'Games for you' : 'Games from creators you follow'}
        onKeyDown={onKeyDown}
      >
        {feed.isPending ? (
          <>
            <FeedSkeleton />
            <FeedSkeleton />
          </>
        ) : null}

        {feed.isError ? (
          <div className="feed__state">
            <ErrorState
              error={feed.error}
              title="The feed could not be loaded"
              onRetry={() => void feed.refetch()}
            />
          </div>
        ) : null}

        {items.map((game, index) => (
          <GameCardView
            key={game.id}
            game={game}
            onNext={index === items.length - 1 ? undefined : scrollNext}
          />
        ))}

        {feed.isSuccess && items.length === 0 ? (
          <div className="feed__state">
            <EmptyState
              title={tab === 'foryou' ? 'Nothing to play yet' : 'You are not following anyone'}
              description={
                tab === 'foryou'
                  ? 'No published games are available on this deployment yet. Be the first to publish one.'
                  : 'Follow a few creators and their new games will appear here.'
              }
              action={
                <Link className="btn btn--secondary" to="/create">
                  Create a game
                </Link>
              }
            />
          </div>
        ) : null}

        <div ref={sentinel.ref} className="feed__sentinel" aria-hidden="true" />

        {feed.isFetchingNextPage ? <FeedSkeleton /> : null}

        {feed.isSuccess && !hasNextPage && items.length > 0 ? (
          <div className="feed__end">
            <p className="muted small">You reached the end.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
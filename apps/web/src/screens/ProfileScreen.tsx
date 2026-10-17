/**
 * Public creator profile.
 *
 * Games and Remixes are separate tabs because they answer different questions:
 * "what did they make" and "what did they take". The listing lives in the query
 * string so a link to someone's remixes is shareable, and the viewer's own
 * profile adds the creator-only affordances (edit, settings, studio).
 */

import { useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { GameCard, PublicProfile } from '@moydan/core';
import { getCreatorGames } from '../api/feed.ts';
import { getProfile } from '../api/session.ts';
import { followCreator, unfollowCreator } from '../api/social.ts';
import { describeError } from '../api/client.ts';
import { formatCount, formatDate } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { loginRedirectTarget } from '../session/useRequireAuth.ts';
import { Page } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';
import { Tabs } from '../components/Tabs.tsx';

type ProfileTab = 'games' | 'remixes';

function GameTile({ game }: { game: GameCard }): ReactNode {
  return (
    <li className="tile">
      <Link className="tile__link" to={`/games/${game.id}`}>
        <span className="tile__thumb" style={{ background: game.accentColor }} aria-hidden="true">
          {game.thumbnailUrl ? (
            <img className="tile__image" src={game.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="tile__initial">{game.title.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="tile__title">{game.title}</span>
        <span className="muted small">
          {game.status === 'published' ? `${formatCount(game.stats.plays)} plays` : game.status}
        </span>
      </Link>
    </li>
  );
}

export interface ProfileScreenProps {
  /**
   * Handle without the `@`. Normally supplied by `HandleOrNotFound` in the
   * router, because react-router path parameters have to start a path segment
   * and `/@ada` cannot be written as a route path.
   */
  handle?: string;
}

export function ProfileScreen({ handle: handleProp }: ProfileScreenProps = {}): ReactNode {
  const params = useParams();
  const normalized = (handleProp ?? params.handle ?? '').toLowerCase();
  const [searchParams] = useSearchParams();
  const tab: ProfileTab = searchParams.get('tab') === 'remixes' ? 'remixes' : 'games';
  const queryClient = useQueryClient();
  const { user } = useSession();

  const profile = useQuery({
    queryKey: queryKeys.profile(normalized),
    queryFn: ({ signal }) => getProfile(normalized, signal),
    enabled: normalized.length > 0,
  });

  const games = useQuery({
    queryKey: queryKeys.creatorGames(normalized),
    queryFn: ({ signal }) => getCreatorGames(normalized, signal),
    enabled: normalized.length > 0 && Boolean(profile.data),
  });

  const follow = useMutation({
    mutationFn: (following: boolean) => (following ? followCreator(normalized) : unfollowCreator(normalized)),
    onMutate: async (following) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.profile(normalized) });
      queryClient.setQueryData<PublicProfile>(queryKeys.profile(normalized), (previous) =>
        previous
          ? {
              ...previous,
              viewerFollows: following,
              stats: {
                ...previous.stats,
                followers: Math.max(0, previous.stats.followers + (following ? 1 : -1)),
              },
            }
          : previous,
      );
    },
    onError: () => {
      // Roll back by re-reading the authoritative profile.
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile(normalized) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile(normalized) });
    },
  });

  const published = useMemo(
    () => (games.data?.items ?? []).filter((game) => game.status !== 'draft'),
    [games.data],
  );
  const remixes = useMemo(() => published.filter((game) => game.isRemix), [published]);
  const originals = useMemo(() => published.filter((game) => !game.isRemix), [published]);
  const visible = tab === 'games' ? originals : remixes;

  if (profile.isPending) return <LoadingScreen label="Loading profile" />;
  if (profile.isError) {
    return (
      <Page>
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} title="This creator does not exist" />
        <p className="muted">
          <Link to="/feed/foryou">Back to the feed</Link>
        </p>
      </Page>
    );
  }

  const creator = profile.data;
  const isSelf = creator.isViewer;

  return (
    <Page className="profile">
      <header className="profile__header">
        <Avatar url={creator.avatarUrl} name={creator.displayName} size="lg" />
        <div className="profile__identity">
          <h1 className="profile__name">{creator.displayName}</h1>
          <p className="profile__handle muted">@{creator.handle}</p>
          {creator.bio ? <p className="profile__bio">{creator.bio}</p> : null}
          <p className="profile__joined muted small">Joined {formatDate(creator.createdAt)}</p>
        </div>
        <div className="profile__actions">
          {isSelf ? (
            <>
              <Link className="btn btn--secondary" to="/settings">
                Edit profile
              </Link>
              <Link className="btn btn--primary" to="/create">
                Studio
              </Link>
            </>
          ) : user ? (
            <Button
              variant={creator.viewerFollows ? 'secondary' : 'primary'}
              busy={follow.isPending}
              onClick={() => follow.mutate(!creator.viewerFollows)}
            >
              {creator.viewerFollows ? 'Following' : 'Follow'}
            </Button>
          ) : (
            <Link className="btn btn--primary" to={loginRedirectTarget(`/@${creator.handle}`)}>
              Sign in to follow
            </Link>
          )}
        </div>
      </header>

      {follow.isError ? (
        <p className="form__error" role="alert">
          {describeError(follow.error)}
        </p>
      ) : null}

      <dl className="stats">
        <div className="stats__item">
          <dt>Games</dt>
          <dd>{formatCount(creator.stats.publishedGames)}</dd>
        </div>
        <div className="stats__item">
          <dt>Remixes</dt>
          <dd>{formatCount(creator.stats.remixes)}</dd>
        </div>
        <div className="stats__item">
          <dt>Followers</dt>
          <dd>{formatCount(creator.stats.followers)}</dd>
        </div>
        <div className="stats__item">
          <dt>Following</dt>
          <dd>{formatCount(creator.stats.following)}</dd>
        </div>
        <div className="stats__item">
          <dt>Plays</dt>
          <dd>{formatCount(creator.stats.totalPlays)}</dd>
        </div>
      </dl>

      {published.length > 1 ? (
        <Tabs
          label="Profile listings"
          activeId={tab}
          items={[
            { id: 'games', label: 'Games', to: '?tab=games', badge: originals.length },
            { id: 'remixes', label: 'Remixes', to: '?tab=remixes', badge: remixes.length },
          ]}
        />
      ) : null}

      {games.isPending ? <LoadingScreen label="Loading games" /> : null}
      {games.isError ? <ErrorState error={games.error} onRetry={() => void games.refetch()} /> : null}

      {games.isSuccess && visible.length === 0 ? (
        <EmptyState
          title={tab === 'games' ? 'No published games yet' : 'No remixes yet'}
          description={
            isSelf
              ? 'Publish something from your studio and it shows up here.'
              : 'This creator has nothing in this listing yet.'
          }
          action={
            isSelf ? (
              <Link className="btn btn--primary" to="/create">
                Open the studio
              </Link>
            ) : undefined
          }
        />
      ) : null}

      {visible.length > 0 ? (
        <ul className="tiles">
          {visible.map((game) => (
            <GameTile key={game.id} game={game} />
          ))}
        </ul>
      ) : null}
    </Page>
  );
}
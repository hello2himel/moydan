/**
 * A single game page.
 *
 * Same components as the feed, different composition: here the game gets the
 * whole screen and the metadata sits below it, which is what makes the saved
 * list ("open a game directly into playable mode") and a shared link land on
 * something immediately playable.
 */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getGame, getLineage, getScores } from '../api/catalog.ts';
import { getRemixOptions } from '../api/remix.ts';
import { formatCount, formatDate } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { CommentsSheet } from '../components/CommentsSheet.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { GamePlayer } from '../components/GamePlayer.tsx';
import { LineageView } from '../components/LineageView.tsx';
import { RemixDialog } from '../components/RemixDialog.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';
import { SocialActions } from '../components/SocialActions.tsx';
import { SourcePanel } from '../components/SourcePanel.tsx';

const UNAVAILABLE_NOTES: Record<string, string> = {
  draft: 'This game is still a draft. Only the creator can see it.',
  unpublished: 'The creator has unpublished this game.',
  removed: 'This game has been removed from Moydan.',
  suspended: 'This game has been suspended.',
};

export function GameScreen(): ReactNode {
  const { gameId = '' } = useParams();
  const navigate = useNavigate();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [remixOpen, setRemixOpen] = useState(false);

  const game = useQuery({
    queryKey: queryKeys.game(gameId),
    queryFn: ({ signal }) => getGame(gameId, signal),
    enabled: gameId.length > 0,
  });

  const lineage = useQuery({
    queryKey: queryKeys.lineage(gameId),
    queryFn: ({ signal }) => getLineage(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
  });

  const scores = useQuery({
    queryKey: queryKeys.scores(gameId),
    queryFn: ({ signal }) => getScores(gameId, 10, signal),
    enabled: gameId.length > 0 && Boolean(game.data?.stats.plays),
  });

  const remixOptions = useQuery({
    queryKey: queryKeys.remixOptions(gameId),
    queryFn: ({ signal }) => getRemixOptions(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
    staleTime: 60_000,
  });

  if (game.isPending) return <LoadingScreen label="Loading game" />;
  if (game.isError) {
    return (
      <Page>
        <ErrorState error={game.error} onRetry={() => void game.refetch()} title="This game is unavailable" />
      </Page>
    );
  }

  const card = game.data;
  const playable = card.status === 'published';
  const note = UNAVAILABLE_NOTES[card.status] ?? null;
  const topScores = Array.isArray(scores.data?.items) ? scores.data.items : [];

  return (
    <Page className="game-page">
      <div className="game-page__stage">
        <GamePlayer game={card} onNext={() => navigate('/feed/foryou')} nextLabel="Back to the feed" />
      </div>

      <div className="game-page__body">
        <PageHeader
          title={card.title}
          subtitle={
            <Link className="game-page__creator" to={`/@${card.creator.handle}`}>
              <Avatar url={card.creator.avatarUrl} name={card.creator.displayName} size="xs" />
              {card.creator.displayName} · @{card.creator.handle}
            </Link>
          }
          actions={
            card.owned ? (
              <Link className="btn btn--secondary" to={`/studio/${card.id}`}>
                Open studio
              </Link>
            ) : null
          }
        />

        {note ? (
          <p className="notice notice--warn" role="status">
            {note} {card.owned ? 'You can still open it in your studio.' : ''}
          </p>
        ) : null}

        <p className="prose">{card.description}</p>

        {card.tags.length > 0 ? (
          <ul className="chips">
            {card.tags.map((tag) => (
              <li key={tag} className="chip">
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        <SocialActions
          game={card}
          remixEligible={remixOptions.data?.allowed ?? null}
          onOpenRemix={() => setRemixOpen(true)}
          onOpenComments={() => setCommentsOpen(true)}
          layout="row"
        />

        {!playable && card.owned ? (
          <Button variant="secondary" onClick={() => navigate(`/studio/${card.id}`)}>
            Open the studio
          </Button>
        ) : null}

        <dl className="kv-list">
          <div className="kv">
            <dt className="kv__k">Plays</dt>
            <dd className="kv__v">{formatCount(card.stats.plays)}</dd>
          </div>
          <div className="kv">
            <dt className="kv__k">Published</dt>
            <dd className="kv__v">{formatDate(card.publishedAt)}</dd>
          </div>
          <div className="kv">
            <dt className="kv__k">Remixes</dt>
            <dd className="kv__v">{formatCount(card.stats.remixes)}</dd>
          </div>
        </dl>

        {topScores.length > 0 ? (
          <section className="panel">
            <h2 className="panel__title">Top scores</h2>
            <ol className="scores">
              {topScores.map((score) => (
                <li key={score.id} className="scores__row">
                  <span className="scores__value">
                    {score.value} {score.unit}
                  </span>
                  <span className="muted small">
                    {score.player ? `@${score.player.handle}` : 'anonymous'}
                    {score.difficulty ? ` · ${score.difficulty}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <SourcePanel game={card} />

        <LineageView
          game={card}
          origin={lineage.data?.origin ?? card.remixOrigin}
          ancestors={lineage.data?.ancestors ?? []}
        />
      </div>

      <CommentsSheet game={card} open={commentsOpen} onClose={() => setCommentsOpen(false)} />
      <RemixDialog game={card} open={remixOpen} onClose={() => setRemixOpen(false)} />
    </Page>
  );
}
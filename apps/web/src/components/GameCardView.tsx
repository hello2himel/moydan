/**
 * A single playable feed item.
 *
 * Layout rule for this whole component: the game owns the top of the screen and
 * the metadata sits *below* it in its own strip. Nothing is drawn on top of the
 * running game, so a full-screen game is genuinely full-screen; everything the
 * card has to say beyond the title lives in the details sheet.
 */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { GameCard } from '@moydan/core';
import { getLineage } from '../api/catalog.ts';
import { getRemixOptions } from '../api/remix.ts';
import { formatCount, formatRelativeTime } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useIntersectionRatio, useInView } from '../lib/useInView.ts';
import { Avatar } from './Avatar.tsx';
import { Button } from './Button.tsx';
import { CommentsSheet } from './CommentsSheet.tsx';
import { GamePlayer } from './GamePlayer.tsx';
import { LineageView } from './LineageView.tsx';
import { RemixDialog } from './RemixDialog.tsx';
import { Sheet } from './Sheet.tsx';
import { SocialActions } from './SocialActions.tsx';
import { SourcePanel } from './SourcePanel.tsx';

export interface GameCardViewProps {
  game: GameCard;
  onNext?: (() => void) | undefined;
}

export function GameCardView({ game, onNext }: GameCardViewProps): ReactNode {
  const rootRef = useIntersectionRatio<HTMLDivElement>(0.6);
  const isActive = rootRef.ratio >= 0.6;
  // An iframe is expensive: only mount the player once the card has been near
  // the viewport, but keep it mounted afterwards so scrolling back is instant.
  const seen = useInView<HTMLDivElement>({ threshold: 0.05, once: true, fallbackAfterMs: 400 });

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [remixOpen, setRemixOpen] = useState(false);

  // Eligibility is only checked for the card the viewer is actually looking at.
  const remixOptions = useQuery({
    queryKey: queryKeys.remixOptions(game.id),
    queryFn: ({ signal }) => getRemixOptions(game.id, signal),
    enabled: isActive,
    staleTime: 5 * 60_000,
  });

  const lineage = useQuery({
    queryKey: queryKeys.lineage(game.id),
    queryFn: ({ signal }) => getLineage(game.id, signal),
    enabled: detailsOpen,
    staleTime: 5 * 60_000,
  });

  const unplayable = !game.release;

  return (
    <article className="feed-item" ref={rootRef.ref} aria-label={game.title}>
      <div className="feed-item__stage" ref={seen.ref}>
        {seen.inView ? (
          <GamePlayer game={game} compact onNext={onNext} nextLabel="Next game" />
        ) : (
          <div className="feed-item__placeholder" aria-hidden="true" />
        )}
      </div>

      <div className="feed-item__meta">
        <div className="feed-item__headline">
          <Link className="feed-item__title" to={`/games/${game.id}`}>
            {game.title}
          </Link>
          <p className="feed-item__description">{game.description}</p>
        </div>

        <SocialActions
          game={game}
          remixEligible={remixOptions.data?.allowed ?? null}
          onOpenRemix={() => setRemixOpen(true)}
          onOpenComments={() => setCommentsOpen(true)}
          layout="row"
        />

        <div className="feed-item__toolbar">
          <Button variant="ghost" className="feed-item__details-btn" onClick={() => setDetailsOpen(true)}>
            Details
          </Button>
          <span className="feed-item__stats muted small">
            {formatCount(game.stats.plays)} plays &middot; {formatCount(game.stats.saves)} saves &middot;{' '}
            {formatRelativeTime(game.publishedAt ?? game.createdAt)}
          </span>
        </div>

        {unplayable ? (
          <p className="notice notice--warn" role="status">
            This game has no published release yet, so it cannot be played.
          </p>
        ) : null}
      </div>

      <Sheet
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={game.title}
        description={`by @${game.creator.handle}`}
      >
        <div className="stack">
          <p className="prose">{game.description}</p>

          <div className="feed-item__creator">
            <Avatar url={game.creator.avatarUrl} name={game.creator.displayName} size="sm" />
            <div>
              <p className="strong">{game.creator.displayName}</p>
              <p className="muted small">@{game.creator.handle}</p>
            </div>
          </div>

          {game.tags.length > 0 ? (
            <ul className="chips">
              {game.tags.map((tag) => (
                <li key={tag} className="chip">
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}

          <dl className="kv-list">
            <div className="kv">
              <dt className="kv__k">Plays</dt>
              <dd className="kv__v">{formatCount(game.stats.plays)}</dd>
            </div>
            <div className="kv">
              <dt className="kv__k">Reactions</dt>
              <dd className="kv__v">{formatCount(game.stats.reactions)}</dd>
            </div>
            <div className="kv">
              <dt className="kv__k">Remixes</dt>
              <dd className="kv__v">{formatCount(game.stats.remixes)}</dd>
            </div>
            <div className="kv">
              <dt className="kv__k">Published</dt>
              <dd className="kv__v">{formatRelativeTime(game.publishedAt ?? game.createdAt)}</dd>
            </div>
          </dl>

          <SourcePanel game={game} />

          <LineageView
            game={game}
            origin={lineage.data?.origin ?? game.remixOrigin}
            ancestors={lineage.data?.ancestors ?? []}
          />
        </div>
      </Sheet>

      <CommentsSheet game={game} open={commentsOpen} onClose={() => setCommentsOpen(false)} />

      <RemixDialog game={game} open={remixOpen} onClose={() => setRemixOpen(false)} />
    </article>
  );
}
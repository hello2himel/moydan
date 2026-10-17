/**
 * Social controls for a game: react, save, comment, share, follow, remix.
 *
 * Every interaction here is optimistic and reversible. The feed has to feel
 * instant, but a wrong count is worse than a late one, so each mutation writes
 * the expected state, rolls it back verbatim on failure and then reconciles
 * with whatever the server says.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { GameCard } from '@moydan/core';
import {
  createShareLink,
  followCreator,
  REACTION_TYPES,
  saveGame,
  setReaction,
  unfollowCreator,
  unsaveGame,
  clearReaction,
  type ReactionType,
} from '../api/social.ts';
import { describeError } from '../api/client.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { loginRedirectTarget } from '../session/useRequireAuth.ts';
import { patchGameEverywhere, queryKeys } from '../lib/queryKeys.ts';
import { formatCount } from '../lib/format.ts';
import { Button, IconButton } from './Button.tsx';
import { Avatar } from './Avatar.tsx';

const REACTION_GLYPHS: Record<ReactionType, string> = {
  like: '👍',
  love: '❤️',
  fire: '🔥',
  wow: '😮',
};

const REACTION_LABELS: Record<ReactionType, string> = {
  like: 'Like',
  love: 'Love',
  fire: 'Fire',
  wow: 'Wow',
};

export interface SocialActionsProps {
  game: GameCard;
  /** `null` means "eligibility not checked yet"; the control stays hidden. */
  remixEligible?: boolean | null;
  onOpenRemix?: (() => void) | undefined;
  onOpenComments?: (() => void) | undefined;
  /** Feed cards stack the actions next to the creator row. */
  layout?: 'row' | 'stack';
  className?: string;
}

export function SocialActions({
  game,
  remixEligible = null,
  onOpenRemix,
  onOpenComments,
  layout = 'row',
  className,
}: SocialActionsProps): ReactNode {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const requireViewer = useCallback(
    (action: () => void) => {
      if (!user) {
        navigate(loginRedirectTarget(`${location.pathname}${location.search}`));
        return;
      }
      action();
    },
    [user, navigate, location.pathname, location.search],
  );

  const announce = useCallback((message: string) => {
    setNote(message);
    window.setTimeout(() => setNote(null), 2500);
  }, []);

  const reaction = useMutation({
    mutationFn: (type: ReactionType | null) => (type ? setReaction(game.id, type) : clearReaction(game.id)),
    onMutate: async (type) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.game(game.id) });
      patchGameEverywhere(queryClient, game.id, (card) => {
        const previous = card.viewer.reacted;
        const delta = type === previous ? 0 : type ? 1 : -1;
        return {
          ...card,
          viewer: { ...card.viewer, reacted: type },
          stats: { ...card.stats, reactions: Math.max(0, card.stats.reactions + delta) },
        };
      });
    },
    onError: (_error, type) => {
      patchGameEverywhere(queryClient, game.id, (card) => {
        const delta = type ? 1 : -1;
        return {
          ...card,
          viewer: { ...card.viewer, reacted: null },
          stats: { ...card.stats, reactions: Math.max(0, card.stats.reactions - delta) },
        };
      });
      announce('That reaction did not stick.');
    },
    onSuccess: (result) => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, reacted: result.reacted },
        stats: { ...card.stats, reactions: result.reactions },
      }));
    },
  });

  const save = useMutation({
    mutationFn: (saved: boolean) => (saved ? saveGame(game.id) : unsaveGame(game.id)),
    onMutate: async (saved) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.saved });
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, saved },
        stats: { ...card.stats, saves: Math.max(0, card.stats.saves + (saved ? 1 : -1)) },
      }));
    },
    onError: (_error, saved) => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, saved: !saved },
        stats: { ...card.stats, saves: Math.max(0, card.stats.saves + (saved ? -1 : 1)) },
      }));
      announce('That did not stick.');
    },
    onSuccess: (result) => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, saved: result.saved },
        stats: { ...card.stats, saves: result.saves },
      }));
    },
  });

  const follow = useMutation({
    mutationFn: (following: boolean) =>
      following ? followCreator(game.creator.handle) : unfollowCreator(game.creator.handle),
    onMutate: async (following) => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, following },
      }));
    },
    onError: (caught) => {
      announce(describeError(caught));
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, following: !game.viewer.following },
      }));
    },
    onSuccess: (result) => {
      patchGameEverywhere(queryClient, game.id, (card) => ({
        ...card,
        viewer: { ...card.viewer, following: result.following },
      }));
    },
  });

  const share = useMutation({
    mutationFn: () => createShareLink(game.id),
    onSuccess: async (link) => {
      try {
        if (typeof navigator.share === 'function') {
          await navigator.share({ title: link.title || game.title, url: link.url });
          announce('Shared.');
        } else {
          await navigator.clipboard.writeText(link.url);
          announce('Link copied to your clipboard.');
        }
      } catch {
        announce('Sharing was cancelled.');
      }
    },
    onError: (caught) => announce(describeError(caught)),
  });

  const reacted = game.viewer.reacted as ReactionType | null;
  const isOwn = game.owned;

  const classes = ['social', `social--${layout}`];
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')}>
      <div className="social__group">
        <div className="social__picker">
          <button
            type="button"
            className={reacted ? 'social__btn social__btn--on' : 'social__btn'}
            aria-label={reacted ? `Remove your ${REACTION_LABELS[reacted]}` : 'React to this game'}
            aria-expanded={pickerOpen}
            onClick={() =>
              requireViewer(() => {
                if (reacted) reaction.mutate(null);
                else setPickerOpen((open) => !open);
              })
            }
          >
            <span className="social__glyph" aria-hidden="true">
              {reacted ? REACTION_GLYPHS[reacted] : '👍'}
            </span>
            <span className="social__count">{formatCount(game.stats.reactions)}</span>
          </button>
          {pickerOpen ? (
            <div className="social__options" role="group" aria-label="Choose a reaction">
              {REACTION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={reacted === type ? 'social__option social__option--on' : 'social__option'}
                  aria-label={REACTION_LABELS[type]}
                  onClick={() => {
                    setPickerOpen(false);
                    reaction.mutate(type);
                  }}
                >
                  <span aria-hidden="true">{REACTION_GLYPHS[type]}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <IconButton
          label={game.viewer.saved ? 'Remove from saved' : 'Save this game'}
          variant="ghost"
          className={game.viewer.saved ? 'social__icon social__icon--on' : 'social__icon'}
          busy={save.isPending}
          onClick={() => requireViewer(() => save.mutate(!game.viewer.saved))}
        >
          {game.viewer.saved ? '★' : '☆'}
        </IconButton>

        <button
          type="button"
          className="social__btn"
          aria-label={`Comments (${game.stats.comments})`}
          disabled={!onOpenComments}
          onClick={onOpenComments}
        >
          <span className="social__glyph" aria-hidden="true">
            💬
          </span>
          <span className="social__count">{formatCount(game.stats.comments)}</span>
        </button>

        <IconButton
          label="Share this game"
          variant="ghost"
          className="social__icon"
          busy={share.isPending}
          onClick={() => requireViewer(() => share.mutate())}
        >
          ↗
        </IconButton>

        {remixEligible && onOpenRemix ? (
          <IconButton
            label="Remix this game"
            variant="ghost"
            className="social__icon"
            onClick={() => requireViewer(onOpenRemix)}
          >
            ⎘
          </IconButton>
        ) : null}
      </div>

      <div className="social__group social__group--creator">
        <Link className="social__creator" to={`/@${game.creator.handle}`}>
          <Avatar url={game.creator.avatarUrl} name={game.creator.displayName} size="xs" />
          <span className="social__handle">@{game.creator.handle}</span>
        </Link>
        {!isOwn ? (
          <Button
            variant={game.viewer.following ? 'ghost' : 'secondary'}
            className="social__follow"
            busy={follow.isPending}
            onClick={() => requireViewer(() => follow.mutate(!game.viewer.following))}
          >
            {game.viewer.following ? 'Following' : 'Follow'}
          </Button>
        ) : null}
      </div>

      <p className="social__note" role="status" aria-live="polite">
        {note ?? ''}
      </p>
    </div>
  );
}
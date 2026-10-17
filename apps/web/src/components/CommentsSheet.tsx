/**
 * Comments sheet.
 *
 * Comment bodies are rendered as plain text nodes, never as HTML: a comment is
 * untrusted user input and the app origin must never execute it. Removed and
 * hidden comments render as a tombstone rather than disappearing, because the
 * reply tree around them still exists.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Comment, GameCard } from '@moydan/core';
import {
  createComment,
  deleteComment,
  getComments,
  updateComment,
} from '../api/social.ts';
import { describeError } from '../api/client.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { loginRedirectTarget } from '../session/useRequireAuth.ts';
import { useInView } from '../lib/useInView.ts';
import { formatRelativeTime } from '../lib/format.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { Avatar } from './Avatar.tsx';
import { Button } from './Button.tsx';
import { EmptyState } from './EmptyState.tsx';
import { ErrorState } from './ErrorState.tsx';
import { Sheet } from './Sheet.tsx';
import { Skeleton } from './Skeleton.tsx';

const PAGE_SIZE = 20;

export interface CommentsSheetProps {
  game: GameCard;
  open: boolean;
  onClose: () => void;
}

function CommentComposer({
  gameId,
  parentId,
  onDone,
  autoFocus = false,
  compact = false,
}: {
  gameId: string;
  parentId?: string | null;
  onDone?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}): ReactNode {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => createComment(gameId, text, parentId ?? null),
    onSuccess: () => {
      setBody('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['comments', gameId] });
      onDone?.();
    },
    onError: (caught) => setError(describeError(caught)),
  });

  if (!user) {
    return (
      <p className="muted">
        <Link to={loginRedirectTarget(`/games/${gameId}`)}>Sign in</Link> to join the conversation.
      </p>
    );
  }

  return (
    <form
      className={compact ? 'composer composer--compact' : 'composer'}
      onSubmit={(event) => {
        event.preventDefault();
        const text = body.trim();
        if (text.length === 0) return;
        mutation.mutate(text);
      }}
    >
      <label className="field">
        <span className="field__label">{parentId ? 'Your reply' : 'Add a comment'}</span>
        <textarea
          className="textarea"
          value={body}
          maxLength={2000}
          rows={compact ? 2 : 3}
          autoFocus={autoFocus}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Be kind. Plain text only."
        />
      </label>
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="primary" type="submit" busy={mutation.isPending} disabled={body.trim().length === 0}>
        Post
      </Button>
    </form>
  );
}

function CommentItem({
  comment,
  gameId,
  depth = 0,
}: {
  comment: Comment;
  gameId: string;
  depth?: number;
}): ReactNode {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [showReplies, setShowReplies] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replies = useQuery({
    queryKey: queryKeys.comments(gameId, comment.id),
    queryFn: ({ signal }) => getComments(gameId, { parentId: comment.id, limit: PAGE_SIZE }, signal),
    enabled: showReplies,
  });

  const save = useMutation({
    mutationFn: (body: string) => updateComment(comment.id, body),
    onSuccess: (updated) => {
      setEditing(false);
      setError(null);
      queryClient.setQueryData<PaginatedComments>(queryKeys.comments(gameId, 'root'), (previous) =>
        replaceComment(previous, updated),
      );
      void queryClient.invalidateQueries({ queryKey: ['comments', gameId] });
    },
    onError: (caught) => setError(describeError(caught)),
  });

  const remove = useMutation({
    mutationFn: () => deleteComment(comment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments', gameId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.game(gameId) });
    },
    onError: (caught) => setError(describeError(caught)),
  });

  if (comment.removed || comment.hidden) {
    return (
      <li className="comment comment--tombstone">
        <p className="muted">{comment.removed ? 'This comment was deleted.' : 'This comment is hidden.'}</p>
      </li>
    );
  }

  return (
    <li className={depth > 0 ? 'comment comment--reply' : 'comment'}>
      <div className="comment__row">
        <Link to={`/@${comment.author.handle}`}>
          <Avatar url={comment.author.avatarUrl} name={comment.author.displayName} size="sm" />
        </Link>
        <div className="comment__body">
          <p className="comment__meta">
            <Link to={`/@${comment.author.handle}`}>@{comment.author.handle}</Link>
            <span className="muted"> &middot; {formatRelativeTime(comment.createdAt)}</span>
            {comment.edited ? <span className="muted"> &middot; edited</span> : null}
          </p>
          {editing ? (
            <form
              className="comment__edit"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim().length === 0) return;
                save.mutate(draft.trim());
              }}
            >
              <textarea
                className="textarea"
                value={draft}
                rows={3}
                maxLength={2000}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="row">
                <Button variant="primary" type="submit" busy={save.isPending}>
                  Save
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(comment.body);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className="comment__text">{comment.body}</p>
          )}

          {error ? (
            <p className="form__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="comment__actions">
            {comment.viewerCanEdit && !editing ? (
              <button type="button" className="linkbtn" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            {comment.viewerCanDelete ? (
              <button type="button" className="linkbtn" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete
              </button>
            ) : null}
            {depth === 0 ? (
              <button
                type="button"
                className="linkbtn"
                onClick={() => setShowReplies((value) => !value)}
                aria-expanded={showReplies}
              >
                {showReplies ? 'Hide replies' : `Replies (${comment.replyCount})`}
              </button>
            ) : null}
          </div>

          {showReplies ? (
            <div className="comment__replies">
              {replies.isPending ? <Skeleton variant="line" width="60%" /> : null}
              {replies.isError ? <ErrorState error={replies.error} onRetry={() => void replies.refetch()} /> : null}
              {replies.data ? (
                <ul className="comment__list">
                  {replies.data.items.map((reply) => (
                    <CommentItem key={reply.id} comment={reply} gameId={gameId} depth={depth + 1} />
                  ))}
                </ul>
              ) : null}
              {showReplies && comment.replyCount > 0 ? (
                <CommentComposer gameId={gameId} parentId={comment.id} compact />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Local alias so the cache write below stays readable. */
type PaginatedComments = { items: Comment[]; nextCursor: string | null; total: number | null };

function replaceComment(page: PaginatedComments | undefined, updated: Comment): PaginatedComments | undefined {
  if (!page) return page;
  return {
    ...page,
    items: page.items.map((comment) => (comment.id === updated.id ? updated : comment)),
  };
}

export function CommentsSheet({ game, open, onClose }: CommentsSheetProps): ReactNode {
  const [showComposer, setShowComposer] = useState(false);
  const { ref: sentinelRef, inView: sentinelVisible } = useInView<HTMLDivElement>({
    threshold: 0,
    rootMargin: '240px',
  });

  const comments = useInfiniteQuery({
    queryKey: queryKeys.comments(game.id, 'root'),
    queryFn: ({ pageParam, signal }) => getComments(game.id, { cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: open,
    staleTime: 15_000,
  });

  const items = useMemo(() => comments.data?.pages.flatMap((page) => page.items) ?? [], [comments.data]);

  const loadMore = useCallback(() => {
    if (comments.hasNextPage && !comments.isFetchingNextPage) void comments.fetchNextPage();
  }, [comments]);

  useEffect(() => {
    if (sentinelVisible) loadMore();
  }, [sentinelVisible, loadMore]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Comments"
      description={`${game.stats.comments} on ${game.title}`}
      headerAside={
        <Button variant={showComposer ? 'ghost' : 'primary'} onClick={() => setShowComposer((value) => !value)}>
          {showComposer ? 'Cancel' : 'Comment'}
        </Button>
      }
    >
      {showComposer ? (
        <div className="sheet__composer">
          <CommentComposer gameId={game.id} onDone={() => setShowComposer(false)} />
        </div>
      ) : null}

      {comments.isPending ? (
        <ul className="comment__list">
          {[0, 1, 2].map((index) => (
            <li key={index} className="comment">
              <Skeleton variant="line" width="70%" />
              <Skeleton variant="line" width="45%" />
            </li>
          ))}
        </ul>
      ) : null}

      {comments.isError ? (
        <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />
      ) : null}

      {comments.isSuccess && items.length === 0 ? (
        <EmptyState
          title="No comments yet"
          description="Be the first to say something about this game."
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="comment__list">
          {items.map((comment) => (
            <CommentItem key={comment.id} comment={comment} gameId={game.id} />
          ))}
        </ul>
      ) : null}

      <div ref={sentinelRef} className="sheet__sentinel">
        {comments.hasNextPage ? (
          <Button variant="ghost" onClick={loadMore} busy={comments.isFetchingNextPage}>
            Load more comments
          </Button>
        ) : items.length > 0 ? (
          <p className="muted small">That is every comment.</p>
        ) : null}
      </div>
    </Sheet>
  );
}
/**
 * Dedicated remix flow (`/remix/:gameId`).
 *
 * The feed offers remixing through a dialog; this route is the same decision
 * with room to explain it, reached when someone shares a remix link directly.
 * It needs an account (a remix is a project), so the guard runs first and the
 * creator is sent to sign in and returned here.
 */

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { getGame } from '../api/catalog.ts';
import { getRemixOptions } from '../api/remix.ts';
import { queryKeys } from '../lib/queryKeys.ts';
import { useRequireAuth } from '../session/useRequireAuth.ts';
import { Page, PageHeader } from '../components/AppShell.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Button } from '../components/Button.tsx';
import { ErrorState } from '../components/ErrorState.tsx';
import { LineageView } from '../components/LineageView.tsx';
import { LoadingScreen } from '../components/Skeleton.tsx';
import { RemixDialog } from '../components/RemixDialog.tsx';
import { SourcePanel } from '../components/SourcePanel.tsx';

export function RemixScreen(): ReactNode {
  const { gameId = '' } = useParams();
  const { isPending: authPending } = useRequireAuth();
  const [dialogOpen, setDialogOpen] = useState(true);

  const game = useQuery({
    queryKey: queryKeys.game(gameId),
    queryFn: ({ signal }) => getGame(gameId, signal),
    enabled: gameId.length > 0,
  });

  const options = useQuery({
    queryKey: queryKeys.remixOptions(gameId),
    queryFn: ({ signal }) => getRemixOptions(gameId, signal),
    enabled: gameId.length > 0 && Boolean(game.data),
  });

  if (authPending) {
    return (
      <Page>
        <p className="muted">Taking you to sign in…</p>
      </Page>
    );
  }

  if (game.isPending) return <LoadingScreen label="Loading game" />;
  if (game.isError) {
    return (
      <Page>
        <ErrorState error={game.error} onRetry={() => void game.refetch()} title="This game is unavailable" />
      </Page>
    );
  }

  const card = game.data;
  const allowed = options.data?.allowed ?? false;

  return (
    <Page>
      <PageHeader
        title="Remix"
        subtitle={
          <>
            <span className="muted">A derivative work of </span>
            <Link to={`/games/${card.id}`}>{card.title}</Link>
            <span className="muted"> by </span>
            <Link to={`/@${card.creator.handle}`}>@{card.creator.handle}</Link>
          </>
        }
      />

      <div className="remix-intro">
        <Avatar url={card.creator.avatarUrl} name={card.creator.displayName} size="md" />
        <div>
          <p className="strong">{card.creator.displayName}</p>
          <p className="muted small">@{card.creator.handle}</p>
        </div>
      </div>

      <p className="prose">
        Remixing copies the original into a project of your own. The original licence keeps applying to your
        derivative work, so Moydan only offers the licences the creator&apos;s licence allows.
      </p>

      {allowed ? (
        <div className="row">
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            Open the remix editor
          </Button>
          <Link className="btn btn--ghost" to={`/games/${card.id}`}>
            Play it first
          </Link>
        </div>
      ) : (
        <p className="notice notice--warn" role="status">
          {options.data?.reason ?? 'This game cannot be remixed.'}
        </p>
      )}

      <SourcePanel game={card} />
      <LineageView game={card} origin={card.remixOrigin} ancestors={[]} />

      <RemixDialog game={card} open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </Page>
  );
}
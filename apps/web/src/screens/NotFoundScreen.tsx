/**
 * 404.
 *
 * Moydan has many entry points (shared game links, remix links, handles), so a
 * dead one is expected traffic rather than an exceptional condition. Offer the
 * feed and the studio instead of a bare error.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/AppShell.tsx';
import { EmptyState } from '../components/EmptyState.tsx';

export function NotFoundScreen(): ReactNode {
  return (
    <Page>
      <EmptyState
        title="This page does not exist"
        description="The link may be wrong, or the game it pointed at was removed."
        action={
          <div className="row">
            <Link className="btn btn--primary" to="/feed/foryou">
              Browse games
            </Link>
            <Link className="btn btn--ghost" to="/create">
              Open the studio
            </Link>
          </div>
        }
      />
    </Page>
  );
}
/**
 * Route level error boundary.
 *
 * A render crash must never leave the viewer on a blank page with a broken
 * navigation. This shows what happened, offers to try the render again, and
 * keeps a way back to the feed. Query failures are handled per screen with
 * `ErrorState`; this is the last line of defence.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button } from './Button.tsx';

interface ErrorBoundaryState {
  error: unknown;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      // Development only: production must not leak stacks or internals.
      console.error('[moydan] render error', error, info.componentStack);
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="state state--error page" role="alert">
          <h1 className="state__title">Moydan could not show this page</h1>
          <p className="state__text">
            Something failed while rendering. Reloading usually fixes it; if it keeps happening the API may be
            unavailable.
          </p>
          <div className="state__action row">
            <Button variant="primary" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
            <Link className="linkbtn" to="/feed/foryou">
              Back to the feed
            </Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Same treatment for router level failures (`errorElement`). */
export function RouteErrorBoundary(): ReactNode {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected routing failure.';
  return (
    <div className="page">
      <ErrorBoundaryShim message={message} />
    </div>
  );
}

function ErrorBoundaryShim({ message }: { message: string }): ReactNode {
  return (
    <div className="state state--error" role="alert">
      <h1 className="state__title">This page could not be loaded</h1>
      <p className="state__text">{message}</p>
      <div className="state__action row">
        <Button variant="primary" onClick={() => window.location.assign('/feed/foryou')}>
          Back to the feed
        </Button>
      </div>
    </div>
  );
}
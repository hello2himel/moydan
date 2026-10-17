/**
 * Recoverable failure surface.
 *
 * Every screen that can fail shows this instead of blank space. It always names
 * the failure (the API message is written for humans) and always offers a retry
 * when retrying could plausibly work: a rate limit, a dropped connection or a
 * 5xx, but not a 404.
 */

import type { ReactNode } from 'react';
import { describeError, isApiError } from '../api/client.ts';
import { Button } from './Button.tsx';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: (() => void) | undefined;
  title?: string;
  /** Extra guidance rendered under the message. */
  hint?: ReactNode;
}

export function ErrorState({ error, onRetry, title, hint }: ErrorStateProps): ReactNode {
  const apiError = isApiError(error) ? error : null;
  const retryable = Boolean(onRetry) && (apiError ? apiError.status !== 404 : true);
  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title ?? (apiError?.code === 'not_found' ? 'Not found' : 'Something went wrong')}</h2>
      <p className="state__text">{describeError(error)}</p>
      {hint ? <p className="state__text">{hint}</p> : null}
      {retryable ? (
        <div className="state__action">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
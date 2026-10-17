/**
 * Empty state.
 *
 * An empty list is a normal outcome (nobody follows anyone yet, no games
 * saved), never an error, so it gets an explanation and exactly one way out.
 */

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps): ReactNode {
  return (
    <div className="state state--empty">
      {icon ? (
        <div className="state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h2 className="state__title">{title}</h2>
      {description ? <p className="state__text">{description}</p> : null}
      {action ? <div className="state__action">{action}</div> : null}
    </div>
  );
}
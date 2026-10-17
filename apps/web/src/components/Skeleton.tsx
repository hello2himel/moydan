/**
 * Loading placeholder.
 *
 * Skeletons mirror the shape of what is loading (a feed card, a line of text)
 * so the layout does not jump when real content arrives. They are hidden from
 * assistive technology because the surrounding region already announces its
 * busy state.
 */

import type { ReactNode } from 'react';

export type SkeletonVariant = 'line' | 'block' | 'circle' | 'card' | 'feed';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string;
  height?: string;
  label?: string;
}

export function Skeleton({ variant = 'line', width, height, label = 'Loading' }: SkeletonProps): ReactNode {
  const style = width || height ? { width, height } : undefined;
  return (
    <span
      className={`sk sk--${variant}`}
      style={style}
      role="status"
      aria-label={label}
      aria-hidden="true"
    />
  );
}

/** Full-viewport loading state used while a screen resolves its first query. */
export function LoadingScreen({ label = 'Loading' }: { label?: string }): ReactNode {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <span className="loading-screen__spinner" aria-hidden="true" />
      <p className="muted">{label}</p>
    </div>
  );
}
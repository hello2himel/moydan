/**
 * Playback policy for a game embedded in a scrollable feed.
 *
 * Exactly one game plays at a time. A card becomes active when it occupies
 * enough of the viewport and the tab is visible; leaving either condition pauses
 * it instead of tearing the iframe down, so scrolling back is instant.
 */

import type { GameHost } from './host.ts';

export interface PlaybackOptions {
  /** Fraction of the card that must be visible for it to play. Default 0.6. */
  threshold?: number;
  /** Start muted. Feed playback always starts muted until the viewer unmutes. */
  muted?: boolean;
  /**
   * How long to wait for the first IntersectionObserver callback before falling
   * back to a layout measurement. Default 500 ms; set to 0 to disable.
   */
  fallbackAfterMs?: number;
}

export interface PlaybackController {
  /** Called by the observer with the visible ratio. */
  update(ratio: number): void;
  setUserMuted(muted: boolean): void;
  isUserMuted(): boolean;
  /** Force playback regardless of intersection (used by a detail page). */
  setForeground(foreground: boolean): void;
  dispose(): void;
}

export function createPlaybackController(host: GameHost, options: PlaybackOptions = {}): PlaybackController {
  const threshold = options.threshold ?? 0.6;
  let userMuted = options.muted ?? true;
  let ratio = 0;
  let pageVisible = typeof document === 'undefined' ? true : document.visibilityState === 'visible';
  let foreground = false;
  let active = false;
  let disposed = false;

  const apply = (): void => {
    if (disposed) return;
    const shouldPlay = (ratio >= threshold && pageVisible) || foreground;
    if (shouldPlay && !active) {
      active = true;
      if (host.state === 'idle') {
        host.start();
        host.setMuted(userMuted);
      } else if (host.state === 'paused') {
        host.resume();
      }
    } else if (!shouldPlay && active) {
      active = false;
      if (host.state === 'running') host.pause();
    }
  };

  host.setMuted(userMuted);

  const onVisibility = (): void => {
    pageVisible = document.visibilityState === 'visible';
    apply();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    update(nextRatio: number) {
      ratio = nextRatio;
      apply();
    },
    setUserMuted(muted: boolean) {
      userMuted = muted;
      host.setMuted(muted);
    },
    isUserMuted() {
      return userMuted;
    },
    setForeground(value: boolean) {
      foreground = value;
      apply();
    },
    dispose() {
      disposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/**
 * Wire a controller to an element. Returns a dispose function.
 *
 * `IntersectionObserver` is the primary signal, but it is not reliable enough to
 * be the only one: some embedded webviews, background windows and headless
 * renderers accept `observe()` and then never deliver a callback, which would
 * leave the feed stuck on "loading" forever with no game running. A geometry
 * check therefore runs once shortly after attaching, and the scroll/resize
 * fallback stays installed until the observer proves it works.
 */
export function observePlayback(host: GameHost, element: HTMLElement, options: PlaybackOptions = {}): () => void {
  const controller = createPlaybackController(host, options);
  let observer: IntersectionObserver | null = null;
  let disposed = false;
  let observerReported = false;

  const measure = (): void => {
    if (disposed) return;
    const rect = element.getBoundingClientRect();
    const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    controller.update(rect.height > 0 ? visible / rect.height : 0);
  };

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        observerReported = true;
        for (const entry of entries) {
          if (entry.target === element) controller.update(entry.intersectionRatio);
        }
      },
      { threshold: [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1] },
    );
    observer.observe(element);
    // If the observer has not spoken by now, take the layout engine's word for
    // it and keep the scroll/resize checks armed as a backstop.
    const fallback = setTimeout(() => {
      if (!observerReported && !disposed) {
        measure();
        window.addEventListener('scroll', measure, { passive: true });
        window.addEventListener('resize', measure);
      }
    }, options.fallbackAfterMs ?? 500);
    return () => {
      disposed = true;
      clearTimeout(fallback);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      controller.dispose();
    };
  }

  measure();
  window.addEventListener('scroll', measure, { passive: true });
  window.addEventListener('resize', measure);
  return () => {
    disposed = true;
    window.removeEventListener('scroll', measure);
    window.removeEventListener('resize', measure);
    controller.dispose();
  };
}

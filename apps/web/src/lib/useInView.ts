/**
 * Visibility helper.
 *
 * The feed needs to know which card occupies the viewport (that is the only one
 * allowed to play) and when to fetch the next page. Both are the same
 * IntersectionObserver question, so they share one hook instead of two
 * hand-rolled observers per component.
 */

import { useEffect, useRef, useState } from 'react';

export interface InViewOptions {
  /** Fraction of the element that must be visible for `inView` to be true. */
  threshold?: number;
  /** Stop observing after the first intersection. */
  once?: boolean;
  rootMargin?: string;
  /**
   * Escape hatch for environments where `IntersectionObserver` exists but never
   * delivers a callback (some embedded webviews, background tabs, headless
   * renderers). Without it the feed would show placeholders forever and no game
   * would ever start. When set, a manual geometry check runs this long after the
   * observer is attached if it has not reported yet.
   */
  fallbackAfterMs?: number;
}

/** Fraction of `rect` that sits inside the viewport, ignoring zero-size rects. */
function visibleRatio(rect: DOMRect): number {
  const height = rect.height || window.innerHeight;
  const width = rect.width || window.innerWidth;
  if (height <= 0 || width <= 0) return 0;
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  if (bottom <= top || right <= left) return 0;
  return ((bottom - top) * (right - left)) / (height * width);
}

/** Returns a ref callback plus the current visibility flag. */
export function useInView<T extends Element>(options: InViewOptions = {}): {
  ref: (node: T | null) => void;
  inView: boolean;
} {
  const { threshold = 0.6, once = false, rootMargin, fallbackAfterMs = 0 } = options;
  const [inView, setInView] = useState(false);
  const nodeRef = useRef<T | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ref = (node: T | null): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    nodeRef.current = node;
    if (!node) return;

    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            setInView(entry.intersectionRatio >= threshold);
            if (once && entry.isIntersecting) {
              observer.disconnect();
              return;
            }
          }
        },
        { threshold, rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    }

    if (fallbackAfterMs > 0) {
      timerRef.current = setTimeout(() => {
        const current = nodeRef.current;
        if (!current) return;
        setInView(visibleRatio(current.getBoundingClientRect()) >= threshold);
      }, fallbackAfterMs);
    }
  };

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { ref, inView };
}

/**
 * Same as `useInView` but reports the raw ratio, which is what the runtime
 * playback controller wants (`observePlayback` drives its own observer, so this
 * is only used to mark the *foreground* card).
 */
export function useIntersectionRatio<T extends Element>(threshold: number): {
  ref: (node: T | null) => void;
  ratio: number;
} {
  const [ratio, setRatio] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = (node: T | null): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setRatio(entry.intersectionRatio);
      },
      { threshold },
    );
    observer.observe(node);
    observerRef.current = observer;
  };

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, ratio };
}
/**
 * Dialog and sheet accessibility helpers.
 *
 * A modal that does not trap focus is a modal that leaks the reader into the
 * page behind it. Both the sheet and the dialog use the same two utilities so
 * escape handling and focus restoration can never drift apart.
 */

import { useEffect } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
  );
}

/** Keep Tab inside `container` and return a cleanup function. */
export function trapFocus(container: HTMLElement, activeElement: Element | null): () => void {
  const previous = activeElement instanceof HTMLElement ? activeElement : null;
  const initial = focusableElements(container)[0] ?? container;
  initial.focus({ preventScroll: true });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(container);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === container)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeyDown);
  return () => {
    container.removeEventListener('keydown', onKeyDown);
    previous?.focus({ preventScroll: true });
  };
}

/** Close on Escape while `active`. */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onEscape]);
}

/** Lock body scrolling while a full-screen overlay is open. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
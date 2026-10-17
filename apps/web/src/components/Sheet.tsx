/**
 * Bottom sheet (mobile) / side panel (desktop).
 *
 * Used for anything that must not cover the game the viewer is playing:
 * comments, source information, lineage, remix parameters. The sheet is a real
 * `role="dialog"` with a focus trap, Escape handling and focus restoration, so
 * keyboard and screen-reader users are not stranded behind the game.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { trapFocus, useEscape, useScrollLock } from '../lib/focus.ts';
import { IconButton } from './Button.tsx';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Rendered next to the close button, e.g. a count. */
  headerAside?: ReactNode;
}

let sheetSequence = 0;

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  headerAside,
}: SheetProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [titleId, setTitleId] = useState('');
  const [descriptionId, setDescriptionId] = useState('');

  useEscape(open, onClose);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const id = `sheet-${(sheetSequence += 1)}`;
    setTitleId(`${id}-title`);
    setDescriptionId(`${id}-description`);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const release = trapFocus(panel, document.activeElement);
    return release;
  }, [open]);

  if (!open) return null;

  return (
    <div className="sheet" role="presentation">
      <div className="sheet__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="sheet__head">
          <div className="sheet__titles">
            <h2 className="sheet__title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="sheet__description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          {headerAside}
          <IconButton label="Close" variant="ghost" onClick={onClose}>
            ✕
          </IconButton>
        </header>
        <div className="sheet__body">{children}</div>
        {footer ? <footer className="sheet__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
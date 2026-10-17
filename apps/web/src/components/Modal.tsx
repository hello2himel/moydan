/**
 * Centred modal dialog.
 *
 * Structurally identical to `Sheet` (same roles, same focus trap) but visually
 * centred, because the remix flow is a decision, not a peek at something.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { trapFocus, useEscape, useScrollLock } from '../lib/focus.ts';
import { IconButton } from './Button.tsx';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider layout for the schema driven parameter editor. */
  wide?: boolean;
}

let modalSequence = 0;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
}: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [ids, setIds] = useState({ title: '', description: '' });

  useEscape(open, onClose);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const id = `modal-${(modalSequence += 1)}`;
    setIds({ title: `${id}-title`, description: `${id}-description` });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    return trapFocus(panel, document.activeElement);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal" role="presentation">
      <div className="modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className={wide ? 'modal__panel modal__panel--wide' : 'modal__panel'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={description ? ids.description : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="modal__head">
          <h2 className="modal__title" id={ids.title}>
            {title}
          </h2>
          <IconButton label="Close" variant="ghost" onClick={onClose}>
            ✕
          </IconButton>
        </header>
        {description ? (
          <p className="modal__description" id={ids.description}>
            {description}
          </p>
        ) : null}
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
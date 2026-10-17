/**
 * The only button in the application.
 *
 * Every interactive control in Moydan uses this component for two reasons: the
 * 44px minimum touch target is enforced once (accessibility is not something to
 * re-decide per screen), and a `type="button"` default stops a button inside a
 * form from submitting it by accident.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Stretch to the width of the container. */
  block?: boolean;
  /** Square-ish control that still meets the touch target minimum. */
  icon?: boolean;
  busy?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  block = false,
  icon = false,
  busy = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps): ReactNode {
  const classes = ['btn', `btn--${variant}`];
  if (block) classes.push('btn--block');
  if (icon) classes.push('btn--icon');
  if (busy) classes.push('btn--busy');
  if (className) classes.push(className);
  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      disabled={disabled ?? busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonProps {
  label: string;
  children: ReactNode;
}

/** Icon-only control: `label` becomes the accessible name, never the title. */
export function IconButton({ label, className, children, ...rest }: IconButtonProps): ReactNode {
  return (
    <Button {...rest} icon aria-label={label} title={label} className={className}>
      <span aria-hidden="true" className="btn__glyph">
        {children}
      </span>
    </Button>
  );
}
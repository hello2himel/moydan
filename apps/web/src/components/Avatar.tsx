/**
 * Creator avatar.
 *
 * Avatars come from arbitrary user-provided URLs, so the image is decorative
 * when a link already carries the name and always degrades to initials: a
 * broken image URL must never leave a hole in the feed.
 */

import { useState, type ReactNode } from 'react';
import { initials } from '../lib/format.ts';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

export interface AvatarProps {
  url: string | null | undefined;
  name: string | null | undefined;
  size?: AvatarSize;
  className?: string;
}

export function Avatar({ url, name, size = 'md', className }: AvatarProps): ReactNode {
  const [failed, setFailed] = useState(false);
  const classes = ['avatar', `avatar--${size}`];
  if (className) classes.push(className);

  if (url && !failed) {
    return (
      <span className={classes.join(' ')}>
        <img
          className="avatar__img"
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span className={classes.join(' ')} aria-hidden="true">
      <span className="avatar__initials">{initials(name)}</span>
    </span>
  );
}
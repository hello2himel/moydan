/**
 * Feed tabs.
 *
 * For You and Following are two different endpoints with two different
 * rankings, so they are two different routes. Sharing the tabs component keeps
 * the visual language identical without pretending the data is the same.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface FeedTabsProps {
  active: 'foryou' | 'following';
}

export function FeedTabs({ active }: FeedTabsProps): ReactNode {
  return (
    <nav className="feedtabs" aria-label="Feed">
      <NavLink
        to="/feed/foryou"
        className={active === 'foryou' ? 'feedtabs__link feedtabs__link--active' : 'feedtabs__link'}
        aria-current={active === 'foryou' ? 'page' : undefined}
      >
        For you
      </NavLink>
      <NavLink
        to="/feed/following"
        className={active === 'following' ? 'feedtabs__link feedtabs__link--active' : 'feedtabs__link'}
        aria-current={active === 'following' ? 'page' : undefined}
      >
        Following
      </NavLink>
    </nav>
  );
}
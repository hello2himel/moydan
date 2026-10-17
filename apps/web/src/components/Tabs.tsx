/**
 * Tabs.
 *
 * Route tabs render real `<NavLink>`s so tabs are shareable URLs, keyboard
 * reachable and crawlable. Two tab sets on this app cannot both be driven by
 * the router: the profile tabs live in the query string (react-router's
 * `isActive` only looks at the pathname), so callers can pass `activeId` to
 * decide the highlighted tab themselves.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface TabItem {
  id: string;
  label: string;
  to: string;
  /** Optional trailing count, e.g. the number of saved games. */
  badge?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  /** Accessible name for the tab list. */
  label: string;
  /** Overrides router-driven selection (query-string tabs). */
  activeId?: string;
  className?: string;
}

export function Tabs({ items, label, activeId, className }: TabsProps): ReactNode {
  const classes = ['tabs'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role="tablist" aria-label={label}>
      {items.map((item) => (
        <NavLink
          key={item.id}
          to={item.to}
          className={({ isActive }) =>
            (activeId ? activeId === item.id : isActive) ? 'tabs__tab tabs__tab--active' : 'tabs__tab'
          }
        >
          <span>{item.label}</span>
          {item.badge !== undefined && item.badge !== null ? (
            <span className="tabs__badge">{item.badge}</span>
          ) : null}
        </NavLink>
      ))}
    </div>
  );
}
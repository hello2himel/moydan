/**
 * Application chrome.
 *
 * Two presentations of the same four destinations: a bottom bar on phones
 * (thumb reach, safe-area aware) and a sidebar from 900px up. The feed route
 * opts out of page padding so a game really fills the screen; everything else
 * gets a readable measure.
 *
 * There is no dead destination here: every item either navigates or is rendered
 * only when it can actually do something.
 */

import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../session/SessionProvider.tsx';

export type ShellVariant = 'immersive' | 'standard';

const DESTINATIONS = [
  { to: '/feed/foryou', label: 'Home', glyph: '⌂', end: false },
  { to: '/saved', label: 'Saved', glyph: '★', end: false },
  { to: '/create', label: 'Create', glyph: '✚', end: false },
] as const;

function isImmersive(pathname: string): boolean {
  return pathname.startsWith('/feed/');
}

export function AppShell(): ReactNode {
  const { user } = useSession();
  const { pathname } = useLocation();
  const immersive = isImmersive(pathname);
  const profileTo = user ? `/@${user.handle}` : '/login';
  const profileLabel = user ? `@${user.handle}` : 'Sign in';

  return (
    <div className={immersive ? 'app app--immersive' : 'app'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="app__bar">
        <NavLink className="app__brand" to="/feed/foryou">
          <span className="app__brand-mark" aria-hidden="true">
            M
          </span>
          <span className="app__brand-name">Moydan</span>
        </NavLink>
      </header>

      <nav className="app__rail" aria-label="Primary">
        <ul className="app__rail-list">
          {DESTINATIONS.map((destination) => (
            <li key={destination.to}>
              <NavLink
                to={destination.to}
                end={destination.end}
                className={({ isActive }) => (isActive ? 'app__rail-link app__rail-link--active' : 'app__rail-link')}
              >
                <span className="app__glyph" aria-hidden="true">
                  {destination.glyph}
                </span>
                <span>{destination.label}</span>
              </NavLink>
            </li>
          ))}
          <li>
            <NavLink
              to={profileTo}
              className={({ isActive }) => (isActive ? 'app__rail-link app__rail-link--active' : 'app__rail-link')}
            >
              <span className="app__glyph" aria-hidden="true">
                @
              </span>
              <span>Profile</span>
            </NavLink>
          </li>
        </ul>

        {user ? (
          <ul className="app__rail-list app__rail-list--secondary">
            <li>
              <NavLink
                to="/settings"
                className={({ isActive }) => (isActive ? 'app__rail-link app__rail-link--active' : 'app__rail-link')}
              >
                <span className="app__glyph" aria-hidden="true">
                  ⚙
                </span>
                <span>Settings</span>
              </NavLink>
            </li>
          </ul>
        ) : null}
      </nav>

      <main className="app__main" id="main" tabIndex={-1}>
        <Outlet />
      </main>

      <nav className="app__nav" aria-label="Primary">
        <ul className="app__nav-list">
          {DESTINATIONS.map((destination) => (
            <li key={destination.to}>
              <NavLink
                to={destination.to}
                className={({ isActive }) => (isActive ? 'app__tab app__tab--active' : 'app__tab')}
              >
                <span className="app__glyph" aria-hidden="true">
                  {destination.glyph}
                </span>
                <span className="app__tab-label">{destination.label}</span>
              </NavLink>
            </li>
          ))}
          <li>
            <NavLink to={profileTo} className={({ isActive }) => (isActive ? 'app__tab app__tab--active' : 'app__tab')}>
              <span className="app__glyph" aria-hidden="true">
                @
              </span>
              <span className="app__tab-label">{profileLabel}</span>
            </NavLink>
          </li>
        </ul>
      </nav>
    </div>
  );
}

/** Page container used by every non-feed screen. */
export function Page({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <div className={className ? `page ${className}` : 'page'}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="page__header">
      <div>
        <h1 className="page__title">{title}</h1>
        {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page__actions">{actions}</div> : null}
    </header>
  );
}
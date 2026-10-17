/**
 * Authentication guard.
 *
 * Creator screens (studio, remix, settings) are worthless without an account and
 * would otherwise render as broken forms. `useRequireAuth` turns that into a
 * redirect that remembers where the visitor was going, so signing in resumes the
 * original intent instead of dumping them on the feed.
 */

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from './SessionProvider.tsx';
import type { Viewer } from '../api/session.ts';

export interface RequireAuthValue {
  user: Viewer | null;
  /** True while the session check runs *and* while the redirect is in flight. */
  isPending: boolean;
}

/** Build a login URL that returns to `path` (pathname + search). */
export function loginRedirectTarget(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

/**
 * Only ever redirect to a path on this origin: `next` comes from the URL, so it
 * is untrusted input and must not become an open redirect.
 */
export function safeNextPath(next: string | null): string {
  if (!next) return '/feed/foryou';
  if (!next.startsWith('/')) return '/feed/foryou';
  if (next.startsWith('//')) return '/feed/foryou';
  return next;
}

export function useRequireAuth(): RequireAuthValue {
  const { user, isLoading } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const current = `${location.pathname}${location.search}`;
  const needsRedirect = !isLoading && !user && location.pathname !== '/login';

  useEffect(() => {
    if (!needsRedirect) return;
    navigate(loginRedirectTarget(current), { replace: true });
  }, [needsRedirect, current, navigate]);

  return { user, isPending: isLoading || needsRedirect };
}
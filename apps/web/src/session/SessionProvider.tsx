/**
 * Session state.
 *
 * There is exactly one source of truth for "who is signed in" - a react-query
 * on `GET /api/auth/session` - so the bottom navigation, the studio guard and
 * the profile header can never disagree about it. The provider exists to expose
 * that query through context with a friendly surface; the caching itself is
 * still react-query's job.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSession, type SessionState, type Viewer } from '../api/session.ts';
import { queryKeys } from '../lib/queryKeys.ts';

export interface SessionValue {
  user: Viewer | null;
  /** True while the very first session check is in flight. */
  isLoading: boolean;
  isError: boolean;
  isSignedIn: boolean;
  refresh: () => void;
  /** Adopt a fresh session right after login/register without a round trip. */
  setSession: (next: SessionState) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const query = useQuery<SessionState>({
    queryKey: ['session'],
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 60_000,
    retry: false,
  });

  const setSession = useCallback(
    (next: SessionState) => {
      queryClient.setQueryData(queryKeys.session, next);
    },
    [queryClient],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.session });
  }, [queryClient]);

  const value = useMemo<SessionValue>(
    () => ({
      user: query.data?.user ?? null,
      isLoading: query.isPending,
      isError: query.isError,
      isSignedIn: Boolean(query.data?.user),
      refresh,
      setSession,
    }),
    [query.data, query.isPending, query.isError, refresh, setSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}

/** The signed-in viewer, or null. Safe anywhere inside the provider. */
export function useViewer(): Viewer | null {
  return useSession().user;
}
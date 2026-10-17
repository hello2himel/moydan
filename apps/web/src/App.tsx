/**
 * Route table and application providers.
 *
 * Providers live inside the router (not around it) so a route that fails still
 * renders inside the error boundary with a working navigation. Session state is
 * a provider because three different surfaces - navigation, studio guard and
 * profile header - need the same answer to "who is signed in".
 */

import { useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, createBrowserRouter, useLocation, type RouteObject } from 'react-router-dom';
import { isApiError } from './api/client.ts';
import { AppShell } from './components/AppShell.tsx';
import { ErrorBoundary, RouteErrorBoundary } from './components/ErrorBoundary.tsx';
import { SessionProvider } from './session/SessionProvider.tsx';
import { CreateScreen } from './screens/CreateScreen.tsx';
import { FeedScreen } from './screens/FeedScreen.tsx';
import { GameScreen } from './screens/GameScreen.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { NotFoundScreen } from './screens/NotFoundScreen.tsx';
import { ProfileScreen } from './screens/ProfileScreen.tsx';
import { RemixScreen } from './screens/RemixScreen.tsx';
import { SavedScreen } from './screens/SavedScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { SignupScreen } from './screens/SignupScreen.tsx';
import { StudioScreen } from './screens/StudioScreen.tsx';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // A 4xx is the server telling us the answer; retrying cannot change it.
        retry: (failureCount, error) => {
          if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

function RootLayout(): ReactNode {
  return (
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  );
}

/**
 * Public profiles (`/@handle`) and the 404 page share one route.
 *
 * react-router path parameters have to start a path segment, so `@:handle`
 * cannot be expressed as a route path: `@handle` would be compiled as a static
 * segment. The catch-all therefore matches the URL and dispatches - `/@ada` is
 * a profile, anything else is a genuine not-found.
 */
const HANDLE_PATH = /^\/@([^/]+)\/?$/;

function HandleOrNotFound(): ReactNode {
  const { pathname } = useLocation();
  const match = HANDLE_PATH.exec(pathname);
  return match ? <ProfileScreen handle={decodeURIComponent(match[1] ?? '')} /> : <NotFoundScreen />;
}

const routes: RouteObject[] = [
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/feed/foryou" replace /> },
      { path: 'feed/foryou', element: <FeedScreen tab="foryou" /> },
      { path: 'feed/following', element: <FeedScreen tab="following" /> },
      { path: 'saved', element: <SavedScreen /> },
      { path: 'create', element: <CreateScreen /> },
      { path: 'studio/:gameId', element: <StudioScreen /> },
      { path: 'games/:gameId', element: <GameScreen /> },
      { path: 'remix/:gameId', element: <RemixScreen /> },
      { path: 'settings', element: <SettingsScreen /> },
      { path: 'login', element: <LoginScreen /> },
      { path: 'signup', element: <SignupScreen /> },
      { path: '*', element: <HandleOrNotFound /> },
    ],
  },
];

export function App(): ReactNode {
  const queryClient = useMemo(createQueryClient, []);
  const router = useMemo(() => createBrowserRouter(routes), []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
/**
 * Browser entry point.
 *
 * Two things happen before React mounts: the design system stylesheet is
 * imported, and a global handler is installed so an uncaught error or an
 * unhandled rejection is *logged* in development and swallowed in production.
 * Nothing is reported anywhere from a browser build - Moydan is self-hosted,
 * and a viewer should never have their session thrown at a third party.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Moydan could not start: #root is missing from the document.');
}

if (import.meta.env.DEV) {
  window.addEventListener('error', (event) => {
    console.error('[moydan] uncaught error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[moydan] unhandled rejection', event.reason);
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
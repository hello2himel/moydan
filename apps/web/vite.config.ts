/**
 * Vite configuration for the Moydan web application.
 *
 * Three decisions live here:
 *
 *  1. The workspace packages (`@moydan/core`, `@moydan/runtime`, `@moydan/sdk`)
 *     are aliased to their TypeScript sources. The web app must never ship a
 *     stale compiled copy of the contracts the API is validating against.
 *  2. `/api` and `/health` are proxied to the API process in development so the
 *     browser only ever talks to one origin. That is what makes the session
 *     cookie (`SameSite=Lax`) and the double-submit CSRF cookie work locally
 *     exactly like they do in production.
 *  3. Game content is served from a *different* origin (the game origin) and is
 *     never proxied: the sandbox boundary in `@moydan/runtime` authenticates
 *     postMessage events by origin, and a proxy would break that separation.
 */

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';
const PORT = Number(process.env.PORT ?? 5173);

/** Absolute path to the repository root so aliases work from any cwd. */
const workspace = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Order matters: the exact entry point first, then its subpaths.
    alias: [
      { find: /^@moydan\/core$/, replacement: workspace('../../packages/core/src/index.ts') },
      { find: /^@moydan\/core\/(.*)$/, replacement: workspace('../../packages/core/src/$1') },
      { find: /^@moydan\/runtime$/, replacement: workspace('../../packages/runtime/src/index.ts') },
      { find: /^@moydan\/runtime\/host$/, replacement: workspace('../../packages/runtime/src/host.ts') },
      { find: /^@moydan\/runtime\/feed$/, replacement: workspace('../../packages/runtime/src/feed.ts') },
      { find: /^@moydan\/sdk$/, replacement: workspace('../../packages/sdk/src/index.ts') },
      { find: /^@moydan\/sdk\/(.*)$/, replacement: workspace('../../packages/sdk/src/$1') },
    ],
  },
  server: {
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/health': { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: {
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/health': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
/**
 * Playwright configuration.
 *
 * There is deliberately no `webServer` entry: the end-to-end suite is run by
 * `npm run dev` (or against a preview build) in CI, and the web server's
 * lifetime is owned by the person running the suite rather than by this file.
 * Keeping it server-less also means `playwright test --list` works on a machine
 * with nothing running.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 5173);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
        resolve: {
          alias: {
            '@moydan/core': r('./packages/core/src/index.ts'),
            '@moydan/storage': r('./packages/storage/src/index.ts'),
            '@moydan/runtime': r('./packages/runtime/src/index.ts'),
            '@moydan/sdk': r('./packages/sdk/src/index.ts'),
          },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/test/**/*.test.ts', 'packages/storage/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
        resolve: {
          alias: {
            '@moydan/core': r('./packages/core/src/index.ts'),
            '@moydan/storage': r('./packages/storage/src/index.ts'),
          },
        },
      },
    ],
  },
});

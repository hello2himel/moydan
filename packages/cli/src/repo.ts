/**
 * Locating the platform checkout the CLI is running inside.
 *
 * Why: the CLI needs three things that are not part of a creator's project —
 * the SDK source it serves at `/sdk/v1/index.js`, the pinned engine bundle, and
 * the platform version it should report. All three live in the repository, so
 * the CLI walks up from its own module location (falling back to the working
 * directory) until it finds them.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MARKERS = ['packages/core/src/manifest.ts', 'packages/sdk/src/index.ts'];

export function findRepoRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    if (MARKERS.every((marker) => existsSync(resolve(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * The repository the CLI belongs to. `import.meta.dirname` is used first so a
 * project anywhere on disk still resolves the right SDK, then the working
 * directory (handy when the CLI is installed globally inside the checkout).
 */
export function resolveRepoRoot(): string {
  const fromModule = typeof import.meta.dirname === 'string' ? findRepoRoot(import.meta.dirname) : null;
  if (fromModule) return fromModule;
  const fromCwd = findRepoRoot(process.cwd());
  if (fromCwd) return fromCwd;
  throw new Error(
    'could not locate the Moydan platform checkout (expected packages/core and packages/sdk next to the CLI). ' +
      'Run the CLI from a clone of the repository.',
  );
}

export function sdkEntrySource(repoRoot: string): string {
  return resolve(repoRoot, 'packages', 'sdk', 'src', 'index.ts');
}

/** Vendored engine bundle published by `scripts/vendor-toolchain.mjs`. */
export function vendoredEnginePath(repoRoot: string): string | null {
  const path = resolve(repoRoot, 'vendor', 'toolchain', 'phaser', 'phaser.min.js');
  return existsSync(path) ? path : null;
}

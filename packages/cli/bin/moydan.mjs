#!/usr/bin/env node
/**
 * `moydan` launcher.
 *
 * The CLI is published as a bundle (`npm run build` in this package), but a
 * creator working inside the platform checkout should be able to run the exact
 * command they just wrote without a build step. Node strips the TypeScript
 * types in `src/`, so the launcher prefers `dist/cli.js` when it exists and
 * falls back to `src/index.ts` otherwise.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(packageRoot, 'dist', 'cli.js');
const source = resolve(packageRoot, 'src', 'index.ts');

const entry = existsSync(bundle) ? bundle : source;
if (!existsSync(entry)) {
  process.stderr.write('moydan CLI is not built: run "npm run build -w @moydan/cli" (or repair node_modules)\n');
  process.exit(1);
}

const { main } = await import(pathToFileURL(entry).href);
process.exitCode = await main(process.argv.slice(2));

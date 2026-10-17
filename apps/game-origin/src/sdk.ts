/**
 * The creator SDK, compiled once at startup.
 *
 * `/sdk/moydan-sdk.js` is the *only* script an artifact document loads besides
 * its own bundle, so it is built here from the repository's `packages/sdk`
 * source with esbuild and served from memory with immutable caching. Compiling
 * at startup (instead of shipping a checked-in file) means the SDK a game runs
 * is always exactly the SDK this deployment ships - there is no stale copy to
 * serve after an upgrade.
 *
 * The bundle also carries a small platform shell (see `SHELL_SOURCE`). The
 * generated `index.html` cannot contain inline script - the CSP forbids it - so
 * this is where "show a visible error box" and "hide the loading placeholder"
 * live. It is deliberately tiny and only ever touches platform-owned element ids.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { digestOf } from './artifacts.ts';

export interface SdkBundle {
  code: Uint8Array;
  sha256: string;
  size: number;
}

/**
 * Platform shell appended to the SDK module.
 *
 * Written as JavaScript inside a template string: it is injected source, not a
 * TypeScript file, and it must not depend on any bundler plugin.
 */
const SHELL_SOURCE = `
globalThis.MoydanSdk = sdk;
const errorBox = () => document.getElementById('moydan-error');
const showError = (message) => {
  const box = errorBox();
  if (box && !box.textContent) box.textContent = String(message).slice(0, 500);
};
const hideLoader = () => {
  const loader = document.getElementById('moydan-loading');
  if (loader) loader.hidden = true;
};
addEventListener('error', (event) => showError(event.message || 'The game failed to start.'));
addEventListener('unhandledrejection', (event) => showError(event.reason && event.reason.message ? event.reason.message : event.reason));
const observer = new MutationObserver(() => {
  if (document.getElementById('moydan-game')) { hideLoader(); observer.disconnect(); }
});
addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('moydan-game')) hideLoader();
  else observer.observe(document.body, { childList: true, subtree: true });
});
`;

export interface BuildSdkOptions {
  repoRoot?: string;
}

/** Compile `packages/sdk/src/index.ts` into one self-contained ES module. */
export async function buildSdkBundle(options: BuildSdkOptions = {}): Promise<SdkBundle> {
  const repoRoot = options.repoRoot ?? resolve(import.meta.dirname, '..', '..', '..');
  const sdkEntry = join(repoRoot, 'packages', 'sdk', 'src', 'index.ts');
  if (!existsSync(sdkEntry)) {
    throw new Error(`the creator SDK source is missing (${sdkEntry}); run the origin from the repository`);
  }

  const entry = `import * as sdk from ${JSON.stringify(sdkEntry)};\n${SHELL_SOURCE}`;
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: repoRoot, sourcefile: 'moydan-sdk-shell.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    target: 'es2020',
    platform: 'browser',
    minify: true,
    write: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    // The SDK is the platform's own source; nothing may be pulled from a
    // registry at runtime of this service.
    nodePaths: [],
  });

  const output = (result.outputFiles ?? [])[0];
  if (!output) throw new Error('esbuild produced no SDK bundle');
  const code = new Uint8Array(output.contents);
  return { code, sha256: digestOf(code), size: code.byteLength };
}

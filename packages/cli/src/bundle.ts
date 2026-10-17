/**
 * The build step: esbuild bundle + asset copy + generated entry document.
 *
 * This is deliberately the same shape as the worker's bundler so that what a
 * creator tests with `moydan build` is what a release builds:
 *
 *   - the entry module named by `game.json` is bundled to `game.js` (ESM,
 *     browser platform, minified, no source maps — source maps never ship);
 *   - `@moydan/sdk` stays external and is rewritten to the absolute module URL
 *     `/sdk/v1/index.js`, because the game origin serves exactly one SDK per
 *     runtime API version and an artifact must never carry a second copy;
 *   - a pinned engine (`phaser`) is likewise external and resolves to the
 *     vendored `/vendor/phaser.min.js` on the game origin, so every Phaser game
 *     shares one cached engine download instead of shipping 1.4 MB each;
 *   - `assets/**` and `public/**` are copied verbatim (paths preserved, so a
 *     game can reference `assets/...` at runtime);
 *   - `index.html` is generated: no inline script, no remote URL, nothing the
 *     game origin's Content-Security-Policy would refuse to run.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  BUILD_ESBUILD_VERSION,
  checkArtifactPath,
  contentTypeForPath,
  formatBytes,
  isCompressible,
  verifyFileBytes,
  type GameManifest,
  type Limits,
  type ValidationIssue,
} from '@moydan/core';
import * as esbuild from 'esbuild';
import type { LoadedProject } from './project.ts';
import { CliError } from './ui.ts';

/** Absolute module URL the game origin serves the SDK from. */
export const SDK_MODULE_PATH = '/sdk/v1/index.js';
/** Absolute module URL of the pinned, platform-provided engine bundle. */
export const ENGINE_MODULE_PATH = '/vendor/phaser.min.js';
/** Generated shell document; the entry row of every artifact. */
export const ENTRY_DOCUMENT = 'index.html';
export const BUNDLE_NAME = 'game.js';

const ASSET_ROOTS = ['assets', 'public'];

export interface ArtifactFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
  /** gzip size, reported so creators see what players actually download. */
  gzipBytes: number;
}

export interface EngineInfo {
  name: string;
  version: string;
  modulePath: string;
  /** Where the pinned bundle was read from, repo-relative. */
  source: string;
  bytes: number;
  sha256: string;
}

export interface BuildOptions {
  minify?: boolean;
  limits: Limits;
  /** Called for every esbuild warning so the caller can surface it. */
  onWarning?: (text: string) => void;
}

export interface BuildResult {
  manifest: GameManifest;
  files: ArtifactFile[];
  entry: string;
  /** Entry document size: exactly what the platform records as first playable. */
  firstPlayableBytes: number;
  /** Everything a player downloads before the game is interactive. */
  payloadBytes: number;
  totalBytes: number;
  engine: EngineInfo | null;
  /** Non-fatal notes: toolchain facts and undeclared budgets. */
  notes: string[];
  issues: ValidationIssue[];
  durationMs: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Refuse to build with an unpinned esbuild. The worker asserts the same thing at
 * startup: an artifact built by a different compiler is a different artifact.
 */
export function assertToolchain(): void {
  if (esbuild.version !== BUILD_ESBUILD_VERSION) {
    throw new CliError(
      `esbuild ${esbuild.version} is installed but ${BUILD_ESBUILD_VERSION} is pinned. ` +
        'Run "npm install" at the repository root so builds use the pinned toolchain.',
    );
  }
}

/**
 * Resolve the pinned engine bundle for an engine project. The vendored copy is
 * preferred (that is what releases are built against); `node_modules` is the
 * fallback so a fresh clone can still build.
 */
function resolveEngine(manifest: GameManifest, repoRoot: string): EngineInfo {
  const candidates = [
    resolve(repoRoot, 'vendor', 'toolchain', 'phaser', 'phaser.min.js'),
    resolve(repoRoot, 'node_modules', 'phaser', 'dist', 'phaser.esm.min.js'),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    throw new CliError(
      `the pinned ${manifest.engine.name} ${manifest.engine.version} bundle is missing. ` +
        'Run "npm run vendor:toolchain" (or "npm install") first.',
    );
  }
  const bytes = new Uint8Array(readFileSync(source));
  return {
    name: manifest.engine.name,
    version: manifest.engine.version,
    modulePath: ENGINE_MODULE_PATH,
    source: relative(repoRoot, source).split(sep).join('/'),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function collectAssetFiles(root: string): string[] {
  const found: string[] = [];
  for (const directory of ASSET_ROOTS) {
    const base = resolve(root, directory);
    if (!existsSync(base)) continue;
    const walk = (current: string): void => {
      const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'));
      }
    };
    walk(base);
  }
  return found.sort();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The artifact entry document. Deliberately script-free: a strict
 * `script-src 'self'` policy cannot run an inline bootstrap, so the shell only
 * points at the bundle and lets the SDK perform the handshake with the host.
 */
export function renderEntryDocument(manifest: GameManifest): Uint8Array {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(manifest.title)}</title>
<style>
html,body{margin:0;height:100%;background:#07070d;overflow:hidden;overscroll-behavior:none}
body{font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e9e9f5}
#moydan-game{position:absolute;inset:0}
</style>
</head>
<body>
<script type="module" src="./${BUNDLE_NAME}"></script>
</body>
</html>
`;
  return new TextEncoder().encode(html);
}

function artifactFile(path: string, bytes: Uint8Array): ArtifactFile {
  const contentType = contentTypeForPath(path);
  return {
    path,
    bytes,
    contentType,
    gzipBytes: isCompressible(contentType) ? gzipSync(bytes, { level: 9 }).byteLength : bytes.byteLength,
  };
}

export async function buildArtifact(project: LoadedProject, repoRoot: string, options: BuildOptions): Promise<BuildResult> {
  assertToolchain();
  const manifest = project.manifest;
  if (!manifest) throw new CliError('the project manifest is not valid; run "moydan validate" first');

  const notes: string[] = [];
  const issues: ValidationIssue[] = [];
  const minify = options.minify ?? true;
  const engine = manifest.engine.name === 'phaser' ? resolveEngine(manifest, repoRoot) : null;

  const externals = new Map<string, string>([['@moydan/sdk', SDK_MODULE_PATH]]);
  if (engine) externals.set(manifest.engine.name, engine.modulePath);

  const started = performance.now();
  const result = await esbuild.build({
    entryPoints: [resolve(project.root, manifest.entry)],
    absWorkingDir: project.root,
    bundle: true,
    write: false,
    outfile: BUNDLE_NAME,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify,
    legalComments: 'none',
    sourcemap: false,
    treeShaking: true,
    logLevel: 'silent',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js: `/* ${manifest.slug} built with esbuild ${esbuild.version}; runtime API v${manifest.runtime.apiVersion}. Do not edit. */`,
    },
    plugins: [
      {
        name: 'moydan-externals',
        setup(build) {
          build.onResolve({ filter: /^(@moydan\/sdk|phaser)$/ }, (args) => {
            const mapped = externals.get(args.path);
            return mapped ? { path: mapped, external: true } : null;
          });
        },
      },
    ],
  });
  const durationMs = performance.now() - started;

  const output = result.outputFiles?.[0];
  if (!output) throw new CliError('esbuild produced no output for the entry module');

  for (const warning of result.warnings) {
    issues.push({ path: 'entry', code: 'not_allowed', message: `esbuild warning: ${warning.text}` });
    options.onWarning?.(warning.text);
  }

  const files: ArtifactFile[] = [
    artifactFile(ENTRY_DOCUMENT, renderEntryDocument(manifest)),
    artifactFile(BUNDLE_NAME, new Uint8Array(output.contents)),
  ];
  for (const assetPath of collectAssetFiles(project.root)) {
    files.push(artifactFile(assetPath, new Uint8Array(readFileSync(resolve(project.root, assetPath)))));
  }
  for (const file of files) {
    const pathProblem = checkArtifactPath(file.path);
    if (pathProblem) {
      issues.push({ path: file.path, code: 'not_allowed', message: `not publishable: ${pathProblem.message}` });
      continue;
    }
    const content = verifyFileBytes(file.path, file.bytes);
    if (!content.ok) {
      issues.push({ path: file.path, code: 'not_allowed', message: content.message ?? 'content does not match its extension' });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const entryFile = files.find((file) => file.path === ENTRY_DOCUMENT);
  const firstPlayableBytes = entryFile ? entryFile.bytes.byteLength : 0;

  if (files.length > options.limits.maxArtifactFiles) {
    issues.push({ path: '$', code: 'too_many', message: `artifact has ${files.length} files; the limit is ${options.limits.maxArtifactFiles}` });
  }
  if (totalBytes > options.limits.maxArtifactBytes) {
    issues.push({ path: '$', code: 'too_large', message: `artifact is ${formatBytes(totalBytes)}; the limit is ${formatBytes(options.limits.maxArtifactBytes)}` });
  }
  if (firstPlayableBytes > options.limits.maxFirstPlayableBytes) {
    issues.push({
      path: ENTRY_DOCUMENT,
      code: 'too_large',
      message: `the entry document alone is ${formatBytes(firstPlayableBytes)}; the limit is ${formatBytes(options.limits.maxFirstPlayableBytes)}`,
    });
  }
  const declaredBudget = manifest.budgets?.firstPlayableBytes;
  if (declaredBudget && totalBytes > declaredBudget) {
    issues.push({
      path: 'budgets.firstPlayableBytes',
      code: 'out_of_range',
      message: `first playable payload is ${formatBytes(totalBytes)}; the project declares ${formatBytes(declaredBudget)}`,
    });
  }
  if (!declaredBudget) {
    notes.push('budgets.firstPlayableBytes is not declared; set it in game.json to fail fast when the payload grows');
  }
  if (engine) {
    notes.push(
      `engine ${engine.name} ${engine.version} is served by the game origin from ${engine.modulePath} ` +
        `(${formatBytes(engine.bytes)}, sha256 ${engine.sha256.slice(0, 12)}…), not copied into the artifact`,
    );
  }
  notes.push(`esbuild ${esbuild.version} bundled ${Object.keys(result.metafile?.inputs ?? {}).length} modules in ${Math.round(durationMs)} ms`);

  return {
    manifest,
    files,
    entry: ENTRY_DOCUMENT,
    firstPlayableBytes,
    payloadBytes: totalBytes,
    totalBytes,
    engine,
    notes,
    issues,
    durationMs,
  };
}

/** Write an artifact to disk, creating parent directories as needed. */
export function writeArtifact(result: BuildResult, outDir: string): string[] {
  return result.files.map((file) => {
    const target = resolve(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    return target;
  });
}

export function describeArtifact(result: BuildResult, limits: Limits): string[] {
  const lines: string[] = [];
  for (const file of result.files) {
    const size =
      file.gzipBytes < file.bytes.byteLength
        ? `${formatBytes(file.bytes.byteLength)} (${formatBytes(file.gzipBytes)} gz)`
        : formatBytes(file.bytes.byteLength);
    lines.push(`  ${file.path.padEnd(52)} ${size.padStart(20)}  ${file.contentType}`);
  }
  lines.push('');
  const declared = result.manifest.budgets?.firstPlayableBytes;
  const budget = declared ?? limits.maxFirstPlayableBytes;
  const status = result.payloadBytes <= budget ? 'ok' : 'OVER BUDGET';
  lines.push(
    `  first playable payload  ${formatBytes(result.payloadBytes).padStart(9)}  budget ${formatBytes(budget).padStart(9)}  ${status} (${declared ? 'project' : 'platform'})`,
  );
  lines.push(`  artifact total         ${formatBytes(result.totalBytes).padStart(9)}  ${result.files.length} files, limit ${formatBytes(limits.maxArtifactBytes)}`);
  lines.push(`  entry document         ${formatBytes(result.firstPlayableBytes).padStart(9)}  ${result.entry} (the platform's first-playable metric)`);
  return lines;
}

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

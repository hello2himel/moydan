/**
 * Compilation: a source tree in, a deterministic artifact set out.
 *
 * Everything in this module runs inside the *isolated build child* (see
 * `isolate.ts`), so it must never need credentials, a database or a network.
 * The rules that make the output trustworthy are:
 *
 *   - only three bare module specifiers resolve (`@moydan/sdk`,
 *     `@moydan/core` and the vendored `phaser` build). Everything else fails
 *     the build with a message that says what *is* available. A creator can
 *     therefore never pull code from npm at build time, and the compiler never
 *     executes anything it did not ship itself;
 *   - relative imports may not escape the materialised project directory;
 *   - source maps and legal comments are stripped, so a published artifact
 *     cannot leak the original TypeScript, and two builds of the same version
 *     produce byte-identical output (the platform's build idempotency key
 *     depends on it).
 *
 * The emitted artifact is deliberately tiny: `index.html` (a CSP-safe host
 * document), `game.js` (the bundle, with the engine inlined when used),
 * an optional `game.css`, and every asset file copied byte for byte.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import {
  ARTIFACT_MANIFEST_VERSION,
  BUILD_ESBUILD_VERSION,
  BUILD_PHASER_VERSION,
  BUILD_TOOLCHAIN_ID,
  checkArtifactPath,
  contentTypeForPath,
  formatBytes,
  verifyFileBytes,
  type GameManifest,
  type Limits,
} from '@moydan/core';
import { sha256Hex } from './digest.ts';
import { BuildFailure, type BuildDiagnostic } from './failure.ts';

// --- Types -------------------------------------------------------------------

/** Artifact manifest shape, structurally identical to the API's `ArtifactManifest`. */
export interface ArtifactManifestFile {
  path: string;
  size: number;
  contentType: string;
  encodings?: string[];
  sha256: string;
}

export interface ArtifactManifest {
  version: number;
  entry: string;
  files: ArtifactManifestFile[];
  totalBytes: number;
  firstPlayableBytes: number;
}

export interface BuiltArtifactFile {
  path: string;
  content: Uint8Array;
  contentType: string;
  entry: boolean;
}

export interface BuildOutput {
  files: BuiltArtifactFile[];
  manifest: ArtifactManifest;
  log: string;
}

/**
 * The build job handed to the isolated child. Every path is absolute on the
 * build host (or inside the container mount when Docker isolation is used);
 * `projectDir`/`outDir` are relative to the workspace, which is the child's cwd.
 */
export interface SandboxSpec {
  jobId: string;
  releaseId: string;
  title: string;
  entry: string;
  engine: { name: GameManifest['engine']['name']; version: string };
  orientation: GameManifest['orientation'];
  viewport: GameManifest['viewport'];
  limits: Limits;
  repoRoot: string;
  toolchainDir: string;
  projectDir: string;
  outDir: string;
  resultFile: string;
}

/** What the child writes to `resultFile`; consumed by the parent process. */
export interface SandboxResultFile {
  ok: boolean;
  files?: Array<{ path: string; contentType: string; entry: boolean; size: number; sha256: string }>;
  manifest?: ArtifactManifest;
  log?: string;
  failure?: unknown;
}

export const ENTRY_DOCUMENT = 'index.html';
export const BUNDLE_NAME = 'game.js';
export const BUNDLE_STYLE_NAME = 'game.css';
/** Scratch directory name for the in-memory compiler output (never published). */
const COMPILE_DIR = '.moydan-compile';
const SDK_MODULE = '@moydan/sdk';
const CORE_MODULE = '@moydan/core';
const PHASER_MODULE = 'phaser';

/**
 * Candidate file names for the vendored engine bundle. `vendor:toolchain`
 * populates `BUILD_TOOLCHAIN_DIR`; builds never download an engine, so a
 * missing file is a deployment problem and must fail closed with instructions.
 */
const ENGINE_BUNDLE_CANDIDATES = [
  'phaser.esm.js',
  'phaser.esm.min.js',
  'phaser.min.js',
  'phaser.js',
  'phaser.mjs',
  'index.js',
  'index.mjs',
  'dist/phaser.esm.js',
];

const PROJECT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.txt', '.svg', '.html'];

/** Binary assets are referenced by URL, never inlined: they are copied verbatim. */
const EMPTY_LOADER_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.mp3', '.ogg', '.wav',
  '.m4a', '.webm', '.mp4', '.woff', '.woff2', '.ttf', '.otf',
];

const LOADERS: Record<string, esbuild.Loader> = (() => {
  const out: Record<string, esbuild.Loader> = { '.json': 'json', '.txt': 'text', '.svg': 'text', '.css': 'css' };
  for (const extension of EMPTY_LOADER_EXTENSIONS) out[extension] = 'empty';
  return out;
})();

// --- Workspace ---------------------------------------------------------------

/**
 * Write the source tree of one immutable version into a fresh directory.
 *
 * The directory is created by the caller (always a new random path) and deleted
 * afterwards; nothing here may depend on state left over by an earlier build.
 */
export function materialiseProject(projectDir: string, files: Array<{ path: string; content: Uint8Array }>): void {
  mkdirSync(projectDir, { recursive: true });
  for (const file of files) {
    const target = join(projectDir, file.path);
    assertInsideDirectory(projectDir, target, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

// --- Entry resolution --------------------------------------------------------

export function sdkEntryPath(repoRoot: string): string {
  return join(repoRoot, 'packages', 'sdk', 'src', 'index.ts');
}

export function coreEntryPath(repoRoot: string): string {
  return join(repoRoot, 'packages', 'core', 'src', 'index.ts');
}

/** Locate the pinned engine bundle inside the vendored toolchain directory. */
export function resolveEngineEntry(toolchainDir: string, engine: GameManifest['engine']): string | null {
  if (engine.name === 'canvas2d') return null;
  if (engine.version !== BUILD_PHASER_VERSION) {
    throw new BuildFailure(
      'validation_failed',
      `This build toolchain only ships Phaser ${BUILD_PHASER_VERSION}; the manifest asks for ${engine.version}.`,
      { diagnostics: [{ code: 'engine_version', message: `expected ${BUILD_PHASER_VERSION}, got ${engine.version}` }] },
    );
  }
  for (const candidate of ENGINE_BUNDLE_CANDIDATES) {
    const full = join(toolchainDir, candidate);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  throw new BuildFailure(
    'build_failed',
    `The vendored Phaser ${BUILD_PHASER_VERSION} bundle is missing from the build toolchain (${toolchainDir}).`,
    {
      diagnostics: [
        {
          code: 'toolchain_incomplete',
          message: 'Run `npm run vendor:toolchain` on the worker host. Builds never download engines at build time.',
        },
      ],
    },
  );
}

// --- esbuild -----------------------------------------------------------------

/**
 * Resolution policy plugin.
 *
 * Bare specifiers are matched against a three-entry allowlist that points at
 * files inside the platform itself; relative specifiers are resolved by hand so
 * they can be proven to stay inside one of the allowed roots (the project, the
 * platform's own package sources, or the vendored toolchain). Everything else is
 * rejected before the compiler ever looks at a registry or at a file outside
 * those roots.
 */
function sandboxResolver(spec: SandboxSpec, engineEntry: string | null): esbuild.Plugin {
  const projectDir = resolve(spec.projectDir);
  const platformModules: Record<string, string> = {
    [SDK_MODULE]: sdkEntryPath(spec.repoRoot),
    [CORE_MODULE]: coreEntryPath(spec.repoRoot),
  };
  if (engineEntry) platformModules[PHASER_MODULE] = engineEntry;
  const available = Object.keys(platformModules).sort().join(', ');
  const allowedRoots = [
    projectDir,
    resolve(sdkEntryPath(spec.repoRoot), '..'),
    resolve(coreEntryPath(spec.repoRoot), '..'),
    resolve(spec.toolchainDir),
  ];

  return {
    name: 'moydan-sandbox-resolver',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Entry points are chosen by the platform (from the validated manifest),
        // not by the project, so they bypass the policy.
        if (args.kind === 'entry-point') return null;
        const specifier = args.path;
        if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
          const resolved = resolveRelativeImport(args.importer, specifier, allowedRoots);
          if (!resolved) {
            throw new BuildFailure('validation_failed', `Cannot resolve "${specifier}" in this project.`, {
              diagnostics: [
                {
                  code: 'import_not_found',
                  message: `"${specifier}" was not found in the project.`,
                  path: displayPath(projectDir, args.importer),
                },
              ],
            });
          }
          return { path: resolved };
        }
        const platformEntry = platformModules[specifier];
        if (platformEntry) return { path: platformEntry };
        if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
          throw new BuildFailure('validation_failed', `Games cannot import "${specifier}".`, {
            diagnostics: [
              {
                code: 'external_import',
                message: 'URLs, node builtins and npm packages are not available in a build sandbox. Copy the code into src/ instead.',
                path: displayPath(projectDir, args.importer),
              },
            ],
          });
        }
        throw new BuildFailure('validation_failed', `"${specifier}" cannot be imported in a Moydan project.`, {
          diagnostics: [
            {
              code: 'module_not_allowed',
              message: `Available modules: ${available}. Everything else must live in your own project files.`,
              path: displayPath(projectDir, args.importer),
            },
          ],
        });
      });
    },
  };
}

/**
 * Resolve a relative import by hand.
 *
 * Doing this instead of letting esbuild resolve is what makes "a project may
 * only read its own files" enforceable: the candidate is proven to sit inside
 * one of `allowedRoots` before it is accepted. TypeScript ESM style is handled
 * explicitly (`./util.js` means `util.ts` at compile time).
 */
function resolveRelativeImport(importer: string, specifier: string, allowedRoots: string[]): string | null {
  const from = dirname(importer);
  const bases = new Set([specifier, specifier.replace(/\.(?:js|jsx|mjs|cjs)$/, '')]);
  for (const base of bases) {
    const direct = join(from, base);
    const candidates = [
      direct,
      ...PROJECT_EXTENSIONS.map((extension) => `${direct}${extension}`),
      ...PROJECT_EXTENSIONS.map((extension) => join(direct, `index${extension}`)),
    ];
    for (const candidate of candidates) {
      const full = resolve(from, candidate);
      if (!allowedRoots.some((root) => isInsideDirectory(root, full))) continue;
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // Not a candidate; keep looking.
      }
    }
  }
  return null;
}

function isInsideDirectory(directory: string, target: string): boolean {
  const base = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return target.startsWith(base);
}

function assertInsideDirectory(directory: string, target: string, path: string): void {
  if (!isInsideDirectory(resolve(directory), resolve(target))) {
    throw new BuildFailure('validation_failed', `Refusing to write "${path}" outside the build workspace.`, {
      diagnostics: [{ code: 'path_escape', message: 'Project paths may not traverse outside the project directory.', path }],
    });
  }
}

function relativeTo(directory: string, target: string): string {
  const base = resolve(directory);
  const full = resolve(target);
  return full.startsWith(base) ? full.slice(base.length + 1) : full;
}

/**
 * Path shown to a creator. Workspace and host paths are noise (and leak the
 * build host layout), so anything outside the project collapses to its
 * base name.
 */
function displayPath(projectDir: string, target: string): string {
  const full = resolve(target);
  if (!isInsideDirectory(projectDir, full)) return basename(full);
  return relativeTo(projectDir, full);
}

function basename(path: string): string {
  return path.split(sep).filter(Boolean).pop() ?? path;
}

// --- The build ---------------------------------------------------------------

/**
 * Compile one materialised project. Runs in the isolated child process; throws
 * `BuildFailure` on any problem so the caller can decide how to report it.
 */
export async function runSandboxedBuild(spec: SandboxSpec): Promise<BuildOutput> {
  const started = Date.now();
  const log: string[] = [
    `toolchain ${BUILD_TOOLCHAIN_ID}`,
    `esbuild ${esbuild.version} (pinned ${BUILD_ESBUILD_VERSION})`,
    `entry ${spec.entry}`,
  ];
  if (esbuild.version !== BUILD_ESBUILD_VERSION) {
    throw new BuildFailure(
      'build_failed',
      `The worker loaded esbuild ${esbuild.version}; build toolchain ${BUILD_TOOLCHAIN_ID} requires ${BUILD_ESBUILD_VERSION}.`,
      { diagnostics: [{ code: 'toolchain_drift', message: `esbuild ${esbuild.version} != ${BUILD_ESBUILD_VERSION}` }] },
    );
  }

  const projectDir = resolve(spec.projectDir);
  const outDir = resolve(spec.outDir);
  const engineEntry = resolveEngineEntry(spec.toolchainDir, spec.engine);
  log.push(`engine ${spec.engine.name}${engineEntry ? ` ${spec.engine.version} (vendored)` : ' (platform canvas)'}`);

  const result = await bundle(spec, projectDir, engineEntry, log);
  const files: BuiltArtifactFile[] = [
    { path: BUNDLE_NAME, content: result.javascript, contentType: 'text/javascript', entry: false },
  ];
  if (result.styles) {
    files.push({ path: BUNDLE_STYLE_NAME, content: result.styles, contentType: 'text/css', entry: false });
  }

  const copied = copyAssets(projectDir, log);
  files.push(...copied);

  const indexHtml = renderIndexHtml(spec, { hasStyles: result.styles !== null });
  files.unshift({ path: ENTRY_DOCUMENT, content: indexHtml, contentType: 'text/html', entry: true });

  const sorted = sortByPath(files);
  const manifest = computeArtifactManifest(sorted, [ENTRY_DOCUMENT, BUNDLE_NAME]);
  enforceArtifactLimits(manifest, spec.limits);
  writeOutputTree(outDir, sorted);

  log.push(`files ${manifest.files.length}`);
  for (const file of manifest.files) log.push(`  ${file.path} ${formatBytes(file.size)} ${file.contentType}`);
  log.push(`total ${formatBytes(manifest.totalBytes)}`);
  log.push(`first playable ${formatBytes(manifest.firstPlayableBytes)}`);
  log.push(`done in ${Date.now() - started}ms`);

  return { files: sorted, manifest, log: log.join('\n') };
}

interface BundleResult {
  javascript: Uint8Array;
  styles: Uint8Array | null;
}

async function bundle(spec: SandboxSpec, projectDir: string, engineEntry: string | null, log: string[]): Promise<BundleResult> {
  let buildResult: esbuild.BuildResult<{ write: false; metafile: true }>;
  try {
    buildResult = await esbuild.build({
      entryPoints: [resolve(projectDir, spec.entry)],
      absWorkingDir: projectDir,
      // `write: false` keeps the bundle in memory; the names are still set so
      // the output is recognisable (and cannot silently pick up a hashed name).
      outdir: join(projectDir, COMPILE_DIR),
      entryNames: 'game',
      bundle: true,
      format: 'esm',
      target: 'es2020',
      platform: 'browser',
      minify: true,
      write: false,
      sourcemap: false,
      legalComments: 'none',
      metafile: true,
      loader: LOADERS,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [sandboxResolver(spec, engineEntry)],
    });
  } catch (error) {
    throw esbuildFailure(error, projectDir);
  }

  for (const warning of buildResult.warnings) {
    log.push(`warning: ${warning.text}`);
  }

  let javascript: Uint8Array | null = null;
  let styles: Uint8Array | null = null;
  for (const output of buildResult.outputFiles ?? []) {
    const name = output.path.slice(output.path.lastIndexOf('/') + 1);
    if (name.endsWith('.css')) styles = output.contents;
    else if (name.endsWith('.js')) javascript = output.contents;
    else {
      throw new BuildFailure('build_failed', `The compiler produced an unexpected output file (${name}).`, {
        diagnostics: [
          {
            code: 'unexpected_output',
            message: 'Reference binary assets by URL from assets/ instead of importing them.',
            path: displayPath(projectDir, output.path),
          },
        ],
      });
    }
  }
  if (!javascript) {
    throw new BuildFailure('build_failed', 'The compiler produced no JavaScript bundle.', {
      diagnostics: [{ code: 'empty_bundle', message: `No output was produced for entry "${spec.entry}".` }],
    });
  }
  return { javascript, styles };
}

function esbuildFailure(error: unknown, projectDir: string): BuildFailure {
  const failure = error as {
    errors?: Array<{ text: string; location?: { file: string; line: number; column: number } | null }>;
    warnings?: unknown[];
  };
  if (Array.isArray(failure.errors) && failure.errors.length > 0) {
    const diagnostics: BuildDiagnostic[] = failure.errors.slice(0, 25).map((entry) => ({
      code: 'compile_error',
      message:
        entry.location && entry.location.line > 0
          ? `${entry.text} (line ${entry.location.line}, column ${entry.location.column})`
          : entry.text,
      path: entry.location ? displayPath(projectDir, entry.location.file) : undefined,
    }));
    const first = failure.errors[0];
    return new BuildFailure('validation_failed', first?.text ?? 'The project did not compile.', { diagnostics });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BuildFailure('build_failed', message.slice(0, 400), { cause: error });
}

function copyAssets(projectDir: string, log: string[]): BuiltArtifactFile[] {
  const out: BuiltArtifactFile[] = [];
  for (const path of listAssetPaths(projectDir)) {
    const content = new Uint8Array(readFileSync(join(projectDir, path)));
    const contentType = contentTypeForPath(path);
    const check = verifyFileBytes(path, content, contentType);
    if (!check.ok) {
      throw new BuildFailure(
        'validation_failed',
        `Asset "${path}" failed content validation: ${check.message ?? 'unsupported content'}.`,
        {
          diagnostics: [
            {
              code: check.reason ?? 'asset_invalid',
              message: check.message ?? 'The file does not match its extension.',
              path,
            },
          ],
        },
      );
    }
    out.push({ path, content, contentType, entry: false });
  }
  if (out.length > 0) log.push(`assets ${out.length}`);
  return out;
}

function listAssetPaths(projectDir: string): string[] {
  const found: string[] = [];
  for (const root of ['assets', 'public']) walk(join(projectDir, root), projectDir, found);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function walk(directory: string, projectDir: string, out: string[]): void {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(directory, entry.name);
    if (!isInsideDirectory(projectDir, resolve(full))) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      walk(full, projectDir, out);
      continue;
    }
    out.push(relativeTo(projectDir, full));
  }
}

// --- Host document -----------------------------------------------------------

/**
 * The artifact's entry document.
 *
 * Requirements it has to satisfy: the origin serves it with a strict CSP that
 * forbids inline script and every foreign origin, so there is no inline
 * JavaScript and no external URL here - only same-origin module scripts. The
 * canvas host is a full-viewport stage the SDK appends `#moydan-game` to, and
 * the error box becomes visible purely through `:not(:empty)` so the platform
 * shell (compiled into the SDK bundle) can fill it in without inline script.
 */
export function renderIndexHtml(spec: SandboxSpec, options: { hasStyles: boolean }): Uint8Array {
  const title = escapeHtml(`${spec.title} - Moydan`);
  const orientation = spec.orientation === 'any' ? 'any' : spec.orientation;
  const stageLabel = escapeHtml(`Game: ${spec.title}`);
  const stylesheet = options.hasStyles ? `<link rel="stylesheet" href="./${BUNDLE_STYLE_NAME}">\n` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
${stylesheet}<style>
:root { color-scheme: dark; }
html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; background: #0b0b12; color: #e8e8f0;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overscroll-behavior: none; touch-action: none; }
#moydan-stage { position: fixed; inset: 0; width: 100%; height: 100%; }
#moydan-stage canvas { display: block; }
#moydan-loading { position: absolute; inset: auto 0 50% 0; text-align: center; color: #8a8aa0; letter-spacing: .08em;
  text-transform: uppercase; font-size: 12px; }
#moydan-loading[hidden] { display: none; }
#moydan-error { display: none; position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  max-width: min(90vw, 420px); padding: 16px 18px; border-radius: 10px; background: #1b1020; color: #ffd9d9;
  border: 1px solid #52204a; box-shadow: 0 8px 32px rgba(0,0,0,.5); white-space: pre-wrap; overflow-wrap: anywhere; }
#moydan-error:not(:empty) { display: block; }
@media (orientation: ${orientation}) { html, body { height: 100dvh; } }
</style>
</head>
<body>
<div id="moydan-stage" role="application" aria-label="${stageLabel}"><div id="moydan-loading">Loading</div></div>
<div id="moydan-error" role="alert" aria-live="assertive"></div>
<script type="module" src="/sdk/moydan-sdk.js"></script>
<script type="module" src="./${BUNDLE_NAME}"></script>
</body>
</html>
`;
  return new TextEncoder().encode(html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Artifact manifest -------------------------------------------------------

export function sortByPath<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Build the artifact manifest.
 *
 * `firstPlayableBytes` is what a player must download before the game can run
 * at all: the host document plus the bundle. The engine is inlined into
 * `game.js`, so its bytes are already counted; assets load lazily afterwards.
 */
export function computeArtifactManifest(files: BuiltArtifactFile[], firstPlayablePaths: string[]): ArtifactManifest {
  const sorted = sortByPath(files);
  const entries: ArtifactManifestFile[] = sorted.map((file) => {
    const problem = checkArtifactPath(file.path);
    if (problem) {
      throw new BuildFailure('build_failed', `Artifact path "${file.path}" is not publishable: ${problem.message}`, {
        diagnostics: [{ code: problem.code, message: problem.message, path: file.path }],
      });
    }
    return {
      path: file.path,
      size: file.content.byteLength,
      contentType: file.contentType,
      sha256: sha256Hex(file.content),
    };
  });
  const firstPlayable = new Set(firstPlayablePaths);
  const firstPlayableBytes = entries
    .filter((file) => firstPlayable.has(file.path))
    .reduce((sum, file) => sum + file.size, 0);
  return {
    version: ARTIFACT_MANIFEST_VERSION,
    entry: ENTRY_DOCUMENT,
    files: entries,
    totalBytes: entries.reduce((sum, file) => sum + file.size, 0),
    firstPlayableBytes,
  };
}

/** Fail closed: every platform artifact budget is checked before anything is uploaded. */
export function enforceArtifactLimits(manifest: ArtifactManifest, limits: Limits): void {
  if (manifest.files.length > limits.maxArtifactFiles) {
    throw new BuildFailure('validation_failed', `The build produced ${manifest.files.length} files; the limit is ${limits.maxArtifactFiles}.`, {
      diagnostics: [{ code: 'too_many_files', message: `limit is ${limits.maxArtifactFiles} files` }],
    });
  }
  if (manifest.totalBytes > limits.maxArtifactBytes) {
    throw new BuildFailure('validation_failed', `The artifact is ${formatBytes(manifest.totalBytes)}; the limit is ${formatBytes(limits.maxArtifactBytes)}.`, {
      diagnostics: [
        {
          code: 'too_large',
          message: `artifact is ${manifest.totalBytes} bytes, limit is ${limits.maxArtifactBytes} bytes`,
        },
      ],
    });
  }
  if (manifest.firstPlayableBytes > limits.maxFirstPlayableBytes) {
    throw new BuildFailure(
      'validation_failed',
      `The first playable payload is ${formatBytes(manifest.firstPlayableBytes)}; the limit is ${formatBytes(limits.maxFirstPlayableBytes)}.`,
      {
        diagnostics: [
          {
            code: 'first_playable_too_large',
            message: `first playable payload is ${manifest.firstPlayableBytes} bytes, limit is ${limits.maxFirstPlayableBytes} bytes`,
          },
        ],
      },
    );
  }
}

// --- Output ------------------------------------------------------------------

/** Persist the artifact inside the workspace so the parent can read it back. */
export function writeOutputTree(outDir: string, files: BuiltArtifactFile[]): void {
  for (const file of files) {
    const target = join(outDir, file.path);
    assertInsideDirectory(outDir, target, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

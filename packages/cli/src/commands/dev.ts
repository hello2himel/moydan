/**
 * `moydan dev` — watch + local preview with the real sandbox constraints.
 *
 * The preview server is deliberately not a "static file server with hot reload".
 * It serves the built artifact with the game origin's Content-Security-Policy,
 * hosts the SDK at `/sdk/v1/index.js` and the pinned engine at
 * `/vendor/phaser.min.js` exactly like the platform does, and embeds the game
 * in a harness page whose iframe carries the same `sandbox` attributes as
 * `GameHost`. The harness speaks bridge protocol v1, so lifecycle commands,
 * storage requests and scores behave like a real play session.
 *
 * A game that would be blocked on the platform fails here first, which is the
 * whole point of a preview server for untrusted code.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';
import type { GameManifest, Limits } from '@moydan/core';
import { optionNumber, optionString, unknownOptions, type ParsedArgs } from '../args.ts';
import { SDK_MODULE_PATH, assertToolchain, buildArtifact, type BuildResult } from '../bundle.ts';
import { HOST_SHIM_JS, renderHarnessHtml, type DevConfig } from '../harness.ts';
import { sdkEntrySource, vendoredEnginePath, resolveRepoRoot } from '../repo.ts';
import { loadProject } from '../validate.ts';
import { CliError, EXIT_FAILURE, EXIT_USAGE, formatBytes, line, printIssues, warn } from '../ui.ts';

const DEFAULT_PORT = 5175;
const ARTIFACT_PREFIX = '/game/';
const WATCH_DEBOUNCE_MS = 120;

export interface DevOptions {
  port: number;
  host: string;
}

/**
 * The Content-Security-Policy the game origin applies to release artifacts.
 * `moydan dev` sends the same header, so a game that only works because of an
 * inline script, a remote font or `unsafe-eval` never reaches production.
 */
export function gameOriginCsp(port: number): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors 'self' http://localhost:${port} http://127.0.0.1:${port}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
  ].join('; ');
}

function gameHeaders(port: number, contentType: string, length: number): Record<string, string> {
  return {
    'content-type': contentType,
    'content-length': String(length),
    'content-security-policy': gameOriginCsp(port),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

/** Bundle the platform SDK once: the game origin serves one copy to everyone. */
async function buildSdk(repoRoot: string): Promise<Uint8Array> {
  const result = await esbuild.build({
    entryPoints: [sdkEntrySource(repoRoot)],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    write: false,
    outfile: 'index.js',
    absWorkingDir: repoRoot,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new CliError('could not bundle the platform SDK for the preview server');
  return new Uint8Array(output.contents);
}

function devConfigFor(manifest: GameManifest): DevConfig {
  const params: Record<string, number | boolean | string> = {};
  for (const parameter of manifest.remix.parameters) params[parameter.key] = parameter.default;
  return {
    slug: manifest.slug,
    title: manifest.title,
    engine: `${manifest.engine.name} ${manifest.engine.version}`,
    entry: manifest.entry,
    apiVersion: manifest.runtime.apiVersion,
    capabilities: [...manifest.capabilities],
    viewport: { ...manifest.viewport },
    orientation: manifest.orientation,
    params,
    artifactEntry: `${ARTIFACT_PREFIX}index.html`,
  };
}

export async function devCommand(args: ParsedArgs): Promise<number> {
  const unknown = unknownOptions(args, ['port', 'host', 'dir', 'open']);
  if (unknown.length > 0) {
    warn(`unknown option(s): ${unknown.join(', ')}`);
    return EXIT_USAGE;
  }
  assertToolchain();
  const dir = args.positionals[0] ?? optionString(args, 'dir', '.');
  const report = loadProject({ dir });
  if (!report.manifest || report.issues.length > 0) {
    printIssues('cannot start the preview server', report.issues);
    return EXIT_FAILURE;
  }

  const repoRoot = resolveRepoRoot();
  const port = optionNumber(args, 'port', DEFAULT_PORT);
  const host = optionString(args, 'host', '127.0.0.1');
  const project = report.project;
  const limits: Limits = report.limits;

  const sdk: Uint8Array = await buildSdk(repoRoot);
  let engine: Uint8Array | null = null;

  const rebuild = async (quiet: boolean): Promise<BuildResult | null> => {
    const started = performance.now();
    try {
      const fresh = loadProject({ dir: project.root });
      if (!fresh.manifest || fresh.issues.length > 0) {
        throw new CliError(`manifest is invalid: ${fresh.issues[0]?.path ?? '$'} ${fresh.issues[0]?.message ?? ''}`);
      }
      const result = await buildArtifact(fresh.project, repoRoot, { limits, minify: false });
      if (result.issues.length > 0) {
        warn(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
        return null;
      }
      if (!quiet) {
        line(`  rebuilt in ${Math.round(performance.now() - started)} ms — ${formatBytes(result.payloadBytes)} payload`);
      }
      return result;
    } catch (error) {
      warn(`build failed, keeping the previous artifact: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  // Bound once so the request handler keeps a non-null artifact: the watcher
  // swaps the contents, never the existence.
  const initialBuild = await rebuild(false);
  if (!initialBuild) return EXIT_FAILURE;
  let current = initialBuild;
  // Built once: the SDK is a static module from the host's point of view.
  const enginePath = vendoredEnginePath(repoRoot) ?? resolve(repoRoot, 'node_modules', 'phaser', 'dist', 'phaser.esm.min.js');
  if (existsSync(enginePath)) engine = new Uint8Array(readFileSync(enginePath));

  const clients = new Set<ServerResponse>();

  const sendBytes = (response: ServerResponse, bytes: Uint8Array, headers: Record<string, string>): void => {
    response.writeHead(200, headers);
    response.end(bytes);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, options: { port: number }): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      response.end('method not allowed');
      return;
    }

    if (path === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    if (path === '/dev-host.js') {
      const bytes = new TextEncoder().encode(HOST_SHIM_JS);
      sendBytes(response, bytes, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
      });
      return;
    }

    if (path === '/') {
      const bytes = new TextEncoder().encode(renderHarnessHtml(devConfigFor(current.manifest)));
      sendBytes(response, bytes, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(bytes.byteLength),
        // The harness page is the *application* side of the sandbox, so it may
        // load its own scripts; the artifact itself never gets this policy.
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'",
        'cache-control': 'no-store',
      });
      return;
    }

    if (path === SDK_MODULE_PATH) {
      sendBytes(response, sdk, gameHeaders(options.port, 'text/javascript; charset=utf-8', sdk.byteLength));
      return;
    }

    if (path === '/vendor/phaser.min.js') {
      if (!engine) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('the pinned Phaser bundle is not vendored; run "npm run vendor:toolchain"');
        return;
      }
      sendBytes(response, engine, gameHeaders(options.port, 'text/javascript; charset=utf-8', engine.byteLength));
      return;
    }

    if (path.startsWith(ARTIFACT_PREFIX)) {
      const relativePath = decodeURIComponent(path.slice(ARTIFACT_PREFIX.length));
      const file = current.files.find((candidate) => candidate.path === relativePath);
      if (!file) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`not in the artifact: ${relativePath}`);
        return;
      }
      sendBytes(response, file.bytes, gameHeaders(options.port, file.contentType, file.bytes.byteLength));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  };

  const server = createServer((request, response) => {
    void handle(request, response, { port }).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rejectPromise(new CliError(`cannot listen on ${host}:${port}: ${error.code === 'EADDRINUSE' ? 'port already in use' : error.message}`));
    });
    server.listen(port, host, () => resolvePromise());
  });

  const built = current;
  line(`moydan dev  ${built.manifest.slug}  ${project.root}`);
  line(`  preview     http://${host}:${port}/  (harness: lifecycle, storage, scores)`);
  line(`  artifact    http://${host}:${port}${ARTIFACT_PREFIX}${built.entry}  (CSP: ${gameOriginCsp(port).split(';')[0]?.trim()}…)`);
  line(`  sdk         http://${host}:${port}${SDK_MODULE_PATH}`);
  if (engine) line(`  engine      http://${host}:${port}/vendor/phaser.min.js`);
  line(`  payload     ${formatBytes(built.payloadBytes)} across ${built.files.length} files`);
  line('  watching    src/, assets/ and game.json — Ctrl-C to stop');
  line();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher: FSWatcher = watch(project.root, { recursive: true }, (_event, filename) => {
    const changed = String(filename ?? '');
    if (changed.startsWith('dist') || changed.includes('node_modules') || changed.split('/').some((part) => part.startsWith('.'))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        const rebuilt = await rebuild(true);
        if (!rebuilt) return;
        current = rebuilt;
        line('  change detected, rebuilt — reloading preview');
        for (const client of clients) client.write('event: reload\ndata: {}\n\n');
      })();
    }, WATCH_DEBOUNCE_MS);
  });

  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => {
      line();
      line('shutting down');
      watcher.close();
      for (const client of clients) client.end();
      server.close(() => resolvePromise());
      // Nothing should keep the event loop alive; do not wait for keep-alives.
      server.closeAllConnections?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

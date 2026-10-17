#!/usr/bin/env node
/**
 * Stage everything the Tauri desktop shell needs to run the platform locally.
 *
 *   node scripts/build-desktop.mjs [--platform linux|win] [--skip-node]
 *
 * Output: `apps/desktop/src-tauri/resources/`
 *
 *   node/         Node.js runtime for the target platform (nothing else provides one)
 *   server/       the platform server code, bundled from TypeScript
 *   node_modules/ the runtime dependencies those servers resolve
 *   web/          the production web build, served by the API process
 *
 * Creator code is never involved: this only assembles the platform itself.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps', 'desktop', 'src-tauri', 'resources');

const args = process.argv.slice(2);
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : hostPlatform();
const skipNode = args.includes('--skip-node');

function hostPlatform() {
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
}

const NODE_VERSION = process.env.MOYDAN_NODE_VERSION ?? 'v22.20.0';
const ESBUILD_VERSION = JSON.parse(
  await readFile(join(ROOT, 'node_modules', 'esbuild', 'package.json'), 'utf8'),
).version;

console.log(`[desktop] staging for platform=${platform} node=${NODE_VERSION} esbuild=${ESBUILD_VERSION}`);

await mkdir(OUT, { recursive: true });
await rm(join(OUT, 'server'), { recursive: true, force: true });
await rm(join(OUT, 'node_modules'), { recursive: true, force: true });
await mkdir(join(OUT, 'server'), { recursive: true });

// ---------------------------------------------------------------------------
// 1. Bundle the platform server code
// ---------------------------------------------------------------------------
const entries = [
  ['apps/api/src/server.ts', 'api.mjs'],
  ['apps/game-origin/src/server.ts', 'game-origin.mjs'],
  ['apps/worker/src/main.ts', 'worker.mjs'],
];

for (const [entry, name] of entries) {
  const source = join(ROOT, entry);
  if (!existsSync(source)) {
    console.warn(`[desktop] ${entry} is missing; the app will start without it`);
    continue;
  }
  await build({
    entryPoints: [source],
    outfile: join(OUT, 'server', name),
    platform: 'node',
    target: 'node22',
    format: 'esm',
    bundle: true,
    // Third-party packages stay external and are shipped in resources/node_modules;
    // our own workspace code is bundled so no TypeScript has to be executed.
    external: [
      'fastify',
      '@fastify/*',
      'fflate',
      'esbuild',
      '@esbuild/*',
      'node:*',
      'better-sqlite3',
    ],
    logLevel: 'warning',
  });
  console.log(`[desktop] bundled ${entry} -> resources/server/${name}`);
}

await writeFile(join(OUT, 'server', 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 2. Runtime dependencies
// ---------------------------------------------------------------------------
async function copyRuntimeDependencies(names, target) {
  const rootModules = join(ROOT, 'node_modules');
  const seen = new Set();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const manifestPath = join(rootModules, name, 'package.json');
    if (!existsSync(manifestPath)) {
      console.warn(`[desktop] dependency ${name} is not installed; skipping`);
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const destination = join(target, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(rootModules, name), destination, {
      recursive: true,
      dereference: true,
      filter: (source) => !source.includes(`${name}/node_modules/`),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push(dependency);
  }
  return seen;
}

const copied = await copyRuntimeDependencies(
  ['fastify', '@fastify/cookie', '@fastify/rate-limit', 'fflate', 'esbuild'],
  join(OUT, 'node_modules'),
);
console.log(`[desktop] copied ${copied.size} runtime packages`);

// The esbuild native binary has to match the *target* platform, not this one.
const esbuildBinaryPackage = `@esbuild/${platform === 'win' ? 'win32' : platform === 'mac' ? 'darwin' : 'linux'}-x64`;
const localBinary = join(ROOT, 'node_modules', esbuildBinaryPackage);
const targetBinary = join(OUT, 'node_modules', esbuildBinaryPackage);
if (!existsSync(localBinary)) {
  console.log(`[desktop] fetching ${esbuildBinaryPackage}@${ESBUILD_VERSION} for the target platform`);
  const tarball = await download(
    `https://registry.npmjs.org/${esbuildBinaryPackage}/-/${esbuildBinaryPackage.split('/')[1]}-${ESBUILD_VERSION}.tgz`,
  );
  const work = join(tmpdir(), `moydan-esbuild-${platform}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'package.tgz'), tarball);
  execFileSync('tar', ['-xzf', join(work, 'package.tgz'), '-C', work]);
  await mkdir(dirname(targetBinary), { recursive: true });
  await cp(join(work, 'package'), targetBinary, { recursive: true });
  await rm(work, { recursive: true, force: true });
} else {
  await mkdir(dirname(targetBinary), { recursive: true });
  await cp(localBinary, targetBinary, { recursive: true });
}
console.log(`[desktop] esbuild binary staged for ${platform}`);

// ---------------------------------------------------------------------------
// 3. Node.js runtime
// ---------------------------------------------------------------------------
if (!skipNode) {
  const nodeDir = join(OUT, 'node');
  await rm(nodeDir, { recursive: true, force: true });
  const archiveName =
    platform === 'win'
      ? `node-${NODE_VERSION}-win-x64.zip`
      : platform === 'mac'
        ? `node-${NODE_VERSION}-darwin-x64.tar.gz`
        : `node-${NODE_VERSION}-linux-x64.tar.xz`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`;
  console.log(`[desktop] downloading ${url}`);
  const archive = await download(url);
  const work = join(tmpdir(), `moydan-node-${platform}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const archivePath = join(work, archiveName);
  await writeFile(archivePath, archive);
  if (archiveName.endsWith('.zip')) {
    execFileSync('unzip', ['-q', archivePath, '-d', work]);
  } else {
    execFileSync('tar', ['-xf', archivePath, '-C', work]);
  }
  const extracted = (await readdir(work, { withFileTypes: true })).find((entry) => entry.isDirectory());
  if (!extracted) throw new Error('unexpected Node archive layout');
  await cp(join(work, extracted.name), nodeDir, { recursive: true, dereference: true });
  await rm(work, { recursive: true, force: true });
  const binary = platform === 'win' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node');
  const info = await stat(binary);
  console.log(`[desktop] Node runtime staged (${(info.size / 1024 / 1024).toFixed(1)} MiB)`);
}

// ---------------------------------------------------------------------------
// 4. Web application
// ---------------------------------------------------------------------------
const webDist = join(ROOT, 'apps', 'web', 'dist');
if (existsSync(webDist)) {
  await rm(join(OUT, 'web'), { recursive: true, force: true });
  await cp(webDist, join(OUT, 'web'), { recursive: true });
  console.log('[desktop] web build staged');
} else {
  console.warn('[desktop] apps/web/dist is missing - run `npm run build -w @moydan/web` first');
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}


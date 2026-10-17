#!/usr/bin/env node
/**
 * Vendor the pinned build toolchain from `node_modules` into `vendor/toolchain/`.
 *
 * Why this exists: builds must be reproducible and must never reach the network.
 * The worker refuses to build with an esbuild whose version differs from
 * `BUILD_ESBUILD_VERSION`, and Phaser games import the engine from the game
 * origin instead of bundling 1.4 MB into every artifact. Both dependencies are
 * therefore pinned in `packages/core/src/version.ts`, copied here, and recorded
 * with their sha256 so a tampered or stale vendor directory is detectable.
 *
 * Usage:
 *   node scripts/vendor-toolchain.mjs           # populate vendor/toolchain/
 *   node scripts/vendor-toolchain.mjs --check   # verify an existing vendor dir
 *
 * Exit codes: 0 ok, 1 pin mismatch or corrupt vendor directory.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_ESBUILD_VERSION,
  BUILD_PHASER_VERSION,
  BUILD_TOOLCHAIN_ID,
  PLATFORM_VERSION,
} from '../packages/core/src/version.ts';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const vendorRoot = resolve(repoRoot, 'vendor', 'toolchain');
const manifestPath = join(vendorRoot, 'manifest.json');

/** Where the vendored files come from, relative to the repository root. */
const SOURCES = {
  phaserEsm: 'node_modules/phaser/dist/phaser.esm.min.js',
  phaserPackage: 'node_modules/phaser/package.json',
  esbuildPackage: 'node_modules/esbuild/package.json',
};

const VENDORED_FILES = [
  {
    name: 'phaser',
    description: 'Phaser ESM browser bundle served by the game origin at /vendor/phaser.min.js',
    source: SOURCES.phaserEsm,
    target: 'phaser.min.js',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Resolve an installed package and assert its version matches the pin.
 * Returns the resolved directory plus the native binary of the esbuild
 * platform package, which is what the worker actually executes.
 */
function resolvePin(packageJsonRelative, expectedVersion, label) {
  const packageJsonPath = resolve(repoRoot, packageJsonRelative);
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `${packageJsonRelative} is missing. Run "npm install" at the repository root before vendoring the toolchain.`,
    );
  }
  const manifest = readJson(packageJsonPath);
  const installed = typeof manifest.version === 'string' ? manifest.version : '(unknown)';
  if (installed !== expectedVersion) {
    throw new Error(
      `${label} version mismatch: ${packageJsonRelative} is ${installed} but ${expectedVersion} is pinned.\n` +
        `Update packages/core/src/version.ts only together with a deliberate dependency upgrade.`,
    );
  }
  return { path: packageJsonPath, version: installed, name: manifest.name ?? label };
}

/** The esbuild platform package holds the actual native executable. */
function esbuildNativeBinary() {
  const platform = `${process.platform}-${process.arch}`;
  const relativePath = `node_modules/@esbuild/${platform}/bin/esbuild`;
  const absolute = resolve(repoRoot, relativePath);
  if (!existsSync(absolute)) return null;
  const version = readJson(resolve(repoRoot, `node_modules/@esbuild/${platform}/package.json`)).version;
  if (version !== BUILD_ESBUILD_VERSION) {
    throw new Error(
      `esbuild native package mismatch: ${relativePath} is ${version} but ${BUILD_ESBUILD_VERSION} is pinned.`,
    );
  }
  return { path: relativePath, absolute, version, platform };
}

function listVendorFiles(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relativePath = relative(root, full).split(sep).join('/');
      if (relativePath === 'manifest.json') continue;
      found.push(relativePath);
    }
  };
  walk(root);
  return found;
}

function buildManifest(native) {
  const pins = {
    esbuild: {
      version: BUILD_ESBUILD_VERSION,
      package: SOURCES.esbuildPackage,
      ...(native ? { platform: native.platform, binary: native.path, binarySha256: sha256(readFileSync(native.absolute)) } : {}),
    },
    phaser: {
      version: BUILD_PHASER_VERSION,
      package: SOURCES.phaserPackage,
    },
  };
  const files = VENDORED_FILES.map((file) => {
    const bytes = readFileSync(resolve(repoRoot, file.source));
    return {
      name: file.name,
      description: file.description,
      source: file.source,
      path: file.target,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
  return {
    manifestVersion: 1,
    platform: PLATFORM_VERSION,
    toolchainId: BUILD_TOOLCHAIN_ID,
    pins,
    files,
  };
}

function populate() {
  resolvePin(SOURCES.esbuildPackage, BUILD_ESBUILD_VERSION, 'esbuild');
  resolvePin(SOURCES.phaserPackage, BUILD_PHASER_VERSION, 'phaser');
  const native = esbuildNativeBinary();

  const missing = VENDORED_FILES.filter((file) => !existsSync(resolve(repoRoot, file.source)));
  if (missing.length > 0) {
    throw new Error(
      `Pinned engine bundle missing: ${missing.map((file) => file.source).join(', ')}.\n` +
        'The published Phaser package must ship dist/phaser.esm.min.js.',
    );
  }

  // Rebuild from scratch so a removed engine never lingers in the vendor tree.
  if (existsSync(vendorRoot)) rmSync(vendorRoot, { recursive: true, force: true });
  mkdirSync(vendorRoot, { recursive: true });

  const manifest = buildManifest(native);
  for (const file of VENDORED_FILES) {
    const target = resolve(vendorRoot, file.target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolve(repoRoot, file.source)));
    process.stdout.write(`vendored ${file.target} (${humanBytes(statSync(target).size)})\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${relative(repoRoot, manifestPath)}\n`);
  process.stdout.write(`toolchain ${BUILD_TOOLCHAIN_ID}\n`);
  return EXIT_OK;
}

function check() {
  const problems = [];
  if (!existsSync(manifestPath)) {
    process.stderr.write(`vendor/toolchain is not populated: ${relative(repoRoot, manifestPath)} is missing\n`);
    return EXIT_FAILURE;
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    process.stderr.write(`vendor/toolchain/manifest.json is not valid JSON: ${error.message}\n`);
    return EXIT_FAILURE;
  }

  // The pins recorded at vendor time must still match the pins in the source.
  const expected = {
    esbuild: BUILD_ESBUILD_VERSION,
    phaser: BUILD_PHASER_VERSION,
  };
  for (const [name, version] of Object.entries(expected)) {
    const recorded = manifest.pins?.[name]?.version;
    if (recorded !== version) {
      problems.push(`pin ${name}: manifest records ${recorded ?? '(none)'}, packages/core pins ${version}`);
    }
  }
  if (manifest.toolchainId !== BUILD_TOOLCHAIN_ID) {
    problems.push(`toolchainId is ${manifest.toolchainId ?? '(none)'}, expected ${BUILD_TOOLCHAIN_ID}`);
  }
  try {
    resolvePin(SOURCES.esbuildPackage, BUILD_ESBUILD_VERSION, 'esbuild');
    resolvePin(SOURCES.phaserPackage, BUILD_PHASER_VERSION, 'phaser');
  } catch (error) {
    problems.push(error.message);
  }

  const recordedFiles = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of recordedFiles) {
    const absolute = resolve(vendorRoot, file.path);
    if (!existsSync(absolute)) {
      problems.push(`missing vendored file ${file.path}`);
      continue;
    }
    const bytes = readFileSync(absolute);
    const digest = sha256(bytes);
    if (digest !== file.sha256) {
      problems.push(`sha256 mismatch for ${file.path}: expected ${file.sha256}, found ${digest}`);
    }
    if (bytes.byteLength !== file.bytes) {
      problems.push(`size mismatch for ${file.path}: expected ${file.bytes}, found ${bytes.byteLength}`);
    }
  }
  const actual = listVendorFiles(vendorRoot);
  for (const path of actual) {
    if (!recordedFiles.some((file) => file.path === path)) {
      problems.push(`unexpected file in vendor/toolchain: ${path}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write('vendor/toolchain check failed:\n');
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return EXIT_FAILURE;
  }
  for (const file of recordedFiles) {
    process.stdout.write(`ok ${file.path} ${file.sha256.slice(0, 12)}… ${humanBytes(file.bytes)}\n`);
  }
  process.stdout.write(`ok toolchain ${manifest.toolchainId}\n`);
  return EXIT_OK;
}

function main(argv) {
  const checkOnly = argv.includes('--check');
  const unknown = argv.filter((argument) => argument.startsWith('-') && argument !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option(s): ${unknown.join(' ')}\nUsage: node scripts/vendor-toolchain.mjs [--check]\n`);
    return 2;
  }
  try {
    return checkOnly ? check() : populate();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
}

process.exitCode = main(process.argv.slice(2));

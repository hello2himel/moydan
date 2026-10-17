#!/usr/bin/env node
/**
 * Build every distributable on this machine and write checksums.
 *
 *   node scripts/release.mjs [--only android|windows|linux|flatpak|web] [--tag v0.1.0]
 *
 * Nothing is uploaded: uploading is a separate, explicit step
 * (`gh release create …`) so a failed build can never publish a broken artefact.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-release');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

mkdirSync(DIST, { recursive: true });

function run(command, commandArgs, options = {}) {
  console.log(`\n[36m$ ${command} ${commandArgs.join(' ')}[0m`);
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${result.status}`);
  }
}

function shouldRun(name) {
  return !only || only === name;
}

const artefacts = [];
function collect(directory, filter = () => true) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collect(full, filter);
    else if (filter(full)) artefacts.push(full);
  }
}

// ---------------------------------------------------------------------------
// Web (static bundle, also embedded in the desktop build)
// ---------------------------------------------------------------------------
if (shouldRun('web') || shouldRun('windows') || shouldRun('linux')) {
  run('npm', ['run', 'build', '-w', '@moydan/web']);
  collect(join(ROOT, 'apps', 'web', 'dist'), (file) => /\.(html|js|css|svg|png|json|woff2?)$/.test(file));
}

// ---------------------------------------------------------------------------
// Desktop (Tauri). Resources are staged per target before compiling because the
// Tauri context embeds them into the binary.
// ---------------------------------------------------------------------------
async function buildDesktop(target) {
  const platform = target === 'windows' ? 'win' : 'linux';
  const crateDir = join(ROOT, 'apps', 'desktop', 'src-tauri');
  run('node', [join(ROOT, 'scripts', 'build-desktop.mjs'), '--platform', platform]);

  if (target === 'windows') {
    run('cargo', ['xwin', 'build', '--release', '--target', 'x86_64-pc-windows-msvc'], { cwd: crateDir });
    const exe = join(crateDir, 'target', 'x86_64-pc-windows-msvc', 'release', 'moydan-desktop.exe');
    if (!existsSync(exe)) throw new Error(`Windows binary missing at ${exe}`);
    const staging = join(DIST, 'moydan-windows-x64');
    mkdirSync(staging, { recursive: true });
    spawnSync('cp', [exe, join(staging, 'Moydan.exe')]);
    copyIfPresent(join(ROOT, 'packaging', 'flatpak', 'moydan.desktop'), staging);
    copyIfPresent(join(ROOT, 'packaging', 'flatpak', 'dev.moydan.Moydan.desktop'), staging);
    const zip = join(DIST, `Moydan-${version}-x64-windows.zip`);
    // Written here rather than shelling out to `zip`, which is not installed
    // everywhere and would add a build dependency for no benefit.
    await zipDirectory(staging, zip);
    artefacts.push(zip);
    console.log(`staged ${relative(ROOT, zip)} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MiB)`);
  } else {
    run('cargo', ['build', '--release'], { cwd: crateDir });
    const binary = join(crateDir, 'target', 'release', 'moydan-desktop');
    if (!existsSync(binary)) throw new Error(`Linux binary missing at ${binary}`);
    const staging = join(DIST, 'moydan-linux-x86_64');
    mkdirSync(staging, { recursive: true });
    spawnSync('cp', [binary, join(staging, 'moydan')]);
    spawnSync('chmod', ['+x', join(staging, 'moydan')]);
    for (const file of ['moydan.desktop', 'dev.moydan.Moydan.desktop']) {
      const source = join(ROOT, 'packaging', 'flatpak', file);
      if (existsSync(source)) spawnSync('cp', [source, staging]);
    }
    const archive = join(DIST, `Moydan-${version}-x86_64-linux.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
    artefacts.push(archive);
    console.log(`staged ${relative(ROOT, archive)} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MiB)`);
  }
}

if (shouldRun('windows')) await buildDesktop('windows');
if (shouldRun('linux')) await buildDesktop('linux');

// ---------------------------------------------------------------------------
// Android (APK)
// ---------------------------------------------------------------------------
if (shouldRun('android')) {
  const androidDir = join(ROOT, 'apps', 'android');
  const gradle = process.env.GRADLE_BIN ?? findGradle();
  if (!gradle) throw new Error('No Gradle distribution found. Set GRADLE_BIN or install Gradle 8.13+.');
  const javaHome = process.env.JAVA_HOME ?? findJava21();
  run(gradle, ['assembleRelease'], {
    cwd: androidDir,
    env: {
      JAVA_HOME: javaHome,
      ANDROID_HOME: process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android', 'Sdk'),
      ANDROID_SDK_ROOT: process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android', 'Sdk'),
    },
  });
  const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apk)) throw new Error(`APK not produced at ${apk}`);
  const staged = join(DIST, `Moydan-${version}-android-universal.apk`);
  spawnSync('cp', [apk, staged]);
  artefacts.push(staged);
  console.log(`staged ${relative(ROOT, staged)}`);
}

// ---------------------------------------------------------------------------
// Flatpak
// ---------------------------------------------------------------------------
if (shouldRun('flatpak')) {
  run('bash', [join(ROOT, 'packaging', 'flatpak', 'build-flatpak.sh'), join(DIST, 'flatpak')]);
  collect(join(DIST, 'flatpak'), (file) => file.endsWith('.flatpak'));
}

function copyIfPresent(source, targetDirectory) {
  if (!existsSync(source)) return;
  mkdirSync(targetDirectory, { recursive: true });
  spawnSync('cp', [source, targetDirectory]);
}

/** Deterministic zip of a directory, using the fflate already in the dependency tree. */
async function zipDirectory(directory, outFile) {
  const { zipSync } = await import('fflate');
  const entries = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, key);
      else entries[key] = new Uint8Array(readFileSync(full));
    }
  };
  walk(directory, '');
  writeFileSync(outFile, Buffer.from(zipSync(entries, { level: 9, mtime: new Date('1980-01-01T00:00:00Z') })));
}

// ---------------------------------------------------------------------------
// Checksums + release notes
// ---------------------------------------------------------------------------
const files = artefacts.map((file) => ({ file, size: statSync(file).size }));
files.sort((a, b) => a.file.localeCompare(b.file));

const lines = files.map(({ file }) => {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `${digest}  ${relative(ROOT, file)}`;
});
writeFileSync(join(DIST, 'SHA256SUMS'), `${lines.join('\n')}\n`);

const notes = [
  `# Moydan ${version}`,
  '',
  tag ? `Tag: \`${tag}\`` : 'Tag: (not set — pass --tag v0.1.0)',
  '',
  '| Artefact | Size |',
  '| --- | --- |',
  ...files.map(({ file, size }) => `| \`${relative(ROOT, file)}\` | ${(size / 1024 / 1024).toFixed(1)} MiB |`),
  '',
  'Verify with:',
  '',
  '```bash',
  'sha256sum -c SHA256SUMS',
  '```',
  '',
  '## What these are',
  '',
  '- **Windows** (`Moydan-*-setup-x64.exe`, `Moydan-*-x64-windows.zip`): the desktop shell. It starts the whole',
  '  platform on your machine (API, game origin, build worker, web app) or connects to a deployment via',
  '  `MOYDAN_SERVER_URL`.',
  '- **Android** (`Moydan-*-android-universal.apk`): the mobile shell for a Moydan deployment. Set the server',
  '  address on first launch. Debug-signed unless a release keystore is configured.',
  '- **Linux/Flatpak** (`Moydan-*-x86_64.flatpak`, `Moydan-*-linux.AppImage`): the same shell for Linux.',
  '',
  'Verify the download, then read the [README](https://github.com/hello2himel/moydan) for the full stack.',
  '',
];
writeFileSync(join(DIST, 'RELEASE-NOTES.md'), `${lines.join('\n') ? notes.join('\n') : notes.join('\n')}\n`);

console.log(`\n[32mRelease artefacts ready in ${relative(ROOT, DIST)}[0m`);
for (const { file, size } of files) {
  console.log(`  ${relative(ROOT, file).padEnd(48)} ${(size / 1024 / 1024).toFixed(2)} MiB`);
}
console.log(`\nUpload with:`);
console.log(`  gh release create ${tag ?? 'v' + version} dist-release/* --notes-file dist-release/RELEASE-NOTES.md --title "Moydan ${version}"`);

function findGradle() {
  const candidates = [
    process.env.GRADLE_BIN,
    ...walkGradleDists(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function* walkGradleDists() {
  const home = process.env.HOME ?? '';
  const base = join(home, '.gradle', 'wrapper', 'dists');
  if (!existsSync(base)) return;
  for (const dist of readdirSync(base)) {
    for (const hash of readdirSync(join(base, dist))) {
      for (const version of readdirSync(join(base, dist, hash))) {
        const binary = join(base, dist, hash, version, 'bin', 'gradle');
        if (existsSync(binary)) yield binary;
      }
    }
  }
}

function findJava21() {
  const candidates = [
    process.env.JAVA_HOME_21,
    '/tmp/opencode/jdk',
    '/usr/lib/jvm/java-21-openjdk',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith('jdk')) {
      for (const entry of readdirSync(candidate)) {
        if (entry.startsWith('jdk-21')) return join(candidate, entry);
      }
    } else if (existsSync(join(candidate, 'bin', 'javac'))) {
      return candidate;
    }
  }
  return process.env.JAVA_HOME ?? '';
}

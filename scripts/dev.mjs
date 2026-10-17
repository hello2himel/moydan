#!/usr/bin/env node
/**
 * Run the whole stack locally with prefixed, readable output.
 *
 *   node scripts/dev.mjs                  # migrate + api + game origin + worker + web
 *   node scripts/dev.mjs --no-web         # everything except the Vite dev server
 *   node scripts/dev.mjs --only api,web   # a subset (migrate always runs first)
 *   node scripts/dev.mjs --seed           # seed the database after migrating
 *
 * Every child is killed on Ctrl-C, and if a long-running child exits on its own the
 * whole group is torn down, because a half-running stack is worse than none.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const only = value('only')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? null;
const wantsWeb = !flag('no-web') && (!only || only.includes('web'));

const COLOURS = {
  migrate: '[90m',
  api: '[36m',
  origin: '[35m',
  worker: '[33m',
  web: '[32m',
};
const RESET = '[0m';

const children = [];
let shuttingDown = false;

function start(name, command, commandArgs, options = {}) {
  if (only && !only.includes(name)) return null;
  const colour = COLOURS[name] ?? '';
  const child = spawn(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `${colour}[${name}]${RESET}`;
  const forward = (stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) console.log(`${prefix} ${line}`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`${prefix} exited (code ${code}, signal ${signal ?? 'none'})`);
    shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 2000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function step(label, command, commandArgs) {
  console.log(`${COLOURS.migrate}[${label}]${RESET} ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' });
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(`${COLOURS.migrate}[${label}]${RESET} failed with status ${status}`);
    process.exit(status);
  }
}

// ---------------------------------------------------------------------------

if (!existsSync(join(ROOT, 'node_modules'))) {
  console.error('Dependencies are missing. Run `npm install` first.');
  process.exit(1);
}

console.log('Moydan development stack');
console.log('  app origin   http://localhost:5173');
console.log('  api          http://localhost:8787');
console.log('  game origin  http://localhost:5174');
console.log('');

step('migrate', 'node', ['apps/api/src/db/migrate-cli.ts']);
if (flag('seed')) step('seed', 'node', ['apps/api/src/db/seed.ts']);

start('api', 'node', ['apps/api/src/server.ts']);
start('origin', 'node', ['apps/game-origin/src/server.ts']);
start('worker', 'node', ['apps/worker/src/main.ts']);
if (wantsWeb) start('web', 'npm', ['run', 'dev', '-w', '@moydan/web']);

console.log('Press Ctrl-C to stop everything.');

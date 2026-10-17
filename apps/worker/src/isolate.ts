/**
 * Process isolation for the compile step.
 *
 * Compiling a project means running a compiler over *creator-authored* files.
 * That is not the same as running the game, but a hostile project can still try
 * to read files, exfiltrate through DNS, or fork-bomb the worker, so the
 * compile step never happens inside a request handler and never happens in the
 * worker's own process:
 *
 *   - the source tree is materialised into a *fresh* random directory that is
 *     deleted in a `finally` block, so two builds can never influence each other
 *     and a crashed build leaves nothing to clean up;
 *   - the child runs with a *scrubbed* environment built from an allow list -
 *     no `DATABASE_URL`, no `SESSION_SECRET`, no `WORKER_JOB_SECRET`, no cloud
 *     credentials, no npm tokens - with its `HOME`/`TMPDIR` inside the workspace
 *     so it cannot read the operator's dotfiles;
 *   - memory and wall-clock are capped (`--max-old-space-size` plus a kill
 *     timer), and with `BUILD_USE_DOCKER=1` the same command runs in a
 *     container with `--network=none`.
 *
 * The child communicates through files only (build spec in, result and artifact
 * out), so the same code path works for a bare process and a container.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { type GameManifest, type Limits } from '@moydan/core';
import {
  enforceArtifactLimits,
  materialiseProject,
  type ArtifactManifest,
  type BuiltArtifactFile,
  type SandboxResultFile,
  type SandboxSpec,
} from './bundler.ts';
import { sha256Hex } from './digest.ts';
import { BuildFailure, parseFailurePayload } from './failure.ts';

export interface WorkerBuildConfig {
  repoRoot: string;
  workspaceRoot: string;
  toolchainDir: string;
  timeoutMs: number;
  memoryMb: number;
  useDocker: boolean;
  containerImage: string;
}

export interface IsolatedBuildInput {
  config: WorkerBuildConfig;
  jobId: string;
  releaseId: string;
  manifest: GameManifest;
  limits: Limits;
  /** Bytes of the immutable source version, already resolved by the caller. */
  sourceFiles: Array<{ path: string; content: Uint8Array }>;
}

export interface IsolatedBuildResult {
  files: BuiltArtifactFile[];
  manifest: ArtifactManifest;
  log: string;
  /** Human readable command line, recorded in the build log for auditing. */
  command: string;
  durationMs: number;
}

const PROJECT_DIR = 'project';
const OUT_DIR = 'out';
const SPEC_FILE = 'build.json';
const RESULT_FILE = 'result.json';
const BOOTSTRAP_FILE = 'build.mjs';
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const DOCKER_REPO_MOUNT = '/opt/moydan';
const KILL_GRACE_MS = 2_000;

/**
 * Variables a sandboxed compile must never see. The child environment is built
 * from an allow list, so this list is a tripwire: if a future change ever
 * starts copying `process.env`, the build fails instead of leaking a secret.
 */
const FORBIDDEN_ENV_PATTERNS = [
  /^DATABASE_URL$/i,
  /^SESSION_SECRET$/i,
  /^WORKER_JOB_SECRET$/i,
  /^AWS_/i,
  /^S3_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^AZURE_/i,
  /^KUBERNETES_/i,
  /^SSH_/i,
  /^NPM_/i,
  /^NODE_AUTH_TOKEN$/i,
  /^CLOUD_/i,
  /TOKEN$/i,
  /SECRET$/i,
  /CREDENTIALS?$/i,
];

/**
 * Run one build in an isolated child process and return its artifact.
 *
 * Throws `BuildFailure` for every failure mode (compile error, missing engine,
 * timeout, out of memory) so the caller has one shape to report.
 */
export async function runIsolatedBuild(input: IsolatedBuildInput): Promise<IsolatedBuildResult> {
  const workspace = createWorkspace(input.config.workspaceRoot, input.jobId);
  const started = Date.now();
  try {
    if (input.config.useDocker) openWorkspace(workspace);
    materialiseProject(join(workspace, PROJECT_DIR), input.sourceFiles);
    const hostSpec = sandboxSpec(input, workspace);
    const useDocker = input.config.useDocker;
    writeFileSync(
      join(workspace, SPEC_FILE),
      JSON.stringify(useDocker ? containerSpec(hostSpec, input.config, workspace) : hostSpec),
    );
    writeFileSync(join(workspace, BOOTSTRAP_FILE), bootstrapSource(input.config, useDocker));

    const command = useDocker
      ? dockerCommand(input.config, workspace)
      : [process.execPath, `--max-old-space-size=${Math.max(128, input.config.memoryMb)}`, childEntryPath(input.config), workspace];
    const env = sandboxEnv(workspace, useDocker);

    await exec(command, {
      cwd: workspace,
      env,
      timeoutMs: input.config.timeoutMs,
    });

    const result = readResult(workspace);
    if (!result) {
      throw new BuildFailure('build_failed', 'The isolated build produced no result. The compiler crashed before reporting anything.', {
        diagnostics: [{ code: 'no_result', message: 'the sandbox wrote no result file' }],
      });
    }
    if (result.ok !== true || !result.manifest || !Array.isArray(result.files)) {
      throw failureFromResult(result);
    }
    const files = readArtifact(workspace, result);
    // Re-assert the platform budgets in the parent as well: the child already
    // enforced them, and an artifact that violates a budget must never be
    // uploaded even if the child were somehow replaced.
    enforceArtifactLimits(result.manifest, input.limits);
    return {
      files,
      manifest: result.manifest,
      log: result.log ?? '',
      command: command.join(' '),
      durationMs: Date.now() - started,
    };
  } finally {
    removeWorkspace(workspace);
  }
}

// --- Workspace ---------------------------------------------------------------

export function createWorkspace(workspaceRoot: string, jobId: string): string {
  mkdirSync(workspaceRoot, { recursive: true });
  // mkdtemp never reuses a directory and fails loudly if one already exists.
  return mkdtempSync(join(workspaceRoot, `job-${sanitiseForFilename(jobId)}-`));
}

/**
 * Let the container's user reach the workspace. The build host creates it with
 * `mkdtemp` (0700); the container may run as a different uid, so the *directory*
 * is opened up for traversal and access while every file inside is still owned
 * by the build host user and deleted afterwards.
 */
export function openWorkspace(workspace: string): void {
  chmodSync(workspace, 0o755);
}

export function removeWorkspace(workspace: string): void {
  // `BUILD_KEEP_WORKSPACE=1` leaves the last workspace on disk so an operator can
  // inspect a failed compile; it is off by default because the tree contains
  // creator source.
  if (process.env['BUILD_KEEP_WORKSPACE'] === '1') return;
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
}

function sanitiseForFilename(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return clean.length > 0 ? clean : randomBytes(6).toString('hex');
}

function sandboxSpec(input: IsolatedBuildInput, workspace: string): SandboxSpec {
  return {
    jobId: input.jobId,
    releaseId: input.releaseId,
    title: input.manifest.title,
    entry: input.manifest.entry,
    engine: input.manifest.engine,
    orientation: input.manifest.orientation,
    viewport: input.manifest.viewport,
    limits: input.limits,
    repoRoot: input.config.repoRoot,
    toolchainDir: input.config.toolchainDir,
    projectDir: join(workspace, PROJECT_DIR),
    outDir: join(workspace, OUT_DIR),
    resultFile: RESULT_FILE,
  };
}
/**
 * Rewrite absolute host paths to their in-container equivalents: the workspace
 * is mounted at `/w` and the repository is mounted read-only at a fixed point,
 * so the compiler can read the pinned SDK and vendored engine without a single
 * network round trip.
 */
function containerSpec(spec: SandboxSpec, config: WorkerBuildConfig, workspace: string): SandboxSpec {
  const mapRepository = (value: string): string => {
    if (value === config.repoRoot) return DOCKER_REPO_MOUNT;
    if (!value.startsWith(`${config.repoRoot}/`)) return value;
    return `${DOCKER_REPO_MOUNT}/${value.slice(config.repoRoot.length + 1)}`;
  };
  const mapWorkspace = (value: string): string => {
    const relative = value.startsWith(`${workspace}/`) ? value.slice(workspace.length + 1) : null;
    return relative === null ? value : `/w/${relative}`;
  };
  return {
    ...spec,
    repoRoot: mapRepository(spec.repoRoot),
    toolchainDir: mapRepository(spec.toolchainDir),
    projectDir: mapWorkspace(spec.projectDir),
    outDir: mapWorkspace(spec.outDir),
  };
}

/** Path of the compile entry point on the build host. */
export function childEntryPath(config: WorkerBuildConfig): string {
  const entry = join(import.meta.dirname, 'build-child.ts');
  if (config.useDocker && !entry.startsWith(`${config.repoRoot}/`)) {
    throw new BuildFailure(
      'build_failed',
      'Container builds require the worker to run from inside the repository (the read-only repo mount is what provides the pinned toolchain).',
      { diagnostics: [{ code: 'worker_outside_repo', message: `worker entry ${entry} is not under ${config.repoRoot}` }] },
    );
  }
  return entry;
}

// --- Child process -----------------------------------------------------------

/**
 * The `build.mjs` bootstrap.
 *
 * Plain ESM (no types) so it runs on any supported Node, inside or outside a
 * container. It only forwards to the worker's compile entry point; the workspace
 * stays the cwd so every relative path in the spec keeps working.
 */
function bootstrapSource(config: WorkerBuildConfig, useDocker: boolean): string {
  const target = useDocker
    ? containerPath(childEntryPath(config), config)
    : childEntryPath(config);
  return `// Generated by @moydan/worker. Forwards to the isolated compile entry point.\nawait import(${JSON.stringify(target)});\n`;
}

function containerPath(path: string, config: WorkerBuildConfig): string {
  if (!path.startsWith(`${config.repoRoot}/`)) {
    throw new BuildFailure('build_failed', `Cannot expose ${path} inside the build container (it is outside the repository).`);
  }
  return `${DOCKER_REPO_MOUNT}/${path.slice(config.repoRoot.length + 1)}`;
}

function dockerCommand(config: WorkerBuildConfig, workspace: string): string[] {
  const command = [
    'docker',
    'run',
    '--rm',
    '--network=none',
    `--memory=${Math.max(128, config.memoryMb)}m`,
    '--cpus=1',
    '--pids-limit=256',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '-v',
    `${workspace}:/w`,
    '-v',
    `${config.repoRoot}:${DOCKER_REPO_MOUNT}:ro`,
    '-w',
    '/w',
  ];
  // Run as the build host's user so the container can read and write the
  // workspace without the workspace having to be world-writable on the host.
  const user = dockerUser();
  if (user !== null) command.push('--user', user);
  command.push(config.containerImage, 'node', `/w/${BOOTSTRAP_FILE}`);
  return command;
}

function dockerUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return typeof uid === 'number' && typeof gid === 'number' ? `${uid}:${gid}` : null;
}

/**
 * Environment handed to the compile child. Built from an allow list on purpose:
 * inheriting `process.env` would give creator-controlled code the operator's
 * database URL, session secret, worker secret and cloud credentials.
 */
export function sandboxEnv(workspace: string, useDocker: boolean): Record<string, string> {
  mkdirSync(join(workspace, 'tmp'), { recursive: true });
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: useDocker ? '/tmp' : workspace,
    TMPDIR: useDocker ? '/tmp' : join(workspace, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NODE_ENV: 'production',
    NODE_NO_WARNINGS: '1',
    MOYDAN_SANDBOX: '1',
  };
  if (useDocker) {
    // Container images track older Node releases; type stripping must be on for
    // the TypeScript compiler entry point to load.
    env['NODE_OPTIONS'] = '--experimental-strip-types';
  }
  assertNoSecrets(env);
  return env;
}

export function assertNoSecrets(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    throw new BuildFailure('build_failed', `Refusing to run a build with "${key}" in the sandbox environment.`);
  }
  if (Object.values(env).some((value) => value.includes('://') && value.includes('@'))) {
    throw new BuildFailure('build_failed', 'Refusing to run a build with credentials in the sandbox environment.');
  }
}

interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Spawn the compiler, capture a bounded amount of output, and enforce the wall clock. */
async function exec(command: string[], options: ExecOptions): Promise<void> {
  const [bin, ...args] = command;
  if (!bin) throw new BuildFailure('build_failed', 'The build command was empty.');
  const child: ChildProcess = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A separate process group so the timeout can kill the compiler *and* the
    // esbuild service process it spawns.
    detached: process.platform !== 'win32',
  });

  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  // A holder rather than a plain `let`: the value is only ever set from an
  // event callback, which control-flow analysis cannot see through.
  const spawnError: { current: Error | null } = { current: null };

  const outcome = await new Promise<'done' | 'timeout'>((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome('timeout'), Math.max(1_000, options.timeoutMs));
    child.once('error', (error: Error) => {
      spawnError.current = error;
      clearTimeout(timer);
      resolveOutcome('done');
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolveOutcome('done');
    });
  });

  if (outcome === 'timeout') {
    killTree(child);
    throw new BuildFailure(
      'build_timeout',
      `The build exceeded the ${Math.round(options.timeoutMs / 1000)}s time limit and was stopped.`,
      {
        retryable: true,
        diagnostics: [
          { code: 'timeout', message: `limit ${options.timeoutMs}ms` },
          { code: 'stdout', message: stdout().trim().slice(0, 2000) },
          { code: 'stderr', message: stderr().trim().slice(0, 2000) },
        ].filter((entry) => entry.message.length > 0),
      },
    );
  }

  if (spawnError.current !== null) {
    throw new BuildFailure('build_failed', `The build sandbox could not start: ${spawnError.current.message}`, {
      diagnostics: [
        {
          code: 'sandbox_unavailable',
          message: `tried to run "${command[0]}"; check the build isolation configuration on this host`,
        },
      ],
    });
  }

  if (child.signalCode === 'SIGKILL' || (child.exitCode !== 0 && child.signalCode !== null)) {
    throw new BuildFailure('build_failed', 'The compiler was killed (out of memory or an external stop signal).', {
      diagnostics: [
        { code: 'killed', message: `signal ${String(child.signalCode)} exit ${String(child.exitCode)}` },
        { code: 'stderr', message: stderr().trim().slice(0, 2000) },
      ].filter((entry) => entry.message.length > 0),
    });
  }
}

/** Keep only the first {@link MAX_CAPTURED_OUTPUT_BYTES} of a child stream. */
function capture(stream: NodeJS.ReadableStream | null): () => string {
  let text = '';
  stream?.on('data', (chunk: Buffer | string) => {
    if (text.length >= MAX_CAPTURED_OUTPUT_BYTES) return;
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  return () => text.slice(0, MAX_CAPTURED_OUTPUT_BYTES);
}

function killTree(child: ChildProcess): void {
  if (typeof child.pid !== 'number') {
    child.kill('SIGKILL');
    return;
  }
  try {
    // Negative pid targets the whole process group, which also stops the esbuild
    // service process the compiler spawns.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS).unref();
}

// --- Result ------------------------------------------------------------------

function readResult(workspace: string): SandboxResultFile | null {
  const file = join(workspace, RESULT_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SandboxResultFile;
  } catch {
    return null;
  }
}

/** The child reported a structured failure; surface it verbatim. */
function failureFromResult(result: SandboxResultFile): BuildFailure {
  const payload = parseFailurePayload(result.failure);
  if (payload) {
    return new BuildFailure(payload.code, payload.message, { diagnostics: payload.diagnostics, retryable: payload.retryable });
  }
  return new BuildFailure('build_failed', 'The build failed inside the sandbox without a diagnostic.');
}

/** Read the artifact back out of the workspace and re-verify every digest. */
function readArtifact(workspace: string, result: SandboxResultFile): BuiltArtifactFile[] {
  const outDir = join(workspace, OUT_DIR);
  const files: BuiltArtifactFile[] = [];
  for (const entry of result.files ?? []) {
    if (result.manifest && !result.manifest.files.some((file) => file.path === entry.path)) continue;
    const target = join(outDir, entry.path);
    const content = new Uint8Array(readFileSync(target));
    const digest = sha256Hex(content);
    if (digest !== entry.sha256) {
      throw new BuildFailure('build_failed', `The sandbox returned a corrupt file for "${entry.path}".`, {
        diagnostics: [{ code: 'integrity', message: `expected ${entry.sha256}, computed ${digest}`, path: entry.path }],
      });
    }
    files.push({ path: entry.path, content, contentType: entry.contentType, entry: entry.entry });
  }
  if (files.length === 0) {
    throw new BuildFailure('build_failed', 'The isolated build produced no artifact files.');
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

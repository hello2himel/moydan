/**
 * Project validation.
 *
 * Why a dedicated module: `moydan validate`, `moydan build`, `moydan test` and
 * `moydan pack` must agree, and they must agree with the platform. They all go
 * through `validateGameManifest` from `@moydan/core` — the same function the
 * API calls on upload — and add only local checks that cannot be done without a
 * project on disk (asset bytes, stray files, manifest size).
 */

import { statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_LIMITS,
  MANIFEST_FILE_NAME,
  formatBytes,
  limitsFromEnv,
  validateGameManifest,
  verifyFileBytes,
  type GameManifest,
  type Limits,
  type ProjectFileRole,
  type ValidationIssue,
} from '@moydan/core';
import { collectProjectFiles, findProjectRoot, sourceBytes, type LoadedProject, type ProjectFile } from './project.ts';

export interface ProjectReport {
  project: LoadedProject;
  manifest: GameManifest | null;
  issues: ValidationIssue[];
  warnings: string[];
  files: ProjectFile[];
  rejected: string[];
  limits: Limits;
}

export interface LoadOptions {
  /** Directory to start from; defaults to the working directory. */
  dir?: string;
  /** Deployment limits; defaults to the documented ones plus env overrides. */
  limits?: Limits;
}

/**
 * Read `game.json`, walk the tree and run the platform validator. Never throws
 * for a broken project: the caller decides how to report it.
 */
export function loadProject(options: LoadOptions = {}): ProjectReport {
  const limits = options.limits ?? limitsFromEnv(process.env, DEFAULT_LIMITS);
  const start = resolve(options.dir ?? process.cwd());
  const root = findProjectRoot(start);
  const warnings: string[] = [];

  if (!root) {
    return {
      project: {
        root: start,
        manifestPath: resolve(start, MANIFEST_FILE_NAME),
        json: null,
        result: { ok: false, issues: [issue('$', 'not_allowed', `no ${MANIFEST_FILE_NAME} found in ${start} or any parent directory`)], manifest: null },
        files: [],
        rejected: [],
        warnings,
        manifest: null,
      },
      manifest: null,
      issues: [issue('$', 'not_allowed', `no ${MANIFEST_FILE_NAME} found in ${start} or any parent directory`)],
      warnings,
      files: [],
      rejected: [],
      limits,
    };
  }

  const manifestPath = resolve(root, MANIFEST_FILE_NAME);
  const collected = collectProjectFiles(root);
  for (const path of collected.rejected) {
    warnings.push(`${path} is not part of the project format and will not be uploaded`);
  }

  let json: unknown = null;
  let raw = '';
  try {
    raw = readFileSync(manifestPath, 'utf8');
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`${MANIFEST_FILE_NAME} could not be read as JSON: ${detail}`);
  }

  if (raw.length > limits.maxManifestBytes) {
    warnings.push(`${MANIFEST_FILE_NAME} is ${formatBytes(raw.length)}; the platform limit is ${formatBytes(limits.maxManifestBytes)}`);
  }

  const filePaths = collected.files.map((file) => file.path);
  const result = validateGameManifest(json, { limits, files: filePaths });

  // Asset payloads are sniffed the same way an upload is: a `.png` that is
  // really a script, or an SVG with active content, never reaches storage.
  const assetIssues: ValidationIssue[] = [];
  for (const file of collected.files) {
    if (file.role !== 'asset') continue;
    const check = verifyFileBytes(file.path, new Uint8Array(readFileSync(resolve(root, file.path))));
    if (!check.ok) {
      assetIssues.push(issue('license.assets', 'not_allowed', `${file.path}: ${check.message ?? 'content does not match its extension'}`));
    }
  }

  const issues = [...result.issues, ...assetIssues];
  if (collected.files.length > limits.maxProjectFiles) {
    issues.push(issue('$', 'too_many', `project has ${collected.files.length} files; the limit is ${limits.maxProjectFiles}`));
  }
  const sources = sourceBytes(collected.files);
  if (sources > limits.maxSourceBytes) {
    issues.push(issue('$', 'too_large', `project source is ${formatBytes(sources)}; the limit is ${formatBytes(limits.maxSourceBytes)}`));
  }

  const project: LoadedProject = {
    root,
    manifestPath,
    json,
    result: issues.length > 0 ? { ok: false, issues, manifest: null } : { ok: true, issues: [], manifest: result.manifest },
    files: collected.files,
    rejected: collected.rejected,
    warnings,
    manifest: issues.length === 0 ? result.manifest : null,
  };

  return { project, manifest: project.manifest, issues, warnings, files: collected.files, rejected: collected.rejected, limits };
}

export function projectSummary(report: ProjectReport): string[] {
  const manifest = report.manifest;
  if (!manifest) return [];
  const roles = new Map<ProjectFileRole, number>();
  for (const file of report.files) roles.set(file.role, (roles.get(file.role) ?? 0) + 1);
  const counts = [...roles.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([role, count]) => `${count} ${role}`);
  return [
    `slug      ${manifest.slug}`,
    `engine    ${manifest.engine.name} ${manifest.engine.version}`,
    `entry     ${manifest.entry}`,
    `viewport  ${manifest.viewport.width}x${manifest.viewport.height} ${manifest.viewport.scale}, ${manifest.orientation}`,
    `licence   ${manifest.license.spdx}`,
    `remix     ${manifest.remix.allowed ? `${manifest.remix.modes.join(' + ')} (${manifest.remix.parameters.length} parameters)` : 'not allowed'}`,
    `files     ${counts.join(', ') || 'none'} (${formatBytes(sourceBytes(report.files))} source, ${formatBytes(
      report.files.reduce((sum, file) => (file.role === 'asset' ? sum + file.bytes : sum), 0),
    )} assets)`,
  ];
}

function issue(path: string, code: ValidationIssue['code'], message: string): ValidationIssue {
  return { path, code, message };
}

/** Directory size on disk, used for the `moydan build` cache note. */
export function directoryBytes(root: string): number {
  let total = 0;
  for (const file of collectProjectFiles(root).files) {
    try {
      total += statSync(resolve(root, file.path)).size;
    } catch {
      // A file that vanished between listing and stat is not worth failing over.
    }
  }
  return total;
}

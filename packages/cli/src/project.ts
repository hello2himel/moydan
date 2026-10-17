/**
 * Project discovery and file collection.
 *
 * Why: the CLI must see a project exactly the way the platform's archive
 * importer sees it, otherwise `moydan validate` would happily approve a project
 * the server rejects. Every path is therefore run through
 * `classifyProjectPath` from `@moydan/core`; files the format does not allow are
 * reported instead of being silently uploaded.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MANIFEST_FILE_NAME,
  classifyProjectPath,
  type GameManifest,
  type ManifestValidationResult,
  type ProjectFileRole,
} from '@moydan/core';

export interface ProjectFile {
  /** Project-relative, forward-slash path. */
  path: string;
  role: ProjectFileRole;
  bytes: number;
}

export interface LoadedProject {
  /** Absolute directory that contains `game.json`. */
  root: string;
  manifestPath: string;
  /** Parsed manifest, or `null` when `game.json` is missing or malformed JSON. */
  json: unknown | null;
  /** Result of the real platform validator, run by the caller. */
  result: ManifestValidationResult;
  files: ProjectFile[];
  /** Files present in the tree that the project format does not allow. */
  rejected: string[];
  /** Non-fatal problems (JSON syntax, oversized manifest, stray files). */
  warnings: string[];
  manifest: GameManifest | null;
}

const IGNORED_DIRECTORIES = new Set(['node_modules', '__MACOSX', 'dist', '.git']);

/** Walk upwards from `start` looking for the directory that owns `game.json`. */
export function findProjectRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsJoin(current, MANIFEST_FILE_NAME)) return current;
    const parent = resolve(current, '..');
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function existsJoin(directory: string, name: string): boolean {
  try {
    return statSync(join(directory, name)).isFile();
  } catch {
    return false;
  }
}

export interface CollectOptions {
  /** Include `tests/` and `test/` directories (project uploads do). */
  allowTests?: boolean;
}

/**
 * Collect every file the project format allows, plus the list of files that are
 * present but not allowed (dotfiles, lockfiles, editor directories...).
 */
export function collectProjectFiles(root: string, options: CollectOptions = {}): {
  files: ProjectFile[];
  rejected: string[];
} {
  const files: ProjectFile[] = [];
  const rejected: string[] = [];
  const allowTests = options.allowTests ?? true;

  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const projectPath = relative(root, full).split(sep).join('/');
      const role = classifyProjectPath(projectPath, { allowTests });
      if (!role) {
        rejected.push(projectPath);
        continue;
      }
      files.push({ path: projectPath, role, bytes: statSync(full).size });
    }
  };

  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  rejected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, rejected };
}

export function readProjectFileBytes(project: LoadedProject, projectPath: string): Uint8Array {
  const absolute = isAbsolute(projectPath) ? projectPath : resolve(project.root, projectPath);
  return new Uint8Array(readFileSync(absolute));
}

/** Sum of the source and document files, the number the quota is measured in. */
export function sourceBytes(files: readonly ProjectFile[]): number {
  return files.reduce((sum, file) => (file.role === 'asset' ? sum : sum + file.bytes), 0);
}

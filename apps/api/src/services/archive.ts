/**
 * Project archive import/export.
 *
 * Imports are hostile input by default. Before a single byte is decompressed we
 * inspect the central directory and reject:
 *   - entries whose *declared* expanded size already breaks a limit (zip bomb);
 *   - archives whose expansion ratio exceeds the configured maximum;
 *   - absolute paths, `..` traversal, backslashes, drive letters, symlinks and
 *     other non-regular entries;
 *   - duplicate normalised paths and case-colliding paths;
 *   - paths that the project path policy does not allow (`.git`, `node_modules`,
 *     dotfiles, disallowed extensions...).
 *
 * Decompression is capped per entry, so a lying central directory still cannot
 * exhaust memory.
 */

import { unzipSync, zipSync, type Unzipped } from 'fflate';
import {
  checkPathSafety,
  classifyProjectPath,
  errors,
  formatBytes,
  MAX_PROJECT_PATH_LENGTH,
  type Limits,
  type ProjectFileRole,
} from '@moydan/core';

export interface ArchiveEntry {
  path: string;
  content: Uint8Array;
  role: ProjectFileRole;
}

export interface ArchivePreview {
  entries: ArchiveEntry[];
  totalExpandedBytes: number;
  ratio: number;
  warnings: string[];
}

export interface ArchiveLimits {
  limits: Limits;
  /** Allow `tests/` and other non-runtime files (used by project import). */
  allowTests?: boolean;
}

export function readProjectArchive(input: Uint8Array, options: ArchiveLimits): ArchivePreview {
  const limits = options.limits;
  if (input.byteLength === 0) throw errors.validationFailed('The uploaded archive is empty.');
  if (input.byteLength > limits.maxArchiveBytes) {
    throw errors.payloadTooLarge(
      `Archive is ${formatBytes(input.byteLength)}; the limit is ${formatBytes(limits.maxArchiveBytes)}.`,
      { limitBytes: limits.maxArchiveBytes, actualBytes: input.byteLength },
    );
  }

  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const lowered = new Map<string, string>();
  let declaredTotal = 0;
  let declaredEntries = 0;

  const unzipped: Unzipped = unzipSync(input, {
    filter: (file) => {
      declaredEntries += 1;
      if (declaredEntries > limits.maxArchiveEntries) return false;
      const name = file.name;
      if (name.endsWith('/')) return false; // directory marker
      if (file.originalSize > limits.maxFileBytes) {
        warnings.push(`${name}: declared size ${formatBytes(file.originalSize)} exceeds the per-file limit`);
        return false;
      }
      declaredTotal += file.originalSize;
      if (declaredTotal > limits.maxArchiveExpandedBytes) {
        warnings.push('archive declares more expanded bytes than the limit allows');
        return false;
      }
      const problem = checkPathSafety(name);
      if (problem) {
        warnings.push(`${name}: ${problem.message}`);
        return false;
      }
      return true;
    },
  });

  const entries: ArchiveEntry[] = [];
  let totalExpandedBytes = 0;

  for (const [rawPath, content] of Object.entries(unzipped)) {
    const path = rawPath.replace(/\\/g, '/');
    const problem = checkPathSafety(path);
    if (problem) {
      warnings.push(`${path}: ${problem.message}`);
      continue;
    }
    if (path.length > MAX_PROJECT_PATH_LENGTH) {
      warnings.push(`${path}: path is too long`);
      continue;
    }
    if (seenPaths.has(path)) {
      warnings.push(`${path}: duplicate entry`);
      continue;
    }
    const loweredPath = path.toLowerCase();
    const collision = lowered.get(loweredPath);
    if (collision && collision !== path) {
      throw errors.validationFailed(
        `Archive contains paths that collide on case-insensitive filesystems: "${collision}" and "${path}".`,
      );
    }
    lowered.set(loweredPath, path);

    const role = classifyProjectPath(path, { allowTests: options.allowTests ?? true });
    if (!role) {
      warnings.push(`${path}: not an allowed project file`);
      continue;
    }
    // fflate returns Uint8Array for stored/deflated entries; anything else would
    // indicate a malformed archive (e.g. a symlink or a nested zip member).
    if (!(content instanceof Uint8Array)) {
      warnings.push(`${path}: unsupported entry type`);
      continue;
    }
    if (content.byteLength > limits.maxFileBytes) {
      throw errors.payloadTooLarge(`"${path}" expands to ${formatBytes(content.byteLength)}, above the per-file limit.`, {
        limitBytes: limits.maxFileBytes,
        actualBytes: content.byteLength,
        path,
      });
    }
    // Null bytes in text-ish files are a smuggling signal.
    totalExpandedBytes += content.byteLength;
    if (totalExpandedBytes > limits.maxArchiveExpandedBytes) {
      throw errors.payloadTooLarge(
        `Archive expands to more than ${formatBytes(limits.maxArchiveExpandedBytes)}; aborting import.`,
        { limitBytes: limits.maxArchiveExpandedBytes },
      );
    }
    seenPaths.add(path);
    entries.push({ path, content, role });
  }

  if (entries.length === 0) {
    throw errors.validationFailed('No usable project files were found in the archive.', { warnings });
  }
  if (entries.length > limits.maxProjectFiles) {
    throw errors.payloadTooLarge(
      `Project contains ${entries.length} files; the limit is ${limits.maxProjectFiles}.`,
      { limitCount: limits.maxProjectFiles, actualCount: entries.length },
    );
  }
  const sourceBytes = entries.reduce(
    (sum, entry) => sum + (entry.role === 'asset' ? 0 : entry.content.byteLength),
    0,
  );
  if (sourceBytes > limits.maxSourceBytes) {
    throw errors.payloadTooLarge(
      `Project source is ${formatBytes(sourceBytes)}; the limit is ${formatBytes(limits.maxSourceBytes)}.`,
      { limitBytes: limits.maxSourceBytes, actualBytes: sourceBytes },
    );
  }

  const ratio = input.byteLength > 0 ? totalExpandedBytes / input.byteLength : 1;
  if (ratio > limits.maxArchiveRatio) {
    throw errors.payloadTooLarge(
      `Archive expands ${ratio.toFixed(0)}x (limit ${limits.maxArchiveRatio}x); refusing to import.`,
      { ratio, limitRatio: limits.maxArchiveRatio },
    );
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, totalExpandedBytes, ratio, warnings };
}

/** Build a deterministic source archive for export/download. */
export function buildProjectArchive(files: { path: string; content: Uint8Array }[]): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const file of files) {
    const problem = checkPathSafety(file.path);
    if (problem) throw errors.internal(`Refusing to export unsafe path "${file.path}"`);
    input[file.path] = file.content;
  }
  // Deterministic timestamps keep archives byte-identical for identical trees,
  // which makes integrity comparisons meaningful. The zip date format starts at
  // 1980, so the epoch (1970) is not representable and would throw.
  return zipSync(input, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
}

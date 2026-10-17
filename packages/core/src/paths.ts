/**
 * Path and content-type policy for uploaded projects and generated artifacts.
 *
 * Project uploads are untrusted input. This module is the single place that
 * decides whether a path is acceptable, so the archive importer, single file
 * upload, remix copier, and build output validator all agree.
 */

export interface PathProblem {
  code:
    | 'empty'
    | 'too_long'
    | 'absolute'
    | 'traversal'
    | 'windows_separator'
    | 'control_characters'
    | 'dot_segment'
    | 'reserved'
    | 'directory';
  message: string;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.txt',
  '.md',
  '.svg',
]);

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.svg',
  '.ico',
  '.mp3',
  '.ogg',
  '.wav',
  '.m4a',
  '.webm',
  '.mp4',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.json',
  '.txt',
  '.csv',
  '.tmx',
  '.atlas',
  '.xml',
]);

const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.json']);

const FORBIDDEN_SEGMENTS = new Set(['.git', '.svn', '.hg', '.github', 'node_modules', '__MACOSX']);

const FORBIDDEN_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.gitmodules',
  '.htaccess',
  'id_rsa',
  'id_ed25519',
]);

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const MAX_PROJECT_PATH_LENGTH = 160;

/** Reasons a path is never acceptable, whatever its role. */
export function checkPathSafety(input: string): PathProblem | null {
  if (typeof input !== 'string' || input.length === 0) {
    return { code: 'empty', message: 'path must not be empty' };
  }
  if (input.length > MAX_PROJECT_PATH_LENGTH) {
    return { code: 'too_long', message: `path must be at most ${MAX_PROJECT_PATH_LENGTH} characters` };
  }
  if (input.includes('\\')) {
    return { code: 'windows_separator', message: 'path must use forward slashes' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { code: 'control_characters', message: 'path must not contain control characters' };
  }
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) {
    return { code: 'absolute', message: 'path must be relative' };
  }
  if (input.endsWith('/')) {
    return { code: 'directory', message: 'path must reference a file, not a directory' };
  }
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { code: 'dot_segment', message: 'path must not contain empty, "." or ".." segments' };
    }
    if (segment.trim() !== segment) {
      return { code: 'reserved', message: 'path segments must not start or end with whitespace' };
    }
  }
  const basename = segments[segments.length - 1] ?? '';
  if (WINDOWS_RESERVED.test(basename)) {
    return { code: 'reserved', message: 'path uses a name reserved by Windows' };
  }
  return null;
}

export function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const index = basename.lastIndexOf('.');
  if (index <= 0) return '';
  return basename.slice(index).toLowerCase();
}

export type ProjectFileRole = 'source' | 'asset' | 'document' | 'manifest' | 'license';

export interface ProjectPathRules {
  /** Extra files the project format always allows (LICENSE, README, ...). */
  allowTests?: boolean;
}

/**
 * Decide whether a path is acceptable inside a project and what role it plays.
 * Returns `null` when the path must be rejected.
 */
export function classifyProjectPath(path: string, rules: ProjectPathRules = {}): ProjectFileRole | null {
  if (checkPathSafety(path)) return null;
  const segments = path.split('/');
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return null;
  }
  const basename = segments[segments.length - 1] ?? '';
  if (FORBIDDEN_FILE_NAMES.has(basename.toLowerCase())) return null;
  if (basename.startsWith('.') && basename !== '.well-known') return null;

  const extension = extensionOf(path);

  if (path === 'game.json') return 'manifest';
  // `LICENSE`, `LICENSE-MIT`, `LICENSE.md`: the hyphenated spelling is used by
  // real projects and is supported by the licence policy and media sniffing.
  if (/^licen[cs]e([.-]|$)/i.test(basename)) return 'license';
  if (segments[0] === 'src') {
    return SOURCE_EXTENSIONS.has(extension) ? 'source' : null;
  }
  if (segments[0] === 'assets' || segments[0] === 'public') {
    return ASSET_EXTENSIONS.has(extension) ? 'asset' : null;
  }
  if (segments[0] === 'tests' || segments[0] === 'test') {
    if (!rules.allowTests) return null;
    return SOURCE_EXTENSIONS.has(extension) ? 'document' : null;
  }
  if (segments.length === 1) {
    // Checked before the generic document rule, otherwise `.md` answers first
    // and the asset notice a remix has to carry is not counted as a notice.
    if (basename.toUpperCase() === 'ASSET_LICENSES.MD') return 'license';
    if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  }
  return null;
}

/** Paths that must never appear in a build artifact. */
export function checkArtifactPath(input: string): PathProblem | null {
  const problem = checkPathSafety(input);
  if (problem) return problem;
  for (const segment of input.split('/')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return { code: 'reserved', message: `"${segment}" is not allowed in build output` };
    }
  }
  const extension = extensionOf(input);
  if (extension === '.map') {
    return { code: 'reserved', message: 'source maps are stripped from published artifacts' };
  }
  if (extension === '.ts' || extension === '.tsx' || extension === '.mjs' || extension === '.cjs') {
    return { code: 'reserved', message: 'artifacts must contain browser-ready files only' };
  }
  return null;
}

/**
 * Resolve `relative` inside `root` and assert the result cannot escape it.
 * Used by the fs storage driver and the build workspace manager.
 */
export function resolveWithinRoot(root: string, relative: string): string {
  if (checkPathSafety(relative)) {
    // Storage keys are generated by the platform, so this is a programming
    // error rather than user input: fail loudly instead of silently coercing.
    throw new Error(`unsafe relative path: ${JSON.stringify(relative)}`);
  }
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${base}/${relative}`;
}

/** Deterministic ordering used everywhere file trees are compared. */
export function compareProjectPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortProjectPaths(paths: string[]): string[] {
  return [...paths].sort(compareProjectPaths);
}

export function projectFileRoles(): { source: string[]; asset: string[]; document: string[] } {
  return {
    source: [...SOURCE_EXTENSIONS].sort(),
    asset: [...ASSET_EXTENSIONS].sort(),
    document: [...DOCUMENT_EXTENSIONS].sort(),
  };
}

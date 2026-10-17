/**
 * Path policy: the single decision point for "may this path exist in a project
 * or in a published artifact". Every importer, uploader and build step funnels
 * through these functions, so the rules are asserted here exhaustively.
 */

import { describe, expect, it } from 'vitest';
import {
  checkArtifactPath,
  checkPathSafety,
  classifyProjectPath,
  compareProjectPaths,
  extensionOf,
  MAX_PROJECT_PATH_LENGTH,
  resolveWithinRoot,
  sortProjectPaths,
} from '@moydan/core';

describe('checkPathSafety', () => {
  it('accepts an ordinary relative project path', () => {
    expect(checkPathSafety('src/main.ts')).toBeNull();
    expect(checkPathSafety('assets/ui/mark.svg')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(checkPathSafety('')?.code).toBe('empty');
  });

  it('rejects traversal in any position', () => {
    expect(checkPathSafety('../secrets.txt')?.code).toBe('dot_segment');
    expect(checkPathSafety('src/../../secrets.txt')?.code).toBe('dot_segment');
    expect(checkPathSafety('src/./main.ts')?.code).toBe('dot_segment');
    expect(checkPathSafety('src//main.ts')?.code).toBe('dot_segment');
  });

  it('rejects absolute paths, including Windows drive letters', () => {
    expect(checkPathSafety('/etc/passwd')?.code).toBe('absolute');
    expect(checkPathSafety('C:/Windows/system.ini')?.code).toBe('absolute');
  });

  it('rejects backslash separators', () => {
    expect(checkPathSafety('src\\main.ts')?.code).toBe('windows_separator');
  });

  it('rejects control characters, including an embedded NUL', () => {
    expect(checkPathSafety('src/main\u0000.ts')?.code).toBe('control_characters');
    expect(checkPathSafety('src/ma\nin.ts')?.code).toBe('control_characters');
    expect(checkPathSafety('src/main\u007f.ts')?.code).toBe('control_characters');
  });

  it('rejects a directory reference', () => {
    expect(checkPathSafety('src/')?.code).toBe('directory');
  });

  it('rejects a path longer than the platform limit', () => {
    const long = `src/${'a'.repeat(MAX_PROJECT_PATH_LENGTH)}.ts`;
    expect(long.length).toBeGreaterThan(MAX_PROJECT_PATH_LENGTH);
    expect(checkPathSafety(long)?.code).toBe('too_long');
  });

  it('rejects Windows-reserved device names', () => {
    expect(checkPathSafety('src/con.ts')?.code).toBe('reserved');
    expect(checkPathSafety('src/nul')?.code).toBe('reserved');
    expect(checkPathSafety('src/COM1.md')?.code).toBe('reserved');
    expect(checkPathSafety('assets/prn.png')?.code).toBe('reserved');
  });

  it('rejects a segment padded with whitespace', () => {
    expect(checkPathSafety('src/ main.ts')?.code).toBe('reserved');
    expect(checkPathSafety('src/main.ts ')?.code).toBe('reserved');
  });
});

describe('classifyProjectPath', () => {
  it('classifies source files under src/', () => {
    expect(classifyProjectPath('src/main.ts')).toBe('source');
    expect(classifyProjectPath('src/lib/game.ts')).toBe('source');
  });

  it('classifies assets under assets/ and public/', () => {
    expect(classifyProjectPath('assets/ui/mark.svg')).toBe('asset');
    expect(classifyProjectPath('public/cover.png')).toBe('asset');
  });

  it('rejects a disallowed extension inside src/ and assets/', () => {
    expect(classifyProjectPath('src/main.exe')).toBeNull();
    expect(classifyProjectPath('assets/data.bin')).toBeNull();
  });

  it('gates tests/ behind allowTests', () => {
    expect(classifyProjectPath('tests/main.ts')).toBeNull();
    expect(classifyProjectPath('tests/main.ts', { allowTests: true })).toBe('document');
    expect(classifyProjectPath('tests/main.exe', { allowTests: true })).toBeNull();
  });

  it('recognises the manifest and licence files by name', () => {
    expect(classifyProjectPath('game.json')).toBe('manifest');
    expect(classifyProjectPath('LICENSE')).toBe('license');
    expect(classifyProjectPath('LICENSE.md')).toBe('license');
    // `ASSET_LICENSES.md` is the notice file a source remix must carry, so it is
    // classified as a licence notice rather than as a plain document.
    expect(classifyProjectPath('ASSET_LICENSES.md')).toBe('license');
  });

  it('classifies hyphenated and suffixed licence notices', () => {
    // Real projects spell these `LICENSE-MIT`; the media sniffer and the licence
    // policy both accept that spelling, so path classification must too.
    expect(classifyProjectPath('LICENSE-MIT')).toBe('license');
    expect(classifyProjectPath('LICENSE.md')).toBe('license');
    expect(classifyProjectPath('LICENCE')).toBe('license');
    expect(classifyProjectPath('src/../LICENSE-MIT')).toBeNull();
  });

  it('classifies root-level documents', () => {
    expect(classifyProjectPath('README.md')).toBe('document');
    expect(classifyProjectPath('package.json')).toBe('document');
  });

  it('rejects dotfiles and vendored dependency trees', () => {
    expect(classifyProjectPath('.env')).toBeNull();
    expect(classifyProjectPath('src/.hidden.ts')).toBeNull();
    expect(classifyProjectPath('.npmrc')).toBeNull();
    expect(classifyProjectPath('node_modules/left-pad/index.js')).toBeNull();
    expect(classifyProjectPath('src/.git/config')).toBeNull();
    expect(classifyProjectPath('__MACOSX/._game.json')).toBeNull();
  });

  it('rejects credential-shaped file names in any directory', () => {
    expect(classifyProjectPath('src/id_rsa')).toBeNull();
    expect(classifyProjectPath('src/.env.local')).toBeNull();
  });

  it('propagates every path-safety rejection', () => {
    expect(classifyProjectPath('../escape.ts')).toBeNull();
    expect(classifyProjectPath('/absolute.ts')).toBeNull();
  });
});

describe('checkArtifactPath', () => {
  it('accepts browser-ready output', () => {
    expect(checkArtifactPath('index.html')).toBeNull();
    expect(checkArtifactPath('game.js')).toBeNull();
    expect(checkArtifactPath('game.css')).toBeNull();
    expect(checkArtifactPath('assets/ui/mark.svg')).toBeNull();
  });

  it('refuses source maps, which would leak the original TypeScript', () => {
    expect(checkArtifactPath('game.js.map')?.message).toContain('source maps');
  });

  it('refuses uncompiled TypeScript and ESM/CJS sources', () => {
    expect(checkArtifactPath('game.ts')?.message).toContain('browser-ready');
    expect(checkArtifactPath('game.tsx')?.message).toContain('browser-ready');
    expect(checkArtifactPath('game.mjs')?.message).toContain('browser-ready');
    expect(checkArtifactPath('game.cjs')?.message).toContain('browser-ready');
  });

  it('refuses vendored dependency trees in build output', () => {
    expect(checkArtifactPath('node_modules/left-pad/index.js')?.message).toContain('not allowed in build output');
  });

  it('refuses every unsafe path shape', () => {
    expect(checkArtifactPath('../index.html')?.code).toBe('dot_segment');
    expect(checkArtifactPath('/index.html')?.code).toBe('absolute');
  });
});

describe('path helpers', () => {
  it('reports the extension in lower case, ignoring dotfiles', () => {
    expect(extensionOf('src/Main.TS')).toBe('.ts');
    expect(extensionOf('assets/ui/mark')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });

  it('resolves inside the root and refuses to escape it', () => {
    expect(resolveWithinRoot('/srv/blobs/', 'a/b.bin')).toBe('/srv/blobs/a/b.bin');
    expect(() => resolveWithinRoot('/srv/blobs', '../escape')).toThrow(/unsafe relative path/);
  });

  it('sorts project paths deterministically', () => {
    const sorted = sortProjectPaths(['src/b.ts', 'LICENSE', 'assets/a.png', 'src/a.ts']);
    expect(sorted).toEqual(['LICENSE', 'assets/a.png', 'src/a.ts', 'src/b.ts']);
    expect(compareProjectPaths('a', 'a')).toBe(0);
    expect(compareProjectPaths('a', 'b')).toBe(-1);
    expect(compareProjectPaths('b', 'a')).toBe(1);
  });
});
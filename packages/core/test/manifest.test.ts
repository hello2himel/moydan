/**
 * Manifest validation: the schema boundary every project crosses before a build
 * is allowed to start, plus the cross-checks that only make sense once the
 * manifest is compared with the project's real file tree.
 */

import { describe, expect, it } from 'vitest';
import {
  applyRemixParameters,
  assetPatternMatches,
  DEFAULT_LIMITS,
  ENGINE_SPECS,
  MANIFEST_FILE_NAME,
  REQUIRED_PROJECT_FILES,
  RUNTIME_API_VERSION,
  SUPPORTED_RUNTIME_API_VERSIONS,
  validateGameManifest,
  type GameManifest,
  type ValidationIssue,
} from '@moydan/core';

const FILES = ['game.json', 'LICENSE', 'src/main.ts', 'assets/ui/mark.svg'];

function baseManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    slug: 'bounce-dodge',
    title: 'Bounce Dodge',
    description: 'Drag to move your bar and dodge the bouncing blocks.',
    engine: { name: 'canvas2d', version: ENGINE_SPECS.canvas2d.versions[0] },
    runtime: { apiVersion: '1' },
    entry: 'src/main.ts',
    orientation: 'portrait',
    viewport: { width: 720, height: 1280, scale: 'fit' },
    input: ['pointer', 'touch'],
    capabilities: ['score', 'storage'],
    license: {
      spdx: 'MIT',
      file: 'LICENSE',
      assets: [
        {
          path: 'assets/ui/mark.svg',
          license: 'MIT',
          source: 'original artwork',
          attribution: 'The shield mark, drawn for the Moydan examples.',
        },
      ],
    },
    remix: {
      allowed: true,
      modes: ['parameters'],
      parameters: [{ key: 'speed', label: 'Block speed', type: 'number', min: 0.6, max: 2.5, default: 1 }],
    },
  };
}

function validate(input: unknown, files: string[] = FILES, limits = DEFAULT_LIMITS) {
  return validateGameManifest(input, { limits, files });
}

function issuePaths(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

function issueCode(issues: ValidationIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.code;
}

describe('manifest schema', () => {
  it('accepts a complete, coherent manifest', () => {
    const result = validate(baseManifest());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifest?.slug).toBe('bounce-dodge');
  });

  it('rejects an unknown key anywhere in the document', () => {
    const manifest = { ...baseManifest(), surprise: true };
    const result = validate(manifest);
    expect(result.ok).toBe(false);
    expect(issuePaths(result.issues)).toContain('surprise');
    expect(issueCode(result.issues, 'surprise')).toBe('unknown_key');
  });

  it('rejects a value outside an enum', () => {
    const manifest = baseManifest();
    manifest['engine'] = { name: 'unity', version: '1.0.0' };
    const result = validate(manifest);
    expect(result.ok).toBe(false);
    expect(issueCode(result.issues, 'engine.name')).toBe('not_allowed');
  });

  it('rejects a number outside its declared range', () => {
    const manifest = baseManifest();
    manifest['viewport'] = { width: 10, height: 1280, scale: 'fit' };
    const result = validate(manifest);
    expect(result.ok).toBe(false);
    expect(issueCode(result.issues, 'viewport.width')).toBe('out_of_range');
  });

  it('rejects a non-integer viewport size', () => {
    const manifest = baseManifest();
    manifest['viewport'] = { width: 720.5, height: 1280, scale: 'fit' };
    const result = validate(manifest);
    expect(issueCode(result.issues, 'viewport.width')).toBe('bad_format');
  });

  it('lists the files every project must ship', () => {
    expect(REQUIRED_PROJECT_FILES).toEqual(['game.json', 'LICENSE']);
    expect(MANIFEST_FILE_NAME).toBe('game.json');
  });
});

describe('entry point', () => {
  it('must exist in the project file tree', () => {
    const result = validate(baseManifest(), FILES.filter((file) => file !== 'src/main.ts'));
    expect(result.ok).toBe(false);
    expect(issuePaths(result.issues)).toContain('entry');
    expect(result.issues.find((issue) => issue.path === 'entry')?.message).toContain('not part of the project');
  });

  it('must be a source file inside src/', () => {
    const manifest = baseManifest();
    manifest['entry'] = 'assets/ui/mark.svg';
    const result = validate(manifest);
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.path === 'entry')?.message).toContain('inside src/');
  });

  it('rejects a traversing entry path before it reaches the file tree', () => {
    const manifest = baseManifest();
    manifest['entry'] = '../outside/main.ts';
    const result = validate(manifest);
    expect(issueCode(result.issues, 'entry')).toBe('bad_format');
  });

  it('skips the existence check when no file list is supplied', () => {
    expect(validateGameManifest(baseManifest(), { limits: DEFAULT_LIMITS, files: [] }).ok).toBe(true);
  });
});

describe('engine and runtime pinning', () => {
  it('only accepts the exact pinned engine versions', () => {
    const manifest = baseManifest();
    manifest['engine'] = { name: 'canvas2d', version: '9.9.9' };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'engine.version')?.message).toContain('not supported');
  });

  it('rejects a runtime API version this platform does not implement', () => {
    const manifest = baseManifest();
    manifest['runtime'] = { apiVersion: '2' };
    const result = validate(manifest);
    expect(issuePaths(result.issues)).toContain('runtime.apiVersion');
    expect(SUPPORTED_RUNTIME_API_VERSIONS).toContain(RUNTIME_API_VERSION);
  });

  it('rejects a minimum runtime API version above what the platform implements', () => {
    const manifest = baseManifest();
    manifest['runtime'] = { apiVersion: '1', minApiVersion: '9' };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'runtime.minApiVersion')?.message).toContain(
      `platform implements ${RUNTIME_API_VERSION}`,
    );
  });

  it('requires Phaser projects to declare the audio capability', () => {
    const manifest = baseManifest();
    manifest['engine'] = { name: 'phaser', version: ENGINE_SPECS.phaser.versions[0] };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'capabilities')?.message).toContain('audio');
  });
});

describe('licence and asset coverage', () => {
  it('requires a licence file to exist in the project', () => {
    const manifest = baseManifest();
    manifest['license'] = { ...(manifest['license'] as object), file: 'COPYING' };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'license.file')?.message).toContain('missing');
  });

  it('rejects a licence identifier the platform does not know', () => {
    const manifest = baseManifest();
    manifest['license'] = { ...(manifest['license'] as object), spdx: 'WTFPL' };
    const result = validate(manifest);
    expect(result.issues.some((issue) => issue.path === 'license.spdx')).toBe(true);
  });

  it('reports every asset that no licence entry covers', () => {
    const result = validate(baseManifest(), [...FILES, 'assets/ui/extra.png']);
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.path === 'license.assets')?.message).toContain(
      'assets/ui/extra.png',
    );
  });

  it('reports a licence entry that matches nothing in the project', () => {
    const manifest = baseManifest();
    manifest['license'] = {
      ...(manifest['license'] as object),
      assets: [
        ...((manifest['license'] as { assets: unknown[] }).assets),
        { path: 'assets/ui/ghost.svg', license: 'MIT', source: 'original artwork', attribution: 'ghost' },
      ],
    };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'license.assets')?.message).toContain('ghost.svg');
  });

  it('accepts a wildcard that covers one path segment', () => {
    const manifest = baseManifest();
    manifest['license'] = {
      ...(manifest['license'] as object),
      assets: [
        { path: 'assets/*.svg', license: 'MIT', source: 'original artwork', attribution: 'all svgs' },
        ...((manifest['license'] as { assets: unknown[] }).assets as never[]),
      ],
    };
    const result = validate(manifest, [...FILES, 'assets/other.svg']);
    expect(result.issues.filter((issue) => issue.path === 'license.assets')).toEqual([]);
  });

  it('does not let a wildcard span directory separators', () => {
    const manifest = baseManifest();
    manifest['license'] = {
      ...(manifest['license'] as object),
      assets: [{ path: 'assets/*.svg', license: 'MIT', source: 'original artwork', attribution: 'all svgs' }],
    };
    const result = validate(manifest, [...FILES, 'assets/deep/nested.svg']);
    expect(result.ok).toBe(false);
  });
});

describe('assetPatternMatches', () => {
  it('matches an exact path', () => {
    expect(assetPatternMatches('assets/ui/mark.svg', 'assets/ui/mark.svg')).toBe(true);
  });

  it('matches a wildcard inside a single segment', () => {
    expect(assetPatternMatches('assets/ui/*.png', 'assets/ui/mark.png')).toBe(true);
    expect(assetPatternMatches('assets/*.png', 'assets/mark.png')).toBe(true);
  });

  it('refuses to span more than one segment', () => {
    expect(assetPatternMatches('assets/*.png', 'assets/ui/mark.png')).toBe(false);
    expect(assetPatternMatches('*.svg', 'assets/ui/mark.svg')).toBe(false);
  });

  it('refuses a literal pattern that does not match', () => {
    expect(assetPatternMatches('assets/ui/mark.svg', 'assets/ui/other.svg')).toBe(false);
  });
});

describe('remix declaration coherence', () => {
  it('rejects modes declared while remixing is disabled', () => {
    const manifest = baseManifest();
    manifest['remix'] = { allowed: false, modes: ['source'], parameters: [] };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'remix.modes')?.message).toContain('allowed is false');
  });

  it('rejects an allowed declaration with no modes', () => {
    const manifest = baseManifest();
    manifest['remix'] = { allowed: true, modes: [], parameters: [] };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'remix.modes')?.message).toContain('no remix modes');
  });

  it('requires at least one parameter when the parameters mode is declared', () => {
    const manifest = baseManifest();
    manifest['remix'] = { allowed: true, modes: ['parameters'], parameters: [] };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'remix.parameters')?.message).toContain('at least one');
  });

  it('rejects duplicate parameter keys', () => {
    const manifest = baseManifest();
    manifest['remix'] = {
      allowed: true,
      modes: ['parameters'],
      parameters: [
        { key: 'speed', label: 'Speed', type: 'number', min: 1, max: 2, default: 1 },
        { key: 'speed', label: 'Speed again', type: 'boolean', default: true },
      ],
    };
    const result = validate(manifest);
    expect(result.issues.some((issue) => issue.path === 'remix.parameters[1].key')).toBe(true);
  });

  it('rejects a number default outside the declared range', () => {
    const manifest = baseManifest();
    manifest['remix'] = {
      allowed: true,
      modes: ['parameters'],
      parameters: [{ key: 'speed', label: 'Speed', type: 'number', min: 1, max: 2, default: 9 }],
    };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'remix.parameters[0].default')?.message).toContain('inside');
  });

  it('rejects min greater than max', () => {
    const manifest = baseManifest();
    manifest['remix'] = {
      allowed: true,
      modes: ['parameters'],
      parameters: [{ key: 'speed', label: 'Speed', type: 'number', min: 5, max: 2, default: 5 }],
    };
    const result = validate(manifest);
    expect(result.issues.some((issue) => issue.message === 'min must be lower than max')).toBe(true);
  });

  it('rejects a select default that is not one of the options', () => {
    const manifest = baseManifest();
    manifest['remix'] = {
      allowed: true,
      modes: ['parameters'],
      parameters: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          options: [
            { value: 'easy', label: 'Easy' },
            { value: 'hard', label: 'Hard' },
          ],
          default: 'impossible',
        },
      ],
    };
    const result = validate(manifest);
    expect(result.issues.find((issue) => issue.path === 'remix.parameters[0].default')?.message).toContain(
      'one of the declared options',
    );
  });
});

describe('budgets', () => {
  it('rejects a first-playable budget above the platform limit', () => {
    const manifest = baseManifest();
    manifest['budgets'] = { firstPlayableBytes: DEFAULT_LIMITS.maxFirstPlayableBytes + 1024 };
    const result = validate(manifest);
    expect(issueCode(result.issues, 'budgets.firstPlayableBytes')).toBe('out_of_range');
  });

  it('accepts a budget inside the platform limit', () => {
    const manifest = baseManifest();
    manifest['budgets'] = { firstPlayableBytes: 131_072, totalBytes: 1_048_576 };
    expect(validate(manifest).ok).toBe(true);
  });

  it('reads the budget ceiling from the supplied limits, not a hard-coded constant', () => {
    const manifest = baseManifest();
    manifest['budgets'] = { firstPlayableBytes: 5_000_000 };
    const relaxed = validate(manifest, FILES, { ...DEFAULT_LIMITS, maxFirstPlayableBytes: 6_000_000 });
    expect(relaxed.ok).toBe(true);
    expect(validate(manifest, FILES).ok).toBe(false);
  });
});

describe('applyRemixParameters', () => {
  const parameters: GameManifest['remix']['parameters'] = [
    { key: 'speed', label: 'Speed', type: 'number', min: 1, max: 2, default: 1.5 },
    { key: 'shake', label: 'Shake', type: 'boolean', default: true },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      options: [
        { value: 'easy', label: 'Easy' },
        { value: 'hard', label: 'Hard' },
      ],
      default: 'easy',
    },
    { key: 'accent', label: 'Accent', type: 'color', default: '#7c5cff' },
  ];

  it('fills in declared defaults when nothing is supplied', () => {
    const result = applyRemixParameters(parameters, null);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ speed: 1.5, shake: true, mode: 'easy', accent: '#7c5cff' });
  });

  it('rejects an unknown key', () => {
    const result = applyRemixParameters(parameters, { nope: 1 });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({ key: 'nope', message: 'is not a declared remix parameter' });
  });

  it('rejects an out-of-range number and reports the range', () => {
    const result = applyRemixParameters(parameters, { speed: 9 });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('between 1 and 2');
  });

  it('rejects a select value that is not declared', () => {
    const result = applyRemixParameters(parameters, { mode: 'impossible' });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed colour and normalises an accepted one', () => {
    expect(applyRemixParameters(parameters, { accent: 'red' }).ok).toBe(false);
    expect(applyRemixParameters(parameters, { accent: '#ABCDEF' }).value.accent).toBe('#abcdef');
  });

  it('reports every missing parameter when requireAll is set', () => {
    const result = applyRemixParameters(parameters, {}, { requireAll: true });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(parameters.length);
  });
});
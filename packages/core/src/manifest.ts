/**
 * The platform-native project manifest (`game.json`).
 *
 * A project is a small, self-contained directory tree. The manifest is the only
 * place that declares how it should be built and run; the platform never
 * executes creator-authored build scripts.
 */

import { DEFAULT_LIMITS as defaultLimitsForManifest } from './limits.ts';
import type { Limits } from './limits.ts';
import { validateLicenseDeclaration } from './license.ts';
import { checkPathSafety, classifyProjectPath, extensionOf } from './paths.ts';
import {
  formatIssues,
  hexColorShape,
  schema,
  slugShape,
  type Shape,
  type ValidationIssue,
} from './schema.ts';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE_NAME = 'game.json';

/** Runtime bridge API version implemented by this platform release. */
export const RUNTIME_API_VERSION = '1';
export const SUPPORTED_RUNTIME_API_VERSIONS = ['1'] as const;

export const ENGINE_NAMES = ['canvas2d', 'phaser'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export interface EngineSpec {
  name: EngineName;
  /** Exact, pinned engine versions builds may use. */
  versions: string[];
  /** Nothing is fetched from the network: the engine ships with the worker. */
  vendored: boolean;
  description: string;
  /** Approximate minified engine payload in bytes (used for budget hints). */
  approximateEngineBytes: number;
}

export const ENGINE_SPECS: Record<EngineName, EngineSpec> = {
  canvas2d: {
    name: 'canvas2d',
    versions: ['1.0.0'],
    vendored: true,
    description: 'Platform Canvas 2D helpers. Zero dependencies, smallest possible payload.',
    approximateEngineBytes: 0,
  },
  phaser: {
    name: 'phaser',
    versions: ['4.2.1'],
    vendored: true,
    description: 'Phaser 4 (pinned). WebGL-first 2D engine, vendored in the build toolchain.',
    approximateEngineBytes: 1_400_000,
  },
};

export type RemixParameterType = 'number' | 'boolean' | 'select' | 'color';

export interface RemixParameterBase {
  key: string;
  label: string;
  description?: string;
  type: RemixParameterType;
  /** Grouping label used by the remix editor. */
  group?: string;
}

export interface NumberRemixParameter extends RemixParameterBase {
  type: 'number';
  min: number;
  max: number;
  step?: number;
  default: number;
}

export interface BooleanRemixParameter extends RemixParameterBase {
  type: 'boolean';
  default: boolean;
}

export interface SelectRemixParameter extends RemixParameterBase {
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}

export interface ColorRemixParameter extends RemixParameterBase {
  type: 'color';
  default: string;
}

export type RemixParameter =
  | NumberRemixParameter
  | BooleanRemixParameter
  | SelectRemixParameter
  | ColorRemixParameter;

export interface RemixDeclaration {
  allowed: boolean;
  modes: ('parameters' | 'source')[];
  parameters: RemixParameter[];
}

export interface AssetLicenseEntry {
  path: string;
  license: string;
  source: string;
  attribution?: string;
}

export interface GameLicenseBlock {
  spdx: string;
  file?: string;
  attributionText?: string;
  assets: AssetLicenseEntry[];
}

export interface GamePresentation {
  thumbnail?: string;
  preview?: string;
  accentColor?: string;
  tags?: string[];
}

export interface GameManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  slug: string;
  title: string;
  description: string;
  engine: { name: EngineName; version: string };
  runtime: { apiVersion: string; minApiVersion?: string };
  entry: string;
  orientation: 'portrait' | 'landscape' | 'any';
  viewport: { width: number; height: number; scale: 'fit' | 'cover' | 'stretch' };
  input: ('pointer' | 'touch' | 'keyboard' | 'gamepad')[];
  capabilities: ('storage' | 'score' | 'audio' | 'vibration' | 'fullscreen' | 'link-out')[];
  license: GameLicenseBlock;
  remix: RemixDeclaration;
  presentation?: GamePresentation;
  authors?: { name: string; url?: string }[];
  budgets?: { firstPlayableBytes?: number; totalBytes?: number };
  /** Informational only: Moydan does not require an external repository. */
  repository?: { provider: 'github' | 'gitlab' | 'other'; url: string };
}

export const REMIX_PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,39}$/;

export const MAX_REMIX_PARAMETERS = 32;

const numberParameterShape: Shape<NumberRemixParameter> = schema.object({
  key: schema.string({ minLength: 2, maxLength: 40, pattern: REMIX_PARAMETER_KEY_PATTERN, patternMessage: 'parameter keys must be lowercase identifiers' }),
  label: schema.string({ minLength: 1, maxLength: 60 }),
  description: schema.string({ maxLength: 200 }).optional(),
  group: schema.string({ maxLength: 40 }).optional(),
  type: schema.literal('number'),
  min: schema.number({ min: -1_000_000, max: 1_000_000 }),
  max: schema.number({ min: -1_000_000, max: 1_000_000 }),
  step: schema.number({ min: 0.0001, max: 1_000_000 }).optional(),
  default: schema.number({ min: -1_000_000, max: 1_000_000 }),
}) as unknown as Shape<NumberRemixParameter>;

const booleanParameterShape: Shape<BooleanRemixParameter> = schema.object({
  key: schema.string({ minLength: 2, maxLength: 40, pattern: REMIX_PARAMETER_KEY_PATTERN }),
  label: schema.string({ minLength: 1, maxLength: 60 }),
  description: schema.string({ maxLength: 200 }).optional(),
  group: schema.string({ maxLength: 40 }).optional(),
  type: schema.literal('boolean'),
  default: schema.boolean(),
}) as unknown as Shape<BooleanRemixParameter>;

const selectParameterShape: Shape<SelectRemixParameter> = schema.object({
  key: schema.string({ minLength: 2, maxLength: 40, pattern: REMIX_PARAMETER_KEY_PATTERN }),
  label: schema.string({ minLength: 1, maxLength: 60 }),
  description: schema.string({ maxLength: 200 }).optional(),
  group: schema.string({ maxLength: 40 }).optional(),
  type: schema.literal('select'),
  options: schema.array(
    schema.object({
      value: schema.string({ minLength: 1, maxLength: 40 }),
      label: schema.string({ minLength: 1, maxLength: 60 }),
    }),
    { minLength: 2, maxLength: 12 },
  ),
  default: schema.string({ minLength: 1, maxLength: 40 }),
}) as unknown as Shape<SelectRemixParameter>;

const colorParameterShape: Shape<ColorRemixParameter> = schema.object({
  key: schema.string({ minLength: 2, maxLength: 40, pattern: REMIX_PARAMETER_KEY_PATTERN }),
  label: schema.string({ minLength: 1, maxLength: 60 }),
  description: schema.string({ maxLength: 200 }).optional(),
  group: schema.string({ maxLength: 40 }).optional(),
  type: schema.literal('color'),
  default: hexColorShape,
}) as unknown as Shape<ColorRemixParameter>;

export const remixParameterShape: Shape<RemixParameter> = schema.union<RemixParameter>(
  numberParameterShape,
  booleanParameterShape,
  selectParameterShape,
  colorParameterShape,
);

export const manifestShape: Shape<GameManifest> = schema.object({
  manifestVersion: schema.literal(MANIFEST_VERSION),
  slug: slugShape,
  title: schema.string({ minLength: 1, maxLength: 60 }),
  description: schema.string({ minLength: 1, maxLength: 280 }),
  engine: schema.object({
    name: schema.enum(ENGINE_NAMES, 'canvas2d | phaser'),
    version: schema.string({ minLength: 1, maxLength: 32, pattern: /^\d+\.\d+\.\d+$/, patternMessage: 'engine versions are exact, e.g. "4.2.1"' }),
  }),
  runtime: schema.object({
    apiVersion: schema.string({ minLength: 1, maxLength: 8, pattern: /^\d+$/ }),
    minApiVersion: schema.string({ minLength: 1, maxLength: 8, pattern: /^\d+$/ }).optional(),
  }),
  entry: schema.string({ minLength: 3, maxLength: 160 }),
  orientation: schema.enum(['portrait', 'landscape', 'any'] as const),
  viewport: schema.object({
    width: schema.number({ min: 120, max: 4096, integer: true }),
    height: schema.number({ min: 120, max: 4096, integer: true }),
    scale: schema.enum(['fit', 'cover', 'stretch'] as const),
  }),
  input: schema.array(schema.enum(['pointer', 'touch', 'keyboard', 'gamepad'] as const), { maxLength: 4 }),
  capabilities: schema.array(
    schema.enum(['storage', 'score', 'audio', 'vibration', 'fullscreen', 'link-out'] as const),
    { maxLength: 6 },
  ),
  license: schema.object({
    spdx: schema.string({ minLength: 2, maxLength: 64 }),
    file: schema.string({ maxLength: 120 }).optional(),
    attributionText: schema.string({ maxLength: 600 }).optional(),
    assets: schema.array(
      schema.object({
        path: schema.string({ minLength: 1, maxLength: 120 }),
        license: schema.string({ minLength: 2, maxLength: 64 }),
        source: schema.string({ minLength: 1, maxLength: 200 }),
        attribution: schema.string({ maxLength: 300 }).optional(),
      }),
      { maxLength: 60 },
    ),
  }),
  remix: schema.object({
    allowed: schema.boolean(),
    modes: schema.array(schema.enum(['parameters', 'source'] as const), { maxLength: 2 }),
    parameters: schema.array(remixParameterShape, { maxLength: MAX_REMIX_PARAMETERS }),
  }),
  presentation: schema
    .object({
      thumbnail: schema.string({ maxLength: 120 }).optional(),
      preview: schema.string({ maxLength: 120 }).optional(),
      accentColor: hexColorShape.optional(),
      tags: schema.array(schema.string({ minLength: 1, maxLength: 24, pattern: /^[a-z0-9-]+$/ }), { maxLength: 8 }).optional(),
    })
    .optional(),
  authors: schema
    .array(
      schema.object({
        name: schema.string({ minLength: 1, maxLength: 60 }),
        url: schema.string({ minLength: 8, maxLength: 200, pattern: /^https:\/\/[^\s]+$/ }).optional(),
      }),
      { maxLength: 10 },
    )
    .optional(),
  budgets: schema
    .object({
      firstPlayableBytes: schema.number({ min: 16_384, max: 16 * 1024 * 1024, integer: true }).optional(),
      totalBytes: schema.number({ min: 16_384, max: 64 * 1024 * 1024, integer: true }).optional(),
    })
    .optional(),
  repository: schema
    .object({
      provider: schema.enum(['github', 'gitlab', 'other'] as const),
      url: schema
        .string({ minLength: 10, maxLength: 300, pattern: /^https:\/\/[^\s]+$/, patternMessage: 'repository URLs must use https' }),
    })
    .optional(),
});

export interface ManifestValidationContext {
  limits: Limits;
  /** Files present in the project (relative paths), used for cross-checks. */
  files: readonly string[];
}

export interface ManifestValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest: GameManifest | null;
}

/**
 * Full manifest validation: schema, then cross-checks against the project's
 * actual file tree and the platform's engine/runtime allowlists.
 */
export function validateGameManifest(input: unknown, context: ManifestValidationContext): ManifestValidationResult {
  const trimmedLimits = { ...defaultLimitsForManifest, ...context.limits };
  const parsed = manifestShape.validate(input);
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues, manifest: null };
  }
  const manifest = parsed.value;
  const issues: ValidationIssue[] = [];
  const push = (path: string, message: string, code: ValidationIssue['code'] = 'not_allowed') =>
    issues.push({ path, code, message });

  // Engine pinning.
  const engineSpec = ENGINE_SPECS[manifest.engine.name];
  if (!engineSpec.versions.includes(manifest.engine.version)) {
    push(
      'engine.version',
      `engine "${manifest.engine.name}" version ${manifest.engine.version} is not supported; available: ${engineSpec.versions.join(', ')}`,
    );
  }

  // Runtime API compatibility.
  if (!SUPPORTED_RUNTIME_API_VERSIONS.includes(manifest.runtime.apiVersion as (typeof SUPPORTED_RUNTIME_API_VERSIONS)[number])) {
    push(
      'runtime.apiVersion',
      `runtime API version "${manifest.runtime.apiVersion}" is not supported by this platform (supported: ${SUPPORTED_RUNTIME_API_VERSIONS.join(', ')})`,
    );
  }
  if (
    manifest.runtime.minApiVersion &&
    Number(manifest.runtime.minApiVersion) > Number(RUNTIME_API_VERSION)
  ) {
    push(
      'runtime.minApiVersion',
      `this game requires runtime API ${manifest.runtime.minApiVersion} but the platform implements ${RUNTIME_API_VERSION}`,
    );
  }

  // Entry point.
  const entryProblem = checkPathSafety(manifest.entry);
  if (entryProblem) {
    push('entry', `entry point is invalid: ${entryProblem.message}`, 'bad_format');
  } else if (classifyProjectPath(manifest.entry, { allowTests: false }) !== 'source') {
    push('entry', 'entry point must be a source file inside src/ with an allowed extension');
  } else if (context.files.length > 0 && !context.files.includes(manifest.entry)) {
    push('entry', `entry point "${manifest.entry}" is not part of the project`);
  }

  // Licence.
  for (const issue of validateLicenseDeclaration({
    spdx: manifest.license.spdx,
    file: manifest.license.file,
    attributionText: manifest.license.attributionText,
    assets: manifest.license.assets,
  })) {
    push(issue.path, issue.message);
  }
  const licenseFile = manifest.license.file ?? 'LICENSE';
  if (checkPathSafety(licenseFile)) {
    push('license.file', 'licence file path is invalid', 'bad_format');
  } else if (context.files.length > 0 && !context.files.includes(licenseFile)) {
    push('license.file', `licence file "${licenseFile}" is missing from the project`);
  }

  // Asset references must exist and be declared.
  const declaredAssetPaths = new Set(manifest.license.assets.map((entry) => entry.path));
  for (const file of context.files) {
    const role = classifyProjectPath(file);
    if (role !== 'asset') continue;
    const covered = [...declaredAssetPaths].some((declared) => assetPatternMatches(declared, file));
    if (!covered) {
      push(
        'license.assets',
        `asset "${file}" has no licence declaration; add an entry to license.assets in ${MANIFEST_FILE_NAME}`,
      );
    }
  }
  for (const entry of manifest.license.assets) {
    const matches = context.files.filter((file) => assetPatternMatches(entry.path, file));
    if (context.files.length > 0 && matches.length === 0) {
      push('license.assets', `asset declaration "${entry.path}" does not match any file in the project`);
    }
  }

  // Presentation assets.
  for (const [key, value] of Object.entries({
    thumbnail: manifest.presentation?.thumbnail,
    preview: manifest.presentation?.preview,
  })) {
    if (!value) continue;
    if (classifyProjectPath(value) !== 'asset') {
      push(`presentation.${key}`, `${key} must reference a file under assets/`);
    } else if (context.files.length > 0 && !context.files.includes(value)) {
      push(`presentation.${key}`, `${key} file "${value}" is missing from the project`);
    }
  }

  // Engine-specific entry extension rules.
  if (manifest.engine.name === 'phaser') {
    if (!manifest.capabilities.includes('audio')) {
      // Phaser always creates an audio context; requiring the declaration keeps
      // the sandbox permissions honest.
      push('capabilities', 'phaser projects must declare the "audio" capability');
    }
    const entryExtension = extensionOf(manifest.entry);
    if (!['.ts', '.js', '.mjs'].includes(entryExtension)) {
      push('entry', 'phaser entry points must be TypeScript or JavaScript modules');
    }
  }

  // Remix declaration coherence.
  if (manifest.remix.allowed && manifest.remix.modes.length === 0) {
    push('remix.modes', 'remix.allowed is true but no remix modes are declared');
  }
  if (!manifest.remix.allowed && manifest.remix.modes.length > 0) {
    push('remix.modes', 'remix.allowed is false but remix modes are declared');
  }
  if (manifest.remix.modes.includes('parameters') && manifest.remix.parameters.length === 0) {
    push('remix.parameters', 'parameter remixes need at least one declared parameter');
  }
  const seenKeys = new Set<string>();
  for (const [index, parameter] of manifest.remix.parameters.entries()) {
    if (seenKeys.has(parameter.key)) {
      push(`remix.parameters[${index}].key`, `duplicate parameter key "${parameter.key}"`);
    }
    seenKeys.add(parameter.key);
    if (parameter.type === 'number') {
      if (parameter.min >= parameter.max) {
        push(`remix.parameters[${index}]`, 'min must be lower than max');
      }
      if (parameter.default < parameter.min || parameter.default > parameter.max) {
        push(`remix.parameters[${index}].default`, 'default must be inside the allowed range');
      }
    }
    if (parameter.type === 'select') {
      if (!parameter.options.some((option) => option.value === parameter.default)) {
        push(`remix.parameters[${index}].default`, 'default must be one of the declared options');
      }
    }
  }

  // Budgets.
  if (manifest.budgets?.firstPlayableBytes && manifest.budgets.firstPlayableBytes > trimmedLimits.maxFirstPlayableBytes) {
    push(
      'budgets.firstPlayableBytes',
      `first playable budget exceeds the platform limit of ${trimmedLimits.maxFirstPlayableBytes} bytes`,
      'out_of_range',
    );
  }

  if (issues.length > 0) return { ok: false, issues, manifest: null };
  return { ok: true, issues: [], manifest };
}

export function assetPatternMatches(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  const starIndex = pattern.indexOf('*');
  if (starIndex === -1) return false;
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);
  if (!file.startsWith(prefix) || !file.endsWith(suffix) || file.length < prefix.length + suffix.length) {
    return false;
  }
  // A single `*` matches within one path segment only.
  const middle = file.slice(prefix.length, file.length - suffix.length);
  return !middle.includes('/');
}

export type RemixParameterValues = Record<string, number | boolean | string>;

export interface RemixParameterValidation {
  ok: boolean;
  value: RemixParameterValues;
  issues: { key: string; message: string }[];
}

/**
 * Validate/coerce a remix configuration against the parent manifest's declared
 * parameters. Unknown keys are dropped and out-of-range values are clamped only
 * when the manifest declares an explicit clamp policy — otherwise they fail.
 */
export function applyRemixParameters(
  parameters: readonly RemixParameter[],
  overrides: Record<string, unknown> | null | undefined,
  options: { requireAll?: boolean } = {},
): RemixParameterValidation {
  const issues: { key: string; message: string }[] = [];
  const value: RemixParameterValues = {};
  const provided = overrides ?? {};
  for (const key of Object.keys(provided)) {
    if (!parameters.some((parameter) => parameter.key === key)) {
      issues.push({ key, message: 'is not a declared remix parameter' });
    }
  }
  for (const parameter of parameters) {
    const raw = provided[parameter.key];
    if (raw === undefined) {
      if (options.requireAll) {
        issues.push({ key: parameter.key, message: 'is required' });
        continue;
      }
      value[parameter.key] = parameter.default;
      continue;
    }
    switch (parameter.type) {
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          issues.push({ key: parameter.key, message: 'must be a number' });
          break;
        }
        if (raw < parameter.min || raw > parameter.max) {
          issues.push({
            key: parameter.key,
            message: `must be between ${parameter.min} and ${parameter.max}`,
          });
          break;
        }
        value[parameter.key] = raw;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') {
          issues.push({ key: parameter.key, message: 'must be true or false' });
          break;
        }
        value[parameter.key] = raw;
        break;
      }
      case 'select': {
        if (typeof raw !== 'string' || !parameter.options.some((option) => option.value === raw)) {
          issues.push({
            key: parameter.key,
            message: `must be one of: ${parameter.options.map((option) => option.value).join(', ')}`,
          });
          break;
        }
        value[parameter.key] = raw;
        break;
      }
      case 'color': {
        if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) {
          issues.push({ key: parameter.key, message: 'must be a hex colour such as "#7c5cff"' });
          break;
        }
        value[parameter.key] = raw.toLowerCase();
        break;
      }
    }
  }
  return { ok: issues.length === 0, value, issues };
}

export function defaultRemixParameterValues(parameters: readonly RemixParameter[]): RemixParameterValues {
  const value: RemixParameterValues = {};
  for (const parameter of parameters) value[parameter.key] = parameter.default;
  return value;
}

export function describeManifestIssues(issues: ValidationIssue[]): string {
  return formatIssues(issues);
}

/** Files every project must contain, independent of template. */
export const REQUIRED_PROJECT_FILES = [MANIFEST_FILE_NAME, 'LICENSE'] as const;

export function limitsPlaceholder(): Limits {
  return defaultLimitsForManifest;
}

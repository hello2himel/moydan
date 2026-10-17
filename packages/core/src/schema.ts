/**
 * A tiny, dependency-free validation library shared by the browser runtime, the
 * API, the build workers, and the creator CLI.
 *
 * Why not a general purpose schema library?
 * - The same schemas must run inside the untrusted game sandbox (no bundler
 *   weight, no `eval`), in the API, in the worker, and in the editor UI.
 * - The rules we need are small and explicit: strict objects, bounded strings,
 *   bounded arrays, safe paths, numeric ranges.
 * - Every failure mode must be *reject*, never "permit by default".
 *
 * The implementation is intentionally strict:
 * - object shapes reject unknown keys unless `allowUnknown` is set;
 * - arrays and strings are bounded;
 * - numbers reject NaN/Infinity;
 * - prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are
 *   rejected as property names anywhere.
 *
 * The code is written to stay compatible with Node's "type stripping" mode so
 * the platform can run `.ts` files directly (no build step for the server).
 */

export interface ValidationIssue {
  path: string;
  code:
    | 'invalid_type'
    | 'required'
    | 'unknown_key'
    | 'out_of_range'
    | 'bad_format'
    | 'too_many'
    | 'too_large'
    | 'not_allowed';
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function issue(path: string, code: ValidationIssue['code'], message: string): ValidationIssue {
  return { path: path || '$', code, message };
}

export abstract class Shape<T> {
  abstract parse(value: unknown, path: string): ValidationResult<T>;

  /** Convenience wrapper that starts at the document root. */
  validate(value: unknown): ValidationResult<T> {
    return this.parse(value, '');
  }

  optional(): Shape<T | undefined> {
    const self = this;
    return new OptionalShape(self);
  }

  nullable(): Shape<T | null> {
    const self = this;
    return new NullableShape(self);
  }

  /** Default applied when the value is `undefined`. */
  withDefault(fallback: T): Shape<T> {
    return new DefaultedShape(this, fallback);
  }

  /**
   * Extra check applied after the base validation. Return `true`/`null` for a
   * pass, or a message (or `false` to use the supplied `message`) to fail.
   */
  refine(check: (value: T) => boolean | string | null, message = 'is not allowed'): Shape<T> {
    return new RefinedShape(this, check, message);
  }

  /** Human readable description, used in generated documentation. */
  describe(): string {
    return 'unknown';
  }
}

class OptionalShape<T> extends Shape<T | undefined> {
  private inner: Shape<T>;
  constructor(inner: Shape<T>) {
    super();
    this.inner = inner;
  }
  override parse(value: unknown, path: string): ValidationResult<T | undefined> {
    if (value === undefined) return { ok: true, value: undefined };
    return this.inner.parse(value, path);
  }
  override describe(): string {
    return `${this.inner.describe()}?`;
  }
}

class NullableShape<T> extends Shape<T | null> {
  private inner: Shape<T>;
  constructor(inner: Shape<T>) {
    super();
    this.inner = inner;
  }
  override parse(value: unknown, path: string): ValidationResult<T | null> {
    if (value === null) return { ok: true, value: null };
    return this.inner.parse(value, path);
  }
  override describe(): string {
    return `${this.inner.describe()} | null`;
  }
}

class DefaultedShape<T> extends Shape<T> {
  private inner: Shape<T>;
  private fallback: T;
  constructor(inner: Shape<T>, fallback: T) {
    super();
    this.inner = inner;
    this.fallback = fallback;
  }
  override parse(value: unknown, path: string): ValidationResult<T> {
    if (value === undefined) return { ok: true, value: this.fallback };
    return this.inner.parse(value, path);
  }
  override describe(): string {
    return this.inner.describe();
  }
}

class RefinedShape<T> extends Shape<T> {
  private inner: Shape<T>;
  private check: (value: T) => boolean | string | null;
  private message: string;
  constructor(inner: Shape<T>, check: (value: T) => boolean | string | null, message: string) {
    super();
    this.inner = inner;
    this.check = check;
    this.message = message;
  }
  override parse(value: unknown, path: string): ValidationResult<T> {
    const result = this.inner.parse(value, path);
    if (!result.ok) return result;
    const problem = this.check(result.value);
    if (problem === true || problem === null) return result;
    return { ok: false, issues: [issue(path, 'not_allowed', typeof problem === 'string' ? problem : this.message)] };
  }
  override describe(): string {
    return this.inner.describe();
  }
}

export interface StringShapeOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternMessage?: string;
  allowed?: readonly string[];
  description?: string;
}

export class StringShape extends Shape<string> {
  private opts: StringShapeOptions;
  constructor(opts: StringShapeOptions = {}) {
    super();
    this.opts = opts;
  }

  override parse(value: unknown, path: string): ValidationResult<string> {
    if (typeof value !== 'string') {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected a string, received ${typeName(value)}`)] };
    }
    const { minLength = 0, maxLength = 4096, pattern, allowed } = this.opts;
    if (value.length < minLength) {
      return {
        ok: false,
        issues: [issue(path, 'out_of_range', `must be at least ${minLength} characters (received ${value.length})`)],
      };
    }
    if (value.length > maxLength) {
      return { ok: false, issues: [issue(path, 'too_large', `must be at most ${maxLength} characters`)] };
    }
    if (allowed && !allowed.includes(value)) {
      return { ok: false, issues: [issue(path, 'not_allowed', `must be one of: ${allowed.join(', ')}`)] };
    }
    if (pattern && !pattern.test(value)) {
      return { ok: false, issues: [issue(path, 'bad_format', this.opts.patternMessage ?? 'has an invalid format')] };
    }
    return { ok: true, value };
  }

  override describe(): string {
    return this.opts.description ?? 'string';
  }
}

export class NumberShape extends Shape<number> {
  private opts: { min?: number; max?: number; integer?: boolean; description?: string };
  constructor(opts: { min?: number; max?: number; integer?: boolean; description?: string } = {}) {
    super();
    this.opts = opts;
  }

  override parse(value: unknown, path: string): ValidationResult<number> {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected a finite number, received ${typeName(value)}`)] };
    }
    const { min, max, integer } = this.opts;
    if (integer && !Number.isInteger(value)) {
      return { ok: false, issues: [issue(path, 'bad_format', 'expected an integer')] };
    }
    if (min !== undefined && value < min) return { ok: false, issues: [issue(path, 'out_of_range', `must be >= ${min}`)] };
    if (max !== undefined && value > max) return { ok: false, issues: [issue(path, 'out_of_range', `must be <= ${max}`)] };
    return { ok: true, value };
  }

  override describe(): string {
    return this.opts.description ?? 'number';
  }
}

export class BooleanShape extends Shape<boolean> {
  override parse(value: unknown, path: string): ValidationResult<boolean> {
    if (typeof value !== 'boolean') {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected a boolean, received ${typeName(value)}`)] };
    }
    return { ok: true, value };
  }
  override describe(): string {
    return 'boolean';
  }
}

export class LiteralShape<T extends string | number | boolean> extends Shape<T> {
  private literal: T;
  constructor(literal: T) {
    super();
    this.literal = literal;
  }
  override parse(value: unknown, path: string): ValidationResult<T> {
    if (value !== this.literal) {
      return { ok: false, issues: [issue(path, 'not_allowed', `must be exactly ${JSON.stringify(this.literal)}`)] };
    }
    return { ok: true, value: this.literal };
  }
  override describe(): string {
    return JSON.stringify(this.literal);
  }
}

export class EnumShape<A extends readonly string[]> extends Shape<A[number]> {
  private allowed: A;
  private description: string;
  constructor(allowed: A, description?: string) {
    super();
    this.allowed = allowed;
    this.description = description ?? allowed.join(' | ');
  }
  override parse(value: unknown, path: string): ValidationResult<A[number]> {
    if (typeof value !== 'string' || !(this.allowed as readonly string[]).includes(value)) {
      return {
        ok: false,
        issues: [issue(path, 'not_allowed', `must be one of: ${this.allowed.join(', ')}`)],
      };
    }
    return { ok: true, value: value as A[number] };
  }
  override describe(): string {
    return this.description;
  }
}

type ObjectShapeDef = Record<string, Shape<unknown>>;

type InferObject<D extends ObjectShapeDef> = {
  [K in keyof D as D[K] extends Shape<infer T> ? (undefined extends T ? never : K) : never]: D[K] extends Shape<infer T>
    ? T
    : never;
} & {
  [K in keyof D as D[K] extends Shape<infer T> ? (undefined extends T ? K : never) : never]?: D[K] extends Shape<infer T>
    ? T
    : never;
};

export class ObjectShape<D extends ObjectShapeDef, T = InferObject<D>> extends Shape<T> {
  private def: D;
  private opts: { maxKeys?: number; allowUnknown?: boolean };
  constructor(def: D, opts: { maxKeys?: number; allowUnknown?: boolean } = {}) {
    super();
    this.def = def;
    this.opts = opts;
  }

  override parse(value: unknown, path: string): ValidationResult<T> {
    if (!isPlainObject(value)) {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected an object, received ${typeName(value)}`)] };
    }
    const issues: ValidationIssue[] = [];
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    const maxKeys = this.opts.maxKeys ?? 200;
    if (keys.length > maxKeys) issues.push(issue(path, 'too_many', `object has more than ${maxKeys} keys`));
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) issues.push(issue(joinPath(path, key), 'not_allowed', 'forbidden key name'));
    }
    for (const [key, shape] of Object.entries(this.def)) {
      const childPath = joinPath(path, key);
      const result = shape.parse((value as Record<string, unknown>)[key], childPath);
      if (!result.ok) issues.push(...result.issues);
      else if (result.value !== undefined) out[key] = result.value;
    }
    for (const key of keys) {
      if (key in this.def || FORBIDDEN_KEYS.has(key)) continue;
      if (this.opts.allowUnknown) out[key] = (value as Record<string, unknown>)[key];
      else issues.push(issue(joinPath(path, key), 'unknown_key', `unknown key "${key}"`));
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out as T };
  }

  override describe(): string {
    return `{ ${Object.keys(this.def).join(', ')} }`;
  }
}

export class ArrayShape<I> extends Shape<I[]> {
  private item: Shape<I>;
  private opts: { minLength?: number; maxLength?: number };
  constructor(item: Shape<I>, opts: { minLength?: number; maxLength?: number } = {}) {
    super();
    this.item = item;
    this.opts = opts;
  }

  override parse(value: unknown, path: string): ValidationResult<I[]> {
    if (!Array.isArray(value)) {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected an array, received ${typeName(value)}`)] };
    }
    const { minLength = 0, maxLength = 512 } = this.opts;
    if (value.length < minLength) return { ok: false, issues: [issue(path, 'too_many', `expected at least ${minLength} items`)] };
    if (value.length > maxLength) return { ok: false, issues: [issue(path, 'too_many', `expected at most ${maxLength} items`)] };
    const out: I[] = [];
    const issues: ValidationIssue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const result = this.item.parse(value[index], `${path}[${index}]`);
      if (!result.ok) issues.push(...result.issues);
      else out.push(result.value);
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out };
  }

  override describe(): string {
    return `${this.item.describe()}[]`;
  }
}

export class RecordShape<I> extends Shape<Record<string, I>> {
  private valueShape: Shape<I>;
  private opts: { maxKeys?: number };
  constructor(valueShape: Shape<I>, opts: { maxKeys?: number } = {}) {
    super();
    this.valueShape = valueShape;
    this.opts = opts;
  }

  override parse(value: unknown, path: string): ValidationResult<Record<string, I>> {
    if (!isPlainObject(value)) {
      return { ok: false, issues: [issue(path, 'invalid_type', `expected an object, received ${typeName(value)}`)] };
    }
    const keys = Object.keys(value);
    const maxKeys = this.opts.maxKeys ?? 256;
    if (keys.length > maxKeys) return { ok: false, issues: [issue(path, 'too_many', `expected at most ${maxKeys} keys`)] };
    const out: Record<string, I> = {};
    const issues: ValidationIssue[] = [];
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(issue(joinPath(path, key), 'not_allowed', 'forbidden key name'));
        continue;
      }
      const result = this.valueShape.parse((value as Record<string, unknown>)[key], joinPath(path, key));
      if (!result.ok) issues.push(...result.issues);
      else out[key] = result.value;
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out };
  }
}

export class UnionShape<T> extends Shape<T> {
  private variants: Shape<unknown>[];
  constructor(variants: Shape<unknown>[]) {
    super();
    this.variants = variants;
  }
  override parse(value: unknown, path: string): ValidationResult<T> {
    for (const variant of this.variants) {
      const result = variant.parse(value, path);
      if (result.ok) return { ok: true, value: result.value as T };
    }
    return { ok: false, issues: [issue(path, 'invalid_type', 'did not match any allowed variant')] };
  }
  override describe(): string {
    return this.variants.map((variant) => variant.describe()).join(' | ');
  }
}

/** A JSON value with bounded depth, key count, and total serialized size. */
export class JsonShape extends Shape<unknown> {
  private opts: { maxBytes?: number; maxDepth?: number };
  constructor(opts: { maxBytes?: number; maxDepth?: number } = {}) {
    super();
    this.opts = opts;
  }
  override parse(value: unknown, path: string): ValidationResult<unknown> {
    const maxDepth = this.opts.maxDepth ?? 6;
    const maxBytes = this.opts.maxBytes ?? 4096;
    const seen = new Set<unknown>();
    const issues: ValidationIssue[] = [];
    const walk = (node: unknown, depth: number, nodePath: string): void => {
      if (issues.length > 3) return;
      if (depth > maxDepth) {
        issues.push(issue(nodePath, 'too_large', `exceeds maximum depth of ${maxDepth}`));
        return;
      }
      if (node === null || typeof node === 'boolean' || typeof node === 'string') {
        if (typeof node === 'string' && node.length > 2048) {
          issues.push(issue(nodePath, 'too_large', 'string values are limited to 2048 characters'));
        }
        return;
      }
      if (typeof node === 'number') {
        if (!Number.isFinite(node)) issues.push(issue(nodePath, 'bad_format', 'numbers must be finite'));
        return;
      }
      if (Array.isArray(node)) {
        if (node.length > 128) {
          issues.push(issue(nodePath, 'too_many', 'arrays are limited to 128 items'));
          return;
        }
        node.forEach((item, index) => walk(item, depth + 1, `${nodePath}[${index}]`));
        return;
      }
      if (isPlainObject(node)) {
        if (seen.has(node)) {
          issues.push(issue(nodePath, 'bad_format', 'cyclic values are not allowed'));
          return;
        }
        seen.add(node);
        const keys = Object.keys(node);
        if (keys.length > 64) issues.push(issue(nodePath, 'too_many', 'objects are limited to 64 keys'));
        for (const key of keys) {
          if (FORBIDDEN_KEYS.has(key)) {
            issues.push(issue(joinPath(nodePath, key), 'not_allowed', 'forbidden key name'));
            continue;
          }
          walk(node[key], depth + 1, joinPath(nodePath, key));
        }
        seen.delete(node);
        return;
      }
      if (typeof node === 'undefined') return;
      issues.push(issue(nodePath, 'invalid_type', `expected a JSON value, received ${typeName(node)}`));
    };
    walk(value, 0, path);
    if (issues.length > 0) return { ok: false, issues };
    let serialized: string;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      return { ok: false, issues: [issue(path, 'bad_format', 'value could not be serialized')] };
    }
    if (serialized.length > maxBytes) {
      return { ok: false, issues: [issue(path, 'too_large', `serialized value exceeds ${maxBytes} bytes`)] };
    }
    return { ok: true, value };
  }
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const schema = {
  string: (opts?: StringShapeOptions) => new StringShape(opts),
  number: (opts?: { min?: number; max?: number; integer?: boolean; description?: string }) => new NumberShape(opts),
  boolean: () => new BooleanShape(),
  literal: <T extends string | number | boolean>(value: T) => new LiteralShape(value),
  enum: <const A extends readonly string[]>(allowed: A, description?: string) => new EnumShape(allowed, description),
  object: <D extends ObjectShapeDef>(def: D, opts?: { maxKeys?: number; allowUnknown?: boolean }) =>
    new ObjectShape<D>(def, opts),
  array: <I>(item: Shape<I>, opts?: { minLength?: number; maxLength?: number }) => new ArrayShape(item, opts),
  record: <I>(valueShape: Shape<I>, opts?: { maxKeys?: number }) => new RecordShape(valueShape, opts),
  union: <T>(...variants: Shape<unknown>[]) => new UnionShape<T>(variants),
  json: (opts?: { maxBytes?: number; maxDepth?: number }) => new JsonShape(opts),
};

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 12)
    .map((entry) => `${entry.path}: ${entry.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Common reusable shapes
// ---------------------------------------------------------------------------

export const RESERVED_HANDLES = new Set([
  'admin',
  'administrator',
  'moydan',
  'support',
  'help',
  'about',
  'settings',
  'login',
  'logout',
  'signup',
  'register',
  'saved',
  'create',
  'home',
  'feed',
  'explore',
  'api',
  'static',
  'assets',
  'moderation',
  'moderator',
  'system',
  'root',
  'official',
  'moydanteam',
]);

/** Lowercase slug: 3-40 chars, `a-z0-9` separated by single hyphens. */
export const slugShape: Shape<string> = schema
  .string({
    minLength: 3,
    maxLength: 40,
    pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    patternMessage: 'must be lowercase letters, digits and single hyphens (e.g. "bounce-dodge")',
    description: 'slug',
  })
  .refine((value) => !/^\d+$/.test(value), 'must contain at least one letter');

/** Creator handle: 3-24 chars, no leading `@`. */
export const handleShape: Shape<string> = schema
  .string({
    minLength: 3,
    maxLength: 24,
    pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/,
    patternMessage: 'must start and end with a letter or digit; letters, digits, "_" and "-" are allowed',
    description: 'handle',
  })
  .refine((value) => !RESERVED_HANDLES.has(value), 'this handle is reserved by the platform');

export const emailShape: Shape<string> = schema
  .string({
    minLength: 3,
    maxLength: 254,
    pattern: /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/,
    patternMessage: 'must be a valid email address',
    description: 'email',
  })
  .refine((value) => !value.includes('..'), 'email contains an invalid sequence');

export const idShape: Shape<string> = schema
  .string({
    minLength: 8,
    maxLength: 64,
    pattern: /^[a-z]+_[0-9a-hjkmnp-tv-z]{8,48}$/,
    patternMessage: 'must be a prefixed identifier such as "gam_4k2m..."',
    description: 'id',
  })
  .refine((value) => {
    const body = value.slice(value.indexOf('_') + 1);
    return !/[ilou]/.test(body);
  }, 'identifier contains an ambiguous character');

/** ISO-8601 timestamp in UTC. */
export const timestampShape: Shape<string> = schema
  .string({
    minLength: 20,
    maxLength: 24,
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    patternMessage: 'must be an ISO-8601 UTC timestamp such as "2026-01-31T09:15:00.000Z"',
    description: 'timestamp',
  })
  .refine((value) => !Number.isNaN(Date.parse(value)), 'timestamp is not a real date');

export const sha256Shape: Shape<string> = schema.string({
  minLength: 64,
  maxLength: 64,
  pattern: /^[0-9a-f]{64}$/,
  patternMessage: 'must be a lowercase hex sha256 digest',
  description: 'sha256',
});

export const hexColorShape: Shape<string> = schema.string({
  minLength: 7,
  maxLength: 7,
  pattern: /^#[0-9a-fA-F]{6}$/,
  patternMessage: 'must be a hex colour such as "#7c5cff"',
  description: 'hex colour',
});

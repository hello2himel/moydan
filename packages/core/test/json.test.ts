/**
 * Deterministic JSON is what artifact hashes and idempotency keys are built on:
 * two structurally equal documents must always serialise to the same bytes,
 * whatever order their keys happened to arrive in.
 */

import { describe, expect, it } from 'vitest';
import { cloneJson, jsonEqual, safeJsonParse, stableStringify, truncate } from '@moydan/core';

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('produces the same bytes for two equal documents written in different orders', () => {
    const left = stableStringify({ id: 'gam_1', files: [{ path: 'b', size: 2 }, { path: 'a', size: 1 }] });
    const right = stableStringify({ files: [{ path: 'b', size: 2 }, { path: 'a', size: 1 }], id: 'gam_1' });
    expect(left).toBe(right);
  });

  it('preserves array order, which is significant data', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
  });

  it('drops undefined properties instead of emitting them', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined])).toBe('[null]');
  });

  it('handles primitives and null', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(7)).toBe('7');
    expect(stableStringify(true)).toBe('true');
  });
});

describe('jsonEqual', () => {
  it('ignores key order but not array order', () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it('treats a missing key and an undefined value as equal', () => {
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  it('separates null from a missing key', () => {
    expect(jsonEqual({ a: null }, {})).toBe(false);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null instead of throwing on malformed input', () => {
    expect(safeJsonParse('{')).toBeNull();
    expect(safeJsonParse('')).toBeNull();
    expect(safeJsonParse('undefined')).toBeNull();
  });
});

describe('cloneJson', () => {
  it('produces a structurally equal but independent copy', () => {
    const source = { a: [1, { b: 2 }], c: 'x' };
    const copy = cloneJson(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    (copy.a[1] as { b: number }).b = 9;
    expect((source.a[1] as { b: number }).b).toBe(2);
  });
});

describe('truncate', () => {
  it('leaves a short value alone', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactlyten', 10)).toBe('exactlyten');
  });

  it('marks a truncated value with an ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('abcdefghij', 5)).toHaveLength(5);
  });
});
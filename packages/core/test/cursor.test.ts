/**
 * Cursors are opaque, unsigned and scope-bound. They carry no authority, so the
 * only invariants worth asserting are: a round trip preserves the keys, and a
 * cursor minted for one collection is useless in another.
 */

import { describe, expect, it } from 'vitest';
import {
  CURSOR_SCOPES,
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  readCursorKeyNumber,
  readCursorKeyString,
} from '@moydan/core';

function raw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a mixed key list', () => {
    const cursor = encodeCursor(CURSOR_SCOPES.forYouFeed, [12.5, '2026-01-31T09:15:00.000Z', 'gam_abc']);
    const decoded = decodeCursor(cursor, CURSOR_SCOPES.forYouFeed);
    expect(decoded).toEqual({
      v: CURSOR_VERSION,
      s: 'feed:foryou',
      k: [12.5, '2026-01-31T09:15:00.000Z', 'gam_abc'],
    });
  });

  it('produces a url-safe token with no padding', () => {
    const cursor = encodeCursor(CURSOR_SCOPES.comments, ['a', 'b']);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps a null sort key', () => {
    expect(decodeCursor(encodeCursor('x', [null]), 'x')?.k).toEqual([null]);
  });

  it('is deterministic for the same inputs', () => {
    expect(encodeCursor('s', [1, 'a'])).toBe(encodeCursor('s', [1, 'a']));
  });

  it('rejects a cursor minted for another collection', () => {
    const cursor = encodeCursor(CURSOR_SCOPES.forYouFeed, ['2026-01-01T00:00:00.000Z', 'gam_a']);
    expect(decodeCursor(cursor, CURSOR_SCOPES.followingFeed)).toBeNull();
  });

  it('returns null for absent or empty input', () => {
    expect(decodeCursor(null, 's')).toBeNull();
    expect(decodeCursor(undefined, 's')).toBeNull();
    expect(decodeCursor('', 's')).toBeNull();
  });

  it('returns null for input that is not base64-encoded JSON', () => {
    expect(decodeCursor('not-base64-$$$', 's')).toBeNull();
    expect(decodeCursor(Buffer.from('plain text').toString('base64url'), 's')).toBeNull();
  });

  it('returns null for a payload that is not an object', () => {
    expect(decodeCursor(raw([1, 2]), 's')).toBeNull();
    expect(decodeCursor(raw('a string'), 's')).toBeNull();
  });

  it('rejects an unknown cursor version', () => {
    expect(decodeCursor(raw({ v: 99, s: 's', k: ['a'] }), 's')).toBeNull();
  });

  it('rejects an empty or oversized key list', () => {
    expect(decodeCursor(raw({ v: CURSOR_VERSION, s: 's', k: [] }), 's')).toBeNull();
    expect(decodeCursor(raw({ v: CURSOR_VERSION, s: 's', k: [1, 2, 3, 4, 5] }), 's')).toBeNull();
  });

  it('rejects keys of an unsupported type', () => {
    expect(decodeCursor(raw({ v: CURSOR_VERSION, s: 's', k: [true] }), 's')).toBeNull();
    expect(decodeCursor(raw({ v: CURSOR_VERSION, s: 's', k: [{ nested: 1 }] }), 's')).toBeNull();
  });

  it('rejects an over-long string key', () => {
    expect(decodeCursor(raw({ v: CURSOR_VERSION, s: 's', k: ['x'.repeat(129)] }), 's')).toBeNull();
  });

  it('rejects a non-finite number key', () => {
    // `1e999` is the only way a hostile client can smuggle Infinity through JSON.
    const cursor = Buffer.from('{"v":1,"s":"s","k":[1e999]}', 'utf8').toString('base64url');
    expect(decodeCursor(cursor, 's')).toBeNull();
  });

  it('rejects an absurdly long cursor string before decoding it', () => {
    expect(decodeCursor('a'.repeat(513), 's')).toBeNull();
  });
});

describe('readCursorKeyString / readCursorKeyNumber', () => {
  const payload = decodeCursor(encodeCursor('s', [7, 'gam_b']), 's');

  it('reads a key by index and checks its type', () => {
    expect(readCursorKeyString(payload, 1)).toBe('gam_b');
    expect(readCursorKeyNumber(payload, 0)).toBe(7);
  });

  it('returns null when the index holds the other type or is absent', () => {
    expect(readCursorKeyString(payload, 0)).toBeNull();
    expect(readCursorKeyNumber(payload, 1)).toBeNull();
    expect(readCursorKeyString(payload, 9)).toBeNull();
  });

  it('returns null for a null payload', () => {
    expect(readCursorKeyString(null)).toBeNull();
    expect(readCursorKeyNumber(null)).toBeNull();
  });
});

describe('CURSOR_SCOPES', () => {
  it('gives every collection its own namespace', () => {
    const scopes = Object.values(CURSOR_SCOPES);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});
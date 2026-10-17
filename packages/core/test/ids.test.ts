/**
 * Identifiers are capability tokens as well as primary keys, so the encoding and
 * the validation rule both matter: a guessable or ambiguous id must be
 * impossible to produce and impossible to accept.
 */

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  idPrefixOf,
  idShape,
  ID_PREFIXES,
  isIdOfKind,
  newId,
  randomToken,
  type IdKind,
} from '@moydan/core';

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32, 64]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('round-trips an empty buffer', () => {
    expect(base32Encode(new Uint8Array(0))).toBe('');
    expect(base32Decode('').byteLength).toBe(0);
  });

  it('emits only unambiguous glyphs', () => {
    const encoded = base32Encode(new Uint8Array(64).map((_, index) => index * 4));
    expect(encoded).toMatch(/^[0-9a-hjkmnp-tv-z]*$/);
    expect(encoded).not.toMatch(/[ilou]/);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('abco')).toThrow(/invalid base32/);
    expect(() => base32Decode('abci')).toThrow(/invalid base32/);
  });
});

describe('newId', () => {
  it.each(KINDS)('produces a %s identifier of the right kind', (kind) => {
    const id = newId(kind);
    expect(id.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
    expect(isIdOfKind(id, kind)).toBe(true);
  });

  it('never repeats itself', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('game')));
    expect(ids.size).toBe(500);
  });

  it('produces a body of the documented length', () => {
    const body = newId('user').slice('usr_'.length);
    expect(body.length).toBeGreaterThanOrEqual(8);
    expect(body.length).toBeLessThanOrEqual(48);
  });
});

describe('isIdOfKind', () => {
  it('rejects a body that is too short or too long', () => {
    expect(isIdOfKind('gam_abc', 'game')).toBe(false);
    expect(isIdOfKind(`gam_${'a'.repeat(49)}`, 'game')).toBe(false);
    expect(isIdOfKind(`gam_${'a'.repeat(48)}`, 'game')).toBe(true);
  });

  it('rejects a glyph outside the alphabet', () => {
    for (const character of ['i', 'l', 'o', 'u']) {
      expect(isIdOfKind(`gam_aaaaaaaa${character}`, 'game'), `glyph ${character}`).toBe(false);
    }
    expect(isIdOfKind('gam_0123456789abcdefghjkmnpqrstvwxyz', 'game')).toBe(true);
  });

  it('rejects a mismatched prefix', () => {
    expect(isIdOfKind(newId('game'), 'user')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isIdOfKind(null, 'game')).toBe(false);
    expect(isIdOfKind(42, 'game')).toBe(false);
  });

  it('rejects a prefix with an empty body', () => {
    expect(isIdOfKind('gam_', 'game')).toBe(false);
  });
});

describe('idPrefixOf', () => {
  it('returns the namespace of a well-formed id', () => {
    expect(idPrefixOf('gam_abcdefgh')).toBe('gam');
    expect(idPrefixOf('usr_abcdefgh')).toBe('usr');
  });

  it('returns null when there is no prefix', () => {
    expect(idPrefixOf('abcdefgh')).toBeNull();
    expect(idPrefixOf('_abcdefgh')).toBeNull();
  });
});

describe('idShape', () => {
  it('accepts an identifier produced by the platform', () => {
    expect(idShape.validate(newId('release')).ok).toBe(true);
  });

  it('rejects an ambiguous character anywhere in the body', () => {
    expect(idShape.validate('gam_aaaaaaaaa').ok).toBe(true);
    expect(idShape.validate('gam_illegible1').ok).toBe(false);
    expect(idShape.validate('gam_aaaaaaaao').ok).toBe(false);
  });

  it('rejects an identifier with no prefix or the wrong length', () => {
    expect(idShape.validate('abcdefgh').ok).toBe(false);
    expect(idShape.validate('gam_abc').ok).toBe(false);
  });
});

describe('randomToken', () => {
  it('produces distinct URL-safe tokens of the requested strength', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
  });

  it('grows with the requested byte count', () => {
    expect(randomToken(16).length).toBeLessThan(randomToken(32).length);
  });
});
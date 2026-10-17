/**
 * Prefixed, sortable-ish identifiers.
 *
 * Identifiers are generated with `crypto.getRandomValues` (available in every
 * supported runtime: Node 22+, browsers, workers) so they are safe to expose,
 * never guessable when used as capability tokens, and cheap to validate.
 *
 * Format: `<prefix>_<base32 body>` using an alphabet without ambiguous glyphs.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const ID_PREFIXES = {
  user: 'usr',
  profile: 'prf',
  session: 'ses',
  game: 'gam',
  draft: 'drf',
  version: 'ver',
  blob: 'blb',
  buildJob: 'job',
  release: 'rel',
  remix: 'rmx',
  comment: 'cmt',
  report: 'rpt',
  moderation: 'mod',
  collection: 'col',
  score: 'scr',
  event: 'evt',
  upload: 'upl',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') {
    throw new Error('a cryptographically secure random source is required to generate identifiers');
  }
  cryptoObject.getRandomValues(bytes);
  return bytes;
}

/** Encode bytes using the unambiguous base32 alphabet (no padding). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(value: string): Uint8Array {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const character of value) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`invalid base32 character "${character}"`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

/** Generate a new identifier such as `gam_4k2m9p1q7r3s5t6u`. */
export function newId(kind: IdKind): string {
  const prefix = ID_PREFIXES[kind];
  const body = base32Encode(randomBytes(12));
  return `${prefix}_${body}`;
}

/** Random URL-safe token (used for sessions, signed links, upload grants). */
export function randomToken(bytes = 32): string {
  return base32Encode(randomBytes(bytes));
}

export function idPrefixOf(id: string): string | null {
  const index = id.indexOf('_');
  if (index <= 0) return null;
  return id.slice(0, index);
}

export function isIdOfKind(id: unknown, kind: IdKind): boolean {
  if (typeof id !== 'string') return false;
  const prefix = ID_PREFIXES[kind];
  if (!id.startsWith(`${prefix}_`)) return false;
  const body = id.slice(prefix.length + 1);
  return body.length >= 8 && body.length <= 48 && [...body].every((character) => ALPHABET.includes(character));
}

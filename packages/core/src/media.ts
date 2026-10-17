/**
 * Content type policy.
 *
 * Declared MIME types (from the browser, a zip central directory, or a manifest)
 * are treated as *claims*. For every binary asset we also sniff magic bytes and
 * reject mismatches, so a `.png` that is really an executable payload or a
 * polyglot archive never reaches storage.
 */

import { extensionOf } from './paths.ts';

export const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  // TypeScript sources are served as plain text on purpose: the app origin must
  // never execute creator markup, and a browser cannot run `.ts` anyway.
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.tmx': 'application/xml',
  '.atlas': 'text/plain',
  '.zip': 'application/zip',
  '.map': 'application/json',
};

export const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'text/javascript',
  'text/css',
  'text/html',
  'image/svg+xml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/xml',
]);

/** Content types worth pre-compressing during the build. */
export function isCompressible(contentType: string): boolean {
  return (
    TEXT_CONTENT_TYPES.has(contentType) ||
    contentType.startsWith('font/') ||
    contentType === 'image/x-icon' ||
    contentType === 'application/xml'
  );
}

export function contentTypeForPath(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? 'application/octet-stream';
}

export function isImageType(contentType: string): boolean {
  return contentType.startsWith('image/');
}

export function isAudioType(contentType: string): boolean {
  return contentType.startsWith('audio/');
}

export interface SniffResult {
  /** Detected content type, or null when the payload is not a known binary format. */
  detected: string | null;
  /** True when the payload looks like plain UTF-8 text. */
  text: boolean;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let index = start; index < Math.min(bytes.length, start + length); index += 1) {
    out += String.fromCharCode(bytes[index] as number);
  }
  return out;
}

export function sniffContentType(bytes: Uint8Array): SniffResult {
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { detected: 'image/png', text: false };
  }
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { detected: 'image/jpeg', text: false };
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return { detected: 'image/gif', text: false };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') return { detected: 'image/webp', text: false };
    if (form === 'WAVE') return { detected: 'audio/wav', text: false };
    return { detected: null, text: false };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).trim();
    if (brand === 'avif' || brand === 'avis') return { detected: 'image/avif', text: false };
    return { detected: 'video/mp4', text: false };
  }
  if (bytes.length >= 4 && startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { detected: null, text: false };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') {
    return { detected: 'audio/ogg', text: false };
  }
  if (ascii(bytes, 0, 3) === 'ID3' || startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3])) {
    return { detected: 'audio/mpeg', text: false };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'wOFF') return { detected: 'font/woff', text: false };
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'wOF2') return { detected: 'font/woff2', text: false };
  if (bytes.length >= 4 && startsWith(bytes, [0x00, 0x01, 0x00, 0x00])) {
    return { detected: 'font/ttf', text: false };
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OTTO') return { detected: 'font/otf', text: false };
  if (bytes.length >= 4 && startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { detected: 'application/zip', text: false };
  }
  // Text / markup formats have no magic bytes: decode a prefix and check that it
  // is valid UTF-8 without NUL bytes.
  const sample = bytes.subarray(0, 512);
  let controlCharacters = 0;
  for (const byte of sample) {
    if (byte === 0) return { detected: null, text: false };
    if (byte < 9 || (byte > 13 && byte < 32)) controlCharacters += 1;
  }
  if (controlCharacters / Math.max(1, sample.length) > 0.02) {
    return { detected: null, text: false };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return { detected: null, text: false };
  }
  const prefix = ascii(bytes, 0, 64).trimStart().toLowerCase();
  if (prefix.startsWith('<svg') || prefix.includes('<svg')) return { detected: 'image/svg+xml', text: true };
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) return { detected: 'text/html', text: true };
  if (prefix.startsWith('<?xml')) return { detected: 'application/xml', text: true };
  return { detected: 'text/plain', text: true };
}

export interface ContentTypeCheck {
  ok: boolean;
  reason?:
    | 'declared_extension_mismatch'
    | 'declared_type_mismatch'
    | 'binary_in_text_file'
    | 'unsupported_extension'
    | 'svg_active_content';
  message?: string;
  detected: string | null;
}

const TEXTUAL_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.txt', '.csv', '.xml', '.tmx', '.atlas', '.svg']);

/**
 * Verify that bytes match what their path claims to be.
 *
 * `path` drives the expectation; `declared` (when available) must not contradict
 * either the path or the sniffed payload.
 */
export function verifyFileBytes(path: string, bytes: Uint8Array, declared?: string): ContentTypeCheck {
  const extension = extensionOf(path);
  const basename = path.slice(path.lastIndexOf('/') + 1);
  // A licence file has no extension by convention (`LICENSE`, `LICENSE-MIT`,
  // …). It is required to be plain text and is treated as such here.
  const expected =
    CONTENT_TYPES[extension] ?? (/^licen[cs]e([.-]|$)/i.test(basename) ? 'text/plain' : undefined);
  const sniffed = sniffContentType(bytes);

  if (!expected) {
    return { ok: false, reason: 'unsupported_extension', message: `${extension || 'file'} is not an allowed upload type`, detected: sniffed.detected };
  }
  // Empty files: only allow where emptiness is legitimate.
  if (bytes.length === 0) {
    if (TEXTUAL_EXTENSIONS.has(extension)) return { ok: true, detected: 'text/plain' };
    return { ok: false, reason: 'declared_extension_mismatch', message: 'file is empty', detected: null };
  }

  if (TEXTUAL_EXTENSIONS.has(extension)) {
    if (!sniffed.text || sniffed.detected === 'application/zip') {
      return {
        ok: false,
        reason: 'binary_in_text_file',
        message: `${path} claims to be a text file but does not contain valid UTF-8 text`,
        detected: sniffed.detected,
      };
    }
    if (extension === '.svg') {
      const source = new TextDecoder().decode(bytes.subarray(0, 8192));
      const active = /<\s*(?:script|foreignObject|iframe|animate|set|use[^>]*\bxlink:href\s*=\s*["']?(?:https?:|\/\/))/i.test(source);
      const external = /(?:href|src)\s*=\s*["']\s*(?:javascript:|data:text\/html)/i.test(source);
      if (active || external) {
        return {
          ok: false,
          reason: 'svg_active_content',
          message: 'SVG contains script, animation or foreign content; export a static SVG instead',
          detected: 'image/svg+xml',
        };
      }
    }
    if (declared && declared !== expected && !(declared === 'text/plain' && expected !== 'text/plain')) {
      return { ok: false, reason: 'declared_type_mismatch', message: `declared type ${declared} does not match ${expected}`, detected: sniffed.detected };
    }
    return { ok: true, detected: expected };
  }

  if (sniffed.detected !== expected) {
    return {
      ok: false,
      reason: expected === 'image/svg+xml' ? 'declared_extension_mismatch' : 'declared_type_mismatch',
      message: `content of ${path} does not look like ${expected}`,
      detected: sniffed.detected,
    };
  }
  return { ok: true, detected: sniffed.detected };
}

/** Content-Disposition safe inline serving. */
export function isInlineSafe(contentType: string): boolean {
  return contentType !== 'text/html' && contentType !== 'application/xml' && !contentType.includes('javascript');
}

/**
 * HTTP range requests.
 *
 * Audio and video in an artifact are only playable if the browser can seek, so
 * `/r/...` must answer `Range` with real 206 responses. Only the single-range
 * form is honoured: multi-range requests fall back to a normal 200 response,
 * which the HTTP specification explicitly allows and which is simpler to reason
 * about than multipart/byteranges for content-addressed objects.
 */

export interface ByteRange {
  start: number;
  end: number;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'range'; range: ByteRange }
  | { kind: 'unsatisfiable' };

const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'none' };
  const trimmed = header.trim();
  if (trimmed === '' || trimmed === 'bytes=*') return { kind: 'none' };
  // Comma-separated multi-range requests are intentionally not honoured.
  if (trimmed.includes(',')) return { kind: 'none' };
  const match = BYTE_RANGE.exec(trimmed);
  if (!match) return { kind: 'unsatisfiable' };
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (startText === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'unsatisfiable' };
    if (end >= size) end = size - 1;
  }
  if (size === 0 || start > end || start >= size || start < 0) return { kind: 'unsatisfiable' };
  return { kind: 'range', range: { start, end } };
}

export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`;
}

export function slice(body: Uint8Array, range: ByteRange): Uint8Array {
  return body.subarray(range.start, range.end + 1);
}

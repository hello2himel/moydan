/**
 * Minimal deterministic zip writer.
 *
 * Why not a library: an upload archive has to be byte-identical for an
 * identical project tree, otherwise "did anything change?" cannot be answered by
 * comparing hashes. Popular writers stamp the current time (and encode it in
 * local time), so this writer fixes the DOS timestamp at the zip epoch, sorts
 * entries by path and uses fixed deflate settings.
 *
 * The output is a standard zip (deflate, no data descriptors, UTF-8 name flag)
 * and is read back by the API's `readProjectArchive`, which uses fflate's
 * `unzipSync`.
 */

import { crc32, deflateRawSync } from 'node:zlib';

/** 1980-01-01 00:00:00 in MS-DOS date/time encoding: the zip epoch. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION = 20;
const UTF8_NAME_FLAG = 0x0800;
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

export interface ZipEntry {
  /** Archive-relative path, forward slashes. */
  path: string;
  bytes: Uint8Array;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export function createDeterministicZip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const encoder = new TextEncoder();

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  for (const entry of sorted) {
    const name = encoder.encode(entry.path);
    const compressed = new Uint8Array(deflateRawSync(entry.bytes, { level: 9 }));
    const checksum = crc32(entry.bytes) >>> 0;

    const local = new Uint8Array(LOCAL_HEADER_SIZE + name.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, LOCAL_HEADER_SIGNATURE);
    u16(localView, 4, VERSION);
    u16(localView, 6, UTF8_NAME_FLAG);
    u16(localView, 8, METHOD_DEFLATE);
    u16(localView, 10, DOS_TIME);
    u16(localView, 12, DOS_DATE);
    u32(localView, 14, checksum);
    u32(localView, 18, compressed.byteLength);
    u32(localView, 22, entry.bytes.byteLength);
    u16(localView, 26, name.length);
    u16(localView, 28, 0);
    local.set(name, LOCAL_HEADER_SIZE);

    const directory = new Uint8Array(CENTRAL_HEADER_SIZE + name.length);
    const directoryView = new DataView(directory.buffer);
    u32(directoryView, 0, CENTRAL_HEADER_SIGNATURE);
    u16(directoryView, 4, VERSION);
    u16(directoryView, 6, VERSION);
    u16(directoryView, 8, UTF8_NAME_FLAG);
    u16(directoryView, 10, METHOD_DEFLATE);
    u16(directoryView, 12, DOS_TIME);
    u16(directoryView, 14, DOS_DATE);
    u32(directoryView, 16, checksum);
    u32(directoryView, 20, compressed.byteLength);
    u32(directoryView, 24, entry.bytes.byteLength);
    u16(directoryView, 28, name.length);
    u16(directoryView, 30, 0);
    u16(directoryView, 32, 0);
    u16(directoryView, 34, 0);
    u16(directoryView, 36, 0);
    u32(directoryView, 38, 0);
    u32(directoryView, 42, offset);
    directory.set(name, CENTRAL_HEADER_SIZE);

    parts.push(local, compressed);
    central.push(directory);
    offset += local.byteLength + compressed.byteLength;
    total += 1;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
  const endView = new DataView(end.buffer);
  u32(endView, 0, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, total);
  u16(endView, 10, total);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);
  u16(endView, 20, 0);

  const chunks = [...parts, ...central, end];
  const archive = new Uint8Array(offset + centralSize + END_OF_CENTRAL_DIRECTORY_SIZE);
  let cursor = 0;
  for (const chunk of chunks) {
    archive.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return archive;
}

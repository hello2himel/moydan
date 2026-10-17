#!/usr/bin/env node
/**
 * Generate the launcher icons used by the Android shell and the desktop bundle.
 *
 * The icons are drawn here (a rounded tile with the Moydan "play" mark) so the
 * repository stays free of opaque binary blobs that nobody can review: run
 * `node scripts/generate-icons.mjs` to regenerate them.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BACKGROUND = [11, 11, 16];
const ACCENT = [124, 92, 255];
const SECONDARY = [64, 224, 208];

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {(x:number,y:number,size:number)=>[number,number,number]} shader */
function png(size, shader) {
  // RGBA (colour type 6): Tauri's icon loader and several desktop environments
  // reject truecolour-only PNGs.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = shader(x, y, size);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded square with a centred play triangle and a small secondary dot. */
function iconShader(x, y, size) {
  const u = x / size;
  const v = y / size;
  const radius = 0.22;
  const dx = Math.max(radius - u, u - (1 - radius), 0);
  const dy = Math.max(radius - v, v - (1 - radius), 0);
  if (Math.hypot(dx, dy) > radius) return BACKGROUND;

  // Play triangle.
  const tx = u - 0.44;
  const ty = v - 0.5;
  const inTriangle = tx >= 0 && Math.abs(ty) <= (0.2 - tx * 1.1) * 0.85 && tx <= 0.34;
  // Accent ring.
  const ring = Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.34) < 0.035;
  if (inTriangle) return ACCENT;
  if (ring) return [ACCENT[0] * 0.75, ACCENT[1] * 0.75, ACCENT[2] * 0.75];
  // Secondary dot, bottom right.
  if (Math.hypot(u - 0.76, v - 0.76) < 0.07) return SECONDARY;
  return BACKGROUND;
}

/** Minimal ICO container holding PNG images (supported by every Windows version). */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size, iconShader) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  console.log(`wrote ${path.replace(`${ROOT}/`, '')} (${buffer.length} bytes)`);
}

for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const size = sizes[density];
  write(join(ROOT, 'apps/android/app/src/main/res/mipmap-' + density, 'ic_launcher.png'), png(size, iconShader));
  write(
    join(ROOT, 'apps/android/app/src/main/res/mipmap-' + density, 'ic_launcher_round.png'),
    png(size, iconShader),
  );
}

// Desktop icons (Linux/Windows builds).
for (const size of [256, 512, 1024]) {
  write(join(ROOT, 'packaging/icons', `moydan-${size}.png`), png(size, iconShader));
}

// Tauri requires a specific icon set for bundling.
for (const size of [32, 128, 256, 512]) {
  write(join(ROOT, 'apps/desktop/src-tauri/icons', `${size}x${size}.png`), png(size, iconShader));
}
write(join(ROOT, 'apps/desktop/src-tauri/icons', '128x128@2x.png'), png(256, iconShader));
write(join(ROOT, 'apps/desktop/src-tauri/icons', 'icon.png'), png(512, iconShader));
write(join(ROOT, 'apps/desktop/src-tauri/icons', 'Square150x150Logo.png'), png(150, iconShader));
write(join(ROOT, 'apps/desktop/src-tauri/icons', 'StoreLogo.png'), png(50, iconShader));
write(join(ROOT, 'apps/desktop/src-tauri/icons', 'icon.ico'), ico([16, 32, 48, 64, 128, 256]));

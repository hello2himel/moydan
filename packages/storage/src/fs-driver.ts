/**
 * Filesystem storage driver.
 *
 * Development and test adapter. Every path is resolved inside a single root and
 * verified with the shared path policy, so a bad key can never escape the root.
 * Writes are atomic (temp file + rename) so a crashed process cannot leave a
 * partially written blob that later fails an integrity check.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveWithinRoot } from '@moydan/core';
import { assertSafeKey, type ListedObject, type ObjectHead, type PutOptions, type StorageDriver, type StoredObject } from './driver.ts';

export class FsStorageDriver implements StorageDriver {
  readonly kind = 'fs' as const;
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    return resolveWithinRoot(this.root, key);
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<{ etag: string | null }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(temporary, body);
    await rename(temporary, target);
    await writeFile(`${target}.meta.json`, JSON.stringify({ contentType: options.contentType, cacheControl: options.cacheControl ?? null }));
    return { etag: createHash('sha256').update(body).digest('hex') };
  }

  async get(key: string): Promise<StoredObject | null> {
    const target = this.pathFor(key);
    try {
      const body = new Uint8Array(await readFile(target));
      const meta = await this.readMeta(target);
      return { body, contentType: meta.contentType ?? 'application/octet-stream', size: body.byteLength };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const target = this.pathFor(key);
    try {
      const stats = await stat(target);
      const meta = await this.readMeta(target);
      return { size: stats.size, contentType: meta.contentType ?? null, etag: null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    await rm(target, { force: true });
    await rm(`${target}.meta.json`, { force: true });
  }

  async deleteMany(keys: readonly string[]): Promise<{ deleted: number; failed: string[] }> {
    let deleted = 0;
    const failed: string[] = [];
    for (const key of keys) {
      try {
        await this.delete(key);
        deleted += 1;
      } catch {
        failed.push(key);
      }
    }
    return { deleted, failed };
  }

  async list(prefix: string, options: { limit?: number } = {}): Promise<ListedObject[]> {
    const limit = options.limit ?? 10_000;
    const out: ListedObject[] = [];
    const base = prefix ? resolveWithinRoot(this.root, prefix.replace(/\/$/, '')) : this.root;
    const walk = async (directory: string): Promise<void> => {
      if (out.length >= limit) return;
      let entries;
      try {
        entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      for (const entry of entries) {
        if (out.length >= limit) return;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (entry.name.endsWith('.meta.json') || entry.name.includes('.tmp-')) continue;
        const relative = full.slice(this.root.length + 1);
        const stats = await stat(full);
        out.push({ key: relative, size: stats.size });
      }
    };
    await walk(base);
    return out;
  }

  private async readMeta(target: string): Promise<{ contentType?: string; cacheControl?: string | null }> {
    try {
      return JSON.parse(await readFile(`${target}.meta.json`, 'utf8')) as { contentType?: string };
    } catch {
      return {};
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

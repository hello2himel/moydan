/**
 * S3-compatible storage driver.
 *
 * Implements AWS Signature Version 4 directly against `fetch` (Node 22+ has a
 * global fetch), so the platform does not depend on any cloud SDK and the exact
 * signing behaviour is testable against a local S3-compatible service
 * (SeaweedFS/MinIO in the integration test suite).
 *
 * Supported operations: PUT, GET, HEAD, DELETE, ListObjectsV2 (with
 * continuation tokens). No bucket administration: buckets must be provisioned
 * out of band, which keeps the platform's credentials minimal.
 */

import { createHash, createHmac } from 'node:crypto';
import { assertSafeKey, type ListedObject, type ObjectHead, type PutOptions, type StorageDriver, type StoredObject } from './driver.ts';

export interface S3DriverConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Test hook: override fetch. */
  fetchImpl?: typeof fetch;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const SERVICE = 's3';

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key] ?? '')}`)
    .join('&');
}

function amzDate(date: Date): { long: string; short: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long: iso, short: iso.slice(0, 8) };
}

export class S3StorageDriver implements StorageDriver {
  readonly kind = 's3' as const;
  private config: S3DriverConfig;
  private fetchImpl: typeof fetch;

  constructor(config: S3DriverConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private objectPath(key: string): string {
    assertSafeKey(key);
    if (this.config.forcePathStyle) {
      return `/${this.config.bucket}/${key}`;
    }
    const url = new URL(this.config.endpoint);
    return `${url.pathname.replace(/\/$/, '')}/${key}`;
  }

  private hostHeader(): string {
    const url = new URL(this.config.endpoint);
    if (this.config.forcePathStyle) return url.host;
    return `${this.config.bucket}.${url.host}`;
  }

  private baseUrl(): string {
    const url = new URL(this.config.endpoint);
    url.pathname = '';
    url.search = '';
    if (this.config.forcePathStyle) return url.toString().replace(/\/$/, '');
    return `${url.protocol}//${this.config.bucket}.${url.host}`;
  }

  private async sign(options: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    payloadHash: string;
  }): Promise<Record<string, string>> {
    const date = new Date();
    const { long, short } = amzDate(date);
    const query = options.query ?? {};
    const host = this.hostHeader();
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': options.payloadHash,
      'x-amz-date': long,
      ...options.headers,
    };
    const canonicalHeaderKeys = Object.keys(headers)
      .map((key) => key.toLowerCase())
      .sort();
    const canonicalHeaders = canonicalHeaderKeys
      .map((key) => `${key}:${String(headers[Object.keys(headers).find((candidate) => candidate.toLowerCase() === key) ?? key]).trim().replace(/\s+/g, ' ')}\n`)
      .join('');
    const signedHeaders = canonicalHeaderKeys.join(';');
    const canonicalRequest = [
      options.method,
      canonicalUri(options.path),
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaders,
      options.payloadHash,
    ].join('\n');
    const scope = `${short}/${this.config.region}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, short), this.config.region), SERVICE), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'host') continue;
      out[key] = value;
    }
    return out;
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const base = this.baseUrl();
    const search = canonicalQuery(query);
    return `${base}${canonicalUri(path)}${search ? `?${search}` : ''}`;
  }

  private async request(options: {
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
    key?: string;
    query?: Record<string, string>;
    body?: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<Response> {
    const path = options.key ? this.objectPath(options.key) : this.config.forcePathStyle ? `/${this.config.bucket}` : '/';
    const payloadHash = options.body ? sha256Hex(options.body) : EMPTY_SHA256;
    const signed = await this.sign({
      method: options.method,
      path,
      query: options.query,
      headers: options.headers,
      payloadHash,
    });
    const response = await this.fetchImpl(this.url(path, options.query), {
      method: options.method,
      headers: signed,
      body: options.body ? Buffer.from(options.body) : undefined,
    });
    return response;
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = { 'content-type': options.contentType };
    if (options.cacheControl) headers['cache-control'] = options.cacheControl;
    const response = await this.request({ method: 'PUT', key, body, headers });
    if (!response.ok) {
      throw new Error(`s3 put failed for ${key}: ${response.status} ${await safeText(response)}`);
    }
    return { etag: response.headers.get('etag') };
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.request({ method: 'GET', key });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`s3 get failed for ${key}: ${response.status} ${await safeText(response)}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      body: buffer,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      size: buffer.byteLength,
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const response = await this.request({ method: 'HEAD', key });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`s3 head failed for ${key}: ${response.status}`);
    }
    const length = response.headers.get('content-length');
    return {
      size: length ? Number(length) : 0,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request({ method: 'DELETE', key });
    if (!response.ok && response.status !== 404) {
      throw new Error(`s3 delete failed for ${key}: ${response.status}`);
    }
  }

  async deleteMany(keys: readonly string[]): Promise<{ deleted: number; failed: string[] }> {
    // Sequential deletes keep the implementation small and avoid a large body;
    // GC is a background operation and does not need to be fast.
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
    const limit = options.limit ?? 5000;
    const out: ListedObject[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = {
        'list-type': '2',
        'max-keys': '1000',
        prefix,
      };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const response = await this.request({ method: 'GET', query });
      if (!response.ok) {
        throw new Error(`s3 list failed for prefix ${prefix}: ${response.status} ${await safeText(response)}`);
      }
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = match[1] ?? '';
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
        if (!key) continue;
        out.push({ key: decodeXml(key), size: size ? Number(size) : 0 });
        if (out.length >= limit) return out;
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      continuationToken = truncated ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : null;
      if (continuationToken === '') continuationToken = null;
    } while (continuationToken);
    return out;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Internal build protocol (build workers and the game content origin).
 *
 * This surface is *not* part of the user-facing API: every request must carry
 * `Authorization: Bearer <WORKER_JOB_SECRET>`, compared in constant time, and a
 * session cookie is never accepted here. A worker therefore cannot be
 * impersonated with a stolen viewer session, and a viewer cannot drive a build.
 *
 * The artifact payloads are base64 because the body must stay JSON: decoding is
 * strict (re-encoded bytes must match) so a truncated or smuggled payload is
 * rejected instead of being silently truncated into storage.
 */

import type { FastifyInstance } from 'fastify';
import { contentTypeForPath, errors, schema, sha256Shape, type Limits } from '@moydan/core';
import { parseWith, type ApiDeps } from './context.ts';
import { constantTimeEqual } from '../lib/password.ts';
import { buildJobDto } from './projects.ts';
import { type ArtifactManifest } from '../services/catalog.ts';
import {
  appendArtifact,
  claimBuildJob,
  failBuild,
  finishBuild,
  heartbeatBuildJob,
  limitsSummary,
  resolvePreviewGrant,
} from '../services/publish.ts';
import { listVersionFiles, manifestOfVersion } from '../services/projects.ts';

/** Base64 payloads are bounded by the largest artifact the platform accepts. */
const MAX_ARTIFACT_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_ARTIFACT_UPLOAD_BYTES / 3);

const claimShape = schema.object({ workerId: schema.string({ minLength: 1, maxLength: 120 }) });
const leaseShape = schema.object({ workerId: schema.string({ minLength: 1, maxLength: 120 }) });
const artifactShape = schema.object({
  workerId: schema.string({ minLength: 1, maxLength: 120 }),
  path: schema.string({ minLength: 3, maxLength: 160 }),
  contentType: schema.string({ minLength: 3, maxLength: 120 }).optional(),
  entry: schema.boolean().optional(),
  contentBase64: schema.string({ minLength: 1, maxLength: MAX_BASE64_CHARS }),
});
const artifactManifestShape = schema.object({
  version: schema.number({ min: 1, max: 1_000, integer: true }),
  entry: schema.string({ minLength: 3, maxLength: 160 }),
  files: schema.array(
    schema.object({
      path: schema.string({ minLength: 3, maxLength: 160 }),
      size: schema.number({ min: 0, integer: true }),
      contentType: schema.string({ minLength: 3, maxLength: 120 }),
      sha256: sha256Shape,
      encodings: schema.array(schema.string({ maxLength: 8 })).optional(),
    }),
    { maxLength: 512 },
  ),
  totalBytes: schema.number({ min: 0, integer: true }),
  firstPlayableBytes: schema.number({ min: 0, integer: true }),
});
const finishShape = schema.object({
  workerId: schema.string({ minLength: 1, maxLength: 120 }),
  manifest: artifactManifestShape,
  log: schema.string({ maxLength: 64 * 1024 }).optional(),
});
const failShape = schema.object({
  workerId: schema.string({ minLength: 1, maxLength: 120 }),
  code: schema.string({ minLength: 1, maxLength: 64 }),
  message: schema.string({ minLength: 1, maxLength: 500 }),
  diagnostics: schema
    .array(
      schema.object({
        code: schema.string({ minLength: 1, maxLength: 64 }),
        message: schema.string({ minLength: 1, maxLength: 300 }),
        path: schema.string({ maxLength: 160 }).optional(),
      }),
      { maxLength: 100 },
    )
    .optional(),
  log: schema.string({ maxLength: 64 * 1024 }).optional(),
});

/** Strict base64: the decoded bytes must re-encode to the exact same text. */
function decodeBase64Strict(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw errors.invalidRequest('contentBase64 is not valid base64.', { field: 'contentBase64' });
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.byteLength === 0) throw errors.invalidRequest('contentBase64 decodes to an empty payload.');
  if (decoded.toString('base64') !== normalized) {
    throw errors.invalidRequest('contentBase64 is not canonically encoded.', { field: 'contentBase64' });
  }
  return new Uint8Array(decoded);
}

function publishDeps(deps: ApiDeps) {
  return {
    db: deps.db,
    blobs: deps.blobs,
    limits: deps.config.limits as Limits,
    repoRoot: deps.config.repoRoot,
    config: deps.config,
  };
}

export function internalRoutes(deps: ApiDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * Build protocol routes require the worker secret.
     *
     * The preview-grant lookup is deliberately exempt: it is called by the game
     * content origin, which must never hold a build or session credential, and the
     * grant token in the query string *is* the authorisation. An invalid or
     * expired token is indistinguishable from a missing one.
     */
    const requiresWorkerCredentials = (url: string): boolean => !url.startsWith('/api/internal/preview-grants');

    app.addHook('onRequest', async (request) => {
      if (!requiresWorkerCredentials(request.url)) return;
      const header = String(request.headers.authorization ?? '');
      const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      if (!presented || !constantTimeEqual(presented, deps.config.workerJobSecret)) {
        throw errors.forbidden('Invalid build worker credentials.');
      }
    });

    app.post('/internal/builds/claim', async (request, reply) => {
      const input = parseWith(claimShape, request.body);
      const claimed = claimBuildJob(publishDeps(deps), input.workerId);
      if (!claimed) return reply.status(204).send();
      const files = listVersionFiles(deps.db, claimed.version.id).map((file) => ({
        path: file.path,
        blobSha: file.blob_sha,
        size: file.size_bytes,
        contentType: file.content_type,
        role: file.role,
      }));
      return {
        job: buildJobDto(claimed.job, { includeLog: false }),
        version: {
          id: claimed.version.id,
          gameId: claimed.version.game_id,
          sequence: claimed.version.sequence,
          treeHash: claimed.version.tree_hash,
          licenseSpdx: claimed.version.license_spdx,
          fileCount: claimed.version.file_count,
          totalBytes: claimed.version.total_bytes,
        },
        releaseId: claimed.releaseId,
        manifest: manifestOfVersion(claimed.version),
        files,
        limits: limitsSummary(deps.config.limits),
      };
    });

    app.post<{ Params: { jobId: string } }>('/internal/builds/:jobId/heartbeat', async (request) => {
      const input = parseWith(leaseShape, request.body);
      return heartbeatBuildJob(publishDeps(deps), String(request.params.jobId), input.workerId);
    });

    app.post<{ Params: { jobId: string } }>('/internal/builds/:jobId/artifacts', async (request) => {
      const input = parseWith(artifactShape, request.body);
      const content = decodeBase64Strict(input.contentBase64);
      return appendArtifact(publishDeps(deps), String(request.params.jobId), input.workerId, {
        path: input.path,
        content,
        // A worker may suggest a type, but the path is authoritative: an unknown
        // path falls back to the platform's own mapping.
        contentType: input.contentType ?? contentTypeForPath(input.path),
        entry: input.entry ?? false,
      });
    });

    app.post<{ Params: { jobId: string } }>('/internal/builds/:jobId/finish', async (request) => {
      const input = parseWith(finishShape, request.body);
      const manifest: ArtifactManifest = {
        version: input.manifest.version,
        entry: input.manifest.entry,
        files: input.manifest.files.map((file) => ({
          path: file.path,
          size: file.size,
          contentType: file.contentType,
          sha256: file.sha256,
          ...(file.encodings ? { encodings: file.encodings } : {}),
        })),
        totalBytes: input.manifest.totalBytes,
        firstPlayableBytes: input.manifest.firstPlayableBytes,
      };
      return finishBuild(publishDeps(deps), String(request.params.jobId), input.workerId, {
        manifest,
        log: input.log ?? '',
      });
    });

    app.post<{ Params: { jobId: string } }>('/internal/builds/:jobId/fail', async (request) => {
      const input = parseWith(failShape, request.body);
      failBuild(publishDeps(deps), String(request.params.jobId), input.workerId, {
        code: input.code,
        message: input.message,
        diagnostics: input.diagnostics ?? [],
        log: input.log ?? '',
      });
      return { ok: true };
    });

    app.get<{ Params: { releaseId: string } }>('/internal/preview-grants/:releaseId', async (request) => {
      const query = (request.query ?? {}) as { token?: unknown };
      const token = typeof query.token === 'string' ? query.token : '';
      // An invalid or expired grant is indistinguishable from a missing one:
      // the game origin must not learn whether a token ever existed.
      const grant = token ? resolvePreviewGrant(deps.db, String(request.params.releaseId), token) : null;
      if (!grant) throw errors.forbidden('This preview link is invalid or has expired.');
      return grant;
    });
  };
}
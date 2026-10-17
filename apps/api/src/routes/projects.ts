/**
 * Creator project lifecycle: draft files, import/export, versions, builds,
 * publication and remixing.
 *
 * Every route is owner scoped (`assertGameOwner` answers 404, not 403, so a
 * stranger cannot enumerate private drafts) and every file write goes through
 * the project service, which is where path policy, digest verification and
 * quota accounting live. Content types are derived from the project path and
 * never from a client header: an upload cannot claim to be a zip or an image
 * just by saying so.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  applyRemixParameters,
  checkPathSafety,
  contentTypeForPath,
  errors,
  hexColorShape,
  isAppError,
  isKnownLicense,
  licensePolicy,
  MANIFEST_FILE_NAME,
  safeJsonParse,
  schema,
  slugShape,
  TEXT_CONTENT_TYPES,
  type BuildJob,
  type DraftState,
  type GameManifest,
  type ProjectFile,
  type ReleaseDetail,
} from '@moydan/core';
import { previewAssetUrl } from '../config.ts';
import { nowIso } from '../db/client.ts';
import { requireUser, parseWith, type ApiDeps } from './context.ts';
import { buildProjectArchive, readProjectArchive } from '../services/archive.ts';
import {
  artifactManifestOf,
  canViewGame,
  currentPublicRelease,
  findRelease,
  loadGameCard,
  manifestOfGame,
  releaseSummary,
  type ReleaseRow,
} from '../services/catalog.ts';
import {
  createPreviewGrant,
  findBuildJob,
  listBuildJobs,
  parseDiagnostics,
  publishRelease,
  republishGame,
  startBuild,
  unpublishGame,
  withdrawRelease,
  type BuildJobRow,
  type PublishDeps,
} from '../services/publish.ts';
import {
  assertGameOwner,
  createGame,
  deleteDraftFile,
  draftUsage,
  findGameRow,
  getDraft,
  getVersion,
  licenseIssuesOf,
  listDraftFiles,
  listVersionFiles,
  listVersions,
  putDraftFile,
  readDraftFile,
  renameDraftFile,
  validateDraft,
  type DraftFileRow,
  type GameRow,
  type ProjectDeps,
  type SourceVersionRow,
} from '../services/projects.ts';
import { remixCapabilities, remixGame } from '../services/remix.ts';
import { readTemplateFiles, templateExists } from '../services/templates.ts';

// --- Request shapes ----------------------------------------------------------

const createGameShape = schema.object({
  title: schema.string({ minLength: 1, maxLength: 60 }),
  slug: slugShape,
  description: schema.string({ minLength: 1, maxLength: 280 }),
  licenseSpdx: schema.string({ minLength: 2, maxLength: 64 }),
  template: schema.string({ minLength: 1, maxLength: 64 }),
});
const patchGameShape = schema.object({
  title: schema.string({ minLength: 1, maxLength: 60 }).optional(),
  description: schema.string({ minLength: 1, maxLength: 280 }).optional(),
  accentColor: hexColorShape.optional(),
});
const buildShape = schema.object({ note: schema.string({ maxLength: 200 }).optional() });
const publishShape = schema.object({ releaseId: schema.string({ minLength: 3, maxLength: 64 }) });
const withdrawShape = schema.object({ reason: schema.string({ minLength: 3, maxLength: 200 }) });
const renameShape = schema.object({
  from: schema.string({ minLength: 1, maxLength: 160 }),
  to: schema.string({ minLength: 1, maxLength: 160 }),
});
const remixShape = schema.object({
  mode: schema.enum(['source', 'parameters'] as const),
  title: schema.string({ minLength: 1, maxLength: 60 }).optional(),
  slug: slugShape.optional(),
  params: schema.record(schema.union<number | boolean | string>(schema.number(), schema.boolean(), schema.string())).optional(),
  childLicenseSpdx: schema.string({ minLength: 2, maxLength: 64 }).optional(),
});

type DraftFileParams = { gameId: string; '*': string };

// --- Helpers -----------------------------------------------------------------

function projectDeps(deps: ApiDeps): ProjectDeps {
  return { db: deps.db, blobs: deps.blobs, limits: deps.config.limits, repoRoot: deps.config.repoRoot };
}

function publishDeps(deps: ApiDeps): PublishDeps {
  return { ...projectDeps(deps), config: deps.config };
}

/** Resolve the caller as the owner of `gameId`; 404 for anybody else. */
function ownedGame(deps: ApiDeps, request: FastifyRequest, gameId: string): GameRow {
  const viewer = requireUser(request);
  return assertGameOwner(deps.db, gameId, viewer.id, viewer.role);
}

/**
 * Uploads arrive as raw bytes. Anything the platform parsed into a string is
 * encoded as UTF-8 here; the content type itself is always taken from the path.
 */
function rawBytes(body: unknown, what: string): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  throw errors.invalidRequest(`Send ${what} as a raw request body.`, { contentType: 'application/octet-stream' });
}

function draftPath(request: FastifyRequest<{ Params: DraftFileParams }>): string {
  const path = String(request.params['*'] ?? '');
  if (checkPathSafety(path)) throw errors.notFound('File not found.');
  return path;
}

function projectFileOf(row: DraftFileRow): ProjectFile {
  return {
    path: row.path,
    size: row.size_bytes,
    contentType: row.content_type || contentTypeForPath(row.path),
    role: row.role,
    sha256: row.blob_sha,
    updatedAt: row.updated_at,
  };
}

export interface SourceVersionSummary {
  id: string;
  gameId: string;
  sequence: number;
  kind: 'snapshot' | 'release';
  treeHash: string;
  licenseSpdx: string;
  fileCount: number;
  totalBytes: number;
  note: string;
  parentVersionId: string | null;
  createdAt: string;
  releaseId: string | null;
}

function versionSummary(deps: ApiDeps, version: SourceVersionRow): SourceVersionSummary {
  const release = deps.db.get<{ id: string }>('SELECT id FROM releases WHERE version_id = ? LIMIT 1', [version.id]);
  return {
    id: version.id,
    gameId: version.game_id,
    sequence: version.sequence,
    kind: version.kind,
    treeHash: version.tree_hash,
    licenseSpdx: version.license_spdx,
    fileCount: version.file_count,
    totalBytes: version.total_bytes,
    note: version.note,
    parentVersionId: version.parent_version_id,
    createdAt: version.created_at,
    releaseId: release?.id ?? null,
  };
}

/** The single projection of a build job; `log` is only ever included for its owner. */
export function buildJobDto(job: BuildJobRow, options: { includeLog: boolean }): BuildJob {
  return {
    id: job.id,
    gameId: job.game_id,
    versionId: job.version_id,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    diagnostics: parseDiagnostics(job.diagnostics_json),
    releaseId: job.release_id,
    toolchain: job.toolchain,
    log: options.includeLog ? job.log_text : null,
  };
}

function releaseDetailOf(deps: ApiDeps, release: ReleaseRow): ReleaseDetail {
  const artifactManifest = artifactManifestOf(release);
  if (!artifactManifest) throw errors.internal('Release artifact manifest is unreadable.');
  const job = deps.db.get<{ id: string }>('SELECT id FROM build_jobs WHERE release_id = ? LIMIT 1', [release.id]);
  return {
    ...releaseSummary(deps.config, release),
    artifactManifest,
    buildJobId: job?.id ?? null,
    versionId: release.version_id,
  };
}

async function draftStateOf(deps: ApiDeps, game: GameRow): Promise<DraftState> {
  const draft = getDraft(deps.db, game.id);
  const files = listDraftFiles(deps.db, game.id);
  const validation = await validateDraft(projectDeps(deps), game.id);
  const licence = licenseIssuesOf(validation.manifestRaw);
  const manifest = validation.manifest;
  return {
    gameId: game.id,
    slug: game.slug,
    title: game.title,
    description: game.description,
    revision: draft.revision,
    updatedAt: draft.updated_at,
    files: files.map(projectFileOf),
    manifest: validation.manifestRaw,
    validation: {
      ok: validation.ok,
      issues: validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    },
    license: {
      spdx: manifest?.license.spdx ?? game.license_spdx,
      declaration: licence.declaration ?? null,
      issues: licence.issues.map((issue) => ({ path: issue.path, message: issue.message, severity: issue.severity })),
    },
    capabilities: {
      remixModes: manifest?.remix?.modes ?? [],
      parameters: manifest?.remix?.parameters ?? [],
      engine: manifest?.engine ? { name: manifest.engine.name, version: manifest.engine.version } : null,
      orientation: manifest?.orientation ?? null,
    },
    usage: draftUsage(deps.db, game.id),
  };
}

/**
 * A template's `game.json` is copied into the new draft, so its licence
 * declaration is the one the project starts with.
 *
 * Returns `null` when the template ships no readable manifest: the copy step
 * then becomes `createGame`'s problem and reports the real error, rather than
 * this pre-check masking it behind a licence message.
 */
function templateLicense(deps: ApiDeps, template: string): string | null {
  try {
    const manifestFile = readTemplateFiles(deps.config.repoRoot, template).find(
      (file) => file.path === MANIFEST_FILE_NAME,
    );
    if (!manifestFile) return null;
    return safeJsonParse<GameManifest>(new TextDecoder().decode(manifestFile.content))?.license?.spdx ?? null;
  } catch {
    return null;
  }
}

/**
 * `readProjectArchive` only rejects *policy* problems with an AppError; bytes
 * that are not a zip at all make the decompressor throw. An unreadable upload
 * is the caller's mistake, so it is reported as a validation failure rather
 * than as a server error.
 */
function parseArchive(bytes: Uint8Array, deps: ApiDeps): ReturnType<typeof readProjectArchive> {
  try {
    return readProjectArchive(bytes, { limits: deps.config.limits, allowTests: true });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw errors.validationFailed('The uploaded file is not a readable zip archive.');
  }
}

export function projectRoutes(deps: ApiDeps) {
  const writeLimit = { max: deps.config.rateLimits.writePerMinute, timeWindow: '1 minute' } as const;
  const uploadLimit = { max: deps.config.rateLimits.uploadPerMinute, timeWindow: '1 minute' } as const;

  return async function register(app: FastifyInstance): Promise<void> {
    // --- Draft reads and writes ---------------------------------------------

    app.get<{ Params: { gameId: string } }>('/games/:gameId/draft', async (request) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      return draftStateOf(deps, game);
    });

    app.get<{ Params: DraftFileParams }>('/games/:gameId/draft/files/*', async (request, reply) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      const path = draftPath(request);
      const row = readDraftFile(projectDeps(deps), game.id, path);
      const object = await deps.blobs.read(row.blob_sha, { verify: false });
      if (!object) throw errors.notFound('File is missing from storage.');
      const stored = row.content_type || contentTypeForPath(path);
      reply.header('x-content-type-options', 'nosniff');
      // Drafts are private and mutable: never cacheable, and text is served as
      // plain text so creator markup can never execute on the app origin.
      reply.header('cache-control', 'private, no-store');
      if (TEXT_CONTENT_TYPES.has(stored)) {
        reply.header('content-type', 'text/plain; charset=utf-8');
      } else {
        reply.header('content-type', stored);
        reply.header('content-disposition', `attachment; filename="${row.path.split('/').pop() ?? 'file'}"`);
      }
      return reply.send(Buffer.from(object.body));
    });

    app.put<{ Params: DraftFileParams }>(
      '/games/:gameId/draft/files/*',
      { config: { rateLimit: uploadLimit } },
      async (request) => {
        const game = ownedGame(deps, request, String(request.params.gameId));
        const path = draftPath(request);
        const content = rawBytes(request.body, `the contents of "${path}"`);
        return projectFileOf(await putDraftFile(projectDeps(deps), { gameId: game.id, path, content }));
      },
    );

    app.delete<{ Params: DraftFileParams }>('/games/:gameId/draft/files/*', async (request) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      deleteDraftFile(projectDeps(deps), game.id, draftPath(request));
      return { deleted: true };
    });

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/draft/files/rename',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const game = ownedGame(deps, request, String(request.params.gameId));
        const input = parseWith(renameShape, request.body);
        renameDraftFile(projectDeps(deps), game.id, input.from, input.to);
        return { from: input.from, to: input.to };
      },
    );

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/draft/import',
      { config: { rateLimit: uploadLimit } },
      async (request) => {
        const game = ownedGame(deps, request, String(request.params.gameId));
        // The whole archive is inspected before a single byte is written, so a
        // hostile or broken zip never leaves a half-imported project behind.
        const preview = parseArchive(
          rawBytes(request.body, 'a zip archive'),
          deps,
        );

        let imported = 0;
        let totalBytes = 0;
        const skipped: string[] = [];
        for (const entry of preview.entries) {
          try {
            await putDraftFile(projectDeps(deps), {
              gameId: game.id,
              path: entry.path,
              content: entry.content,
              role: entry.role,
            });
            imported += 1;
            totalBytes += entry.content.byteLength;
          } catch (error) {
            // Per-file rejections (content sniffing, per-file quota) are counted
            // and logged rather than hidden, so the creator sees what did not land.
            if (!isAppError(error)) throw error;
            skipped.push(entry.path);
          }
        }
        if (skipped.length > 0) {
          deps.logger.warn('project.import.skipped', { gameId: game.id, skipped: skipped.length });
        }
        return { imported, skipped: skipped.length, totalBytes, warnings: preview.warnings };
      },
    );

    app.get<{ Params: { gameId: string } }>('/games/:gameId/draft/export', async (request, reply) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      const contents: { path: string; content: Uint8Array }[] = [];
      for (const file of listDraftFiles(deps.db, game.id)) {
        const object = await deps.blobs.read(file.blob_sha, { verify: false });
        if (!object) throw errors.notFound('File is missing from storage.');
        contents.push({ path: file.path, content: object.body });
      }
      const archive = buildProjectArchive(contents);
      reply.header('content-type', 'application/zip');
      reply.header('content-length', String(archive.byteLength));
      reply.header('content-disposition', `attachment; filename="${game.slug}.zip"`);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'private, no-store');
      return reply.send(Buffer.from(archive));
    });

    app.post<{ Params: { gameId: string } }>('/games/:gameId/draft/validate', async (request) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      const validation = await validateDraft(projectDeps(deps), game.id);
      return {
        ok: validation.ok,
        manifest: validation.manifest,
        issues: validation.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message })),
      };
    });

    // --- Immutable versions ---------------------------------------------------

    app.get<{ Params: { gameId: string } }>('/games/:gameId/versions', async (request) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      const items = listVersions(deps.db, game.id).map((version) => versionSummary(deps, version));
      return { items, nextCursor: null, total: items.length };
    });

    app.get<{ Params: { versionId: string } }>('/versions/:versionId', async (request) => {
      const version = getVersion(deps.db, String(request.params.versionId));
      ownedGame(deps, request, version.game_id);
      return {
        ...versionSummary(deps, version),
        manifest: safeJsonParse<unknown>(version.manifest_json),
        remixParams: version.remix_params_json ? safeJsonParse<unknown>(version.remix_params_json) : null,
        files: listVersionFiles(deps.db, version.id).map(projectFileOf),
      };
    });

    // --- Game creation and metadata ------------------------------------------

    app.post('/games', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const input = parseWith(createGameShape, request.body);

      const policy = licensePolicy(input.licenseSpdx);
      if (!isKnownLicense(input.licenseSpdx) || !policy) {
        throw errors.licenseRejected(`"${input.licenseSpdx}" is not a licence this platform recognises.`, {
          field: 'licenseSpdx',
        });
      }
      if (!policy.appliesToCode) {
        throw errors.licenseRejected(`${policy.name} licenses assets, not game code.`, { field: 'licenseSpdx' });
      }
      if (!templateExists(deps.config.repoRoot, input.template)) {
        throw errors.notFound(`Unknown template "${input.template}".`);
      }
      // The template ships the project's licence declaration; a mismatch would
      // silently overwrite the licence the creator asked for.
      const templateSpdx = templateLicense(deps, input.template);
      if (templateSpdx) {
        const templatePolicy = licensePolicy(templateSpdx);
        if (!isKnownLicense(templateSpdx) || !templatePolicy) {
          throw errors.licenseRejected(`Template "${input.template}" declares an unsupported licence.`, {
            template: input.template,
            declared: templateSpdx,
          });
        }
        if (!templatePolicy.appliesToCode) {
          throw errors.licenseRejected(
            `Template "${input.template}" is licensed ${templatePolicy.name}, which cannot cover game code.`,
            { template: input.template, declared: templateSpdx },
          );
        }
        if (templateSpdx !== input.licenseSpdx) {
          throw errors.licenseRejected(
            `Template "${input.template}" ships ${templatePolicy.name}; publish the new project under the same licence or choose another template.`,
            { template: input.template, declared: templateSpdx, requested: input.licenseSpdx },
          );
        }
      }

      const created = await createGame(projectDeps(deps), {
        ownerId: viewer.id,
        title: input.title,
        slug: input.slug,
        description: input.description,
        licenseSpdx: input.licenseSpdx,
        template: input.template,
      });
      return { game: created.game, draft: created.draft };
    });

    app.patch<{ Params: { gameId: string } }>('/games/:gameId', { config: { rateLimit: writeLimit } }, async (request) => {
      const viewer = requireUser(request);
      const game = ownedGame(deps, request, String(request.params.gameId));
      const input = parseWith(patchGameShape, request.body);
      // `games` is the denormalised projection the feed reads; the next
      // `game.json` upload re-syncs these same fields from the manifest.
      deps.db.run(
        `UPDATE games SET title = COALESCE(?, title), description = COALESCE(?, description),
           accent_color = COALESCE(?, accent_color), updated_at = ? WHERE id = ?`,
        [input.title ?? null, input.description ?? null, input.accentColor ?? null, nowIso(), game.id],
      );
      const refreshed = assertGameOwner(deps.db, game.id, viewer.id, viewer.role);
      return loadGameCard(deps.db, deps.config, refreshed, viewer.id);
    });

    // --- Builds ---------------------------------------------------------------

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/build',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const game = ownedGame(deps, request, String(request.params.gameId));
        const input = parseWith(buildShape, request.body ?? {});
        const started = await startBuild(publishDeps(deps), { game, userId: viewer.id, note: input.note });
        return buildJobDto(started.job, { includeLog: true });
      },
    );

    app.get<{ Params: { gameId: string } }>('/games/:gameId/builds', async (request) => {
      const game = ownedGame(deps, request, String(request.params.gameId));
      const items = listBuildJobs(deps.db, game.id).map((job) => buildJobDto(job, { includeLog: true }));
      return { items, nextCursor: null, total: items.length };
    });

    app.get<{ Params: { jobId: string } }>('/builds/:jobId', async (request) => {
      const job = findBuildJob(deps.db, String(request.params.jobId));
      if (!job) throw errors.notFound('Build job not found.');
      const game = ownedGame(deps, request, job.game_id);
      const viewer = request.user;
      return buildJobDto(job, { includeLog: game.owner_id === viewer?.id || viewer?.role === 'admin' });
    });

    // --- Publication ----------------------------------------------------------

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/publish',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const game = ownedGame(deps, request, String(request.params.gameId));
        const input = parseWith(publishShape, request.body);
        const release = findRelease(deps.db, input.releaseId);
        if (!release || release.game_id !== game.id) throw errors.notFound('Release not found.');
        if (release.status === 'published') throw errors.conflict('This release is already published.');
        if (release.status !== 'ready_for_review') {
          throw errors.conflict(`A release in state "${release.status}" cannot be published yet.`);
        }
        publishRelease(publishDeps(deps), { game, releaseId: release.id, userId: viewer.id });
        const published = findRelease(deps.db, release.id);
        if (!published) throw errors.internal('Release disappeared after publishing.');
        return releaseDetailOf(deps, published);
      },
    );

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/unpublish',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const game = ownedGame(deps, request, String(request.params.gameId));
        unpublishGame(publishDeps(deps), { game, userId: viewer.id });
        return { status: 'unpublished' };
      },
    );

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/republish',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const game = ownedGame(deps, request, String(request.params.gameId));
        republishGame(publishDeps(deps), { game, userId: viewer.id });
        return { status: 'published' };
      },
    );

    app.post<{ Params: { releaseId: string } }>(
      '/releases/:releaseId/withdraw',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const input = parseWith(withdrawShape, request.body);
        const release = findRelease(deps.db, String(request.params.releaseId));
        if (!release) throw errors.notFound('Release not found.');
        const game = assertGameOwner(deps.db, release.game_id, viewer.id, viewer.role);
        withdrawRelease(publishDeps(deps), { game, releaseId: release.id, userId: viewer.id, reason: input.reason });
        return { status: 'withdrawn' };
      },
    );

    app.post<{ Params: { releaseId: string } }>(
      '/releases/:releaseId/preview-grant',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const release = findRelease(deps.db, String(request.params.releaseId));
        if (!release) throw errors.notFound('Release not found.');
        const game = assertGameOwner(deps.db, release.game_id, viewer.id, viewer.role);
        const grant = createPreviewGrant(publishDeps(deps), { game, releaseId: release.id, userId: viewer.id });
        return {
          token: grant.token,
          expiresAt: grant.expiresAt,
          url: previewAssetUrl(deps.config, release.id, grant.token, release.entry_path),
        };
      },
    );

    // --- Remixing -------------------------------------------------------------

    app.post<{ Params: { gameId: string } }>(
      '/games/:gameId/remix',
      { config: { rateLimit: writeLimit } },
      async (request) => {
        const viewer = requireUser(request);
        const input = parseWith(remixShape, request.body);
        const parent = findGameRow(deps.db, String(request.params.gameId));
        if (!parent || !canViewGame(parent, viewer)) throw errors.notFound('Game not found.');

        const capabilities = remixCapabilities(deps.db, parent);
        const manifest = manifestOfGame(deps.db, parent, currentPublicRelease(deps.db, parent));
        if (input.params) {
          const checked = applyRemixParameters(manifest?.remix?.parameters ?? [], input.params);
          if (!checked.ok) {
            throw errors.validationFailed('Those remix parameters are not valid for this game.', {
              issues: checked.issues,
            });
          }
        }
        // Share-alike is enforced here, before any bytes are copied, so the
        // creator gets a licence error rather than an unusable derivative.
        if (input.childLicenseSpdx) {
          if (!isKnownLicense(input.childLicenseSpdx)) {
            throw errors.licenseRejected(`"${input.childLicenseSpdx}" is not a licence this platform recognises.`, {
              allowedLicenses: capabilities.allowedChildLicenses,
            });
          }
          if (capabilities.allowedChildLicenses.length > 0 && !capabilities.allowedChildLicenses.includes(input.childLicenseSpdx)) {
            throw errors.licenseRejected(
              `${parent.license_spdx} derivations must be published under: ${capabilities.allowedChildLicenses.join(', ')}.`,
              { declared: input.childLicenseSpdx, allowedLicenses: capabilities.allowedChildLicenses },
            );
          }
        }

        const result = await remixGame(projectDeps(deps), {
          parentGame: parent,
          viewerId: viewer.id,
          mode: input.mode,
          params: input.params ?? null,
          title: input.title,
          slug: input.slug,
          childLicenseSpdx: input.childLicenseSpdx,
        });
        return { game: result.game, versionId: result.versionId, draft: getDraft(deps.db, result.game.id) };
      },
    );
  };
}
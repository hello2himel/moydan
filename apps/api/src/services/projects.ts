/**
 * Native project storage: identity, drafts, file operations and immutable
 * source versions.
 *
 * Model (see docs/PROJECT-FORMAT.md):
 *
 *   games            stable identity, owner, licence, published pointers
 *   game_drafts      one mutable working copy per game (tree = draft_files)
 *   source_versions  immutable snapshots; publish/remix always reference one
 *
 * All file bytes live in the content-addressed blob store. Editing one file
 * writes one new blob and re-points one row: nothing else is copied, and a remix
 * shares its parent's blobs until a file is actually changed.
 */

import {
  checkPathSafety,
  classifyProjectPath,
  contentTypeForPath,
  errors,
  formatBytes,
  MANIFEST_FILE_NAME,
  newId,
  safeJsonParse,
  stableStringify,
  validateGameManifest,
  validateLicenseDeclaration,
  verifyFileBytes,
  type GameManifest,
  type Limits,
  type ProjectFileRole,
  type ValidationIssue,
} from '@moydan/core';
import type { Db } from '../db/client.ts';
import { nowIso } from '../db/client.ts';
import { sha256Hex, type BlobStore } from '../storage/blobs.ts';
import { assertWithinQuota, refreshUsage } from '../storage/usage.ts';

export interface ProjectDeps {
  db: Db;
  blobs: BlobStore;
  limits: Limits;
  repoRoot: string;
}

export interface GameRow {
  id: string;
  owner_id: string;
  slug: string;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'unpublished' | 'removed' | 'suspended';
  license_spdx: string;
  license_source: string;
  thumbnail_path: string | null;
  accent_color: string | null;
  tags_json: string;
  current_release_id: string | null;
  current_version_id: string | null;
  published_at: string | null;
  removed_at: string | null;
  removal_reason: string | null;
  is_remix: number;
  root_game_id: string | null;
  remix_depth: number;
  created_at: string;
  updated_at: string;
}

export interface DraftRow {
  id: string;
  game_id: string;
  revision: number;
  manifest_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftFileRow {
  draft_id: string;
  path: string;
  blob_sha: string;
  size_bytes: number;
  content_type: string;
  role: ProjectFileRole;
  updated_at: string;
}

export interface SourceVersionRow {
  id: string;
  game_id: string;
  sequence: number;
  kind: 'snapshot' | 'release';
  manifest_json: string;
  manifest_hash: string;
  tree_hash: string;
  license_spdx: string;
  license_notices: string;
  created_by: string | null;
  note: string;
  parent_version_id: string | null;
  remix_params_json: string | null;
  total_bytes: number;
  file_count: number;
  created_at: string;
}

// --- Reads -------------------------------------------------------------------

export function getGame(db: Db, gameId: string): GameRow {
  const row = db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]);
  if (!row) throw errors.notFound('Game not found.');
  return row;
}

export function findGameRow(db: Db, gameId: string): GameRow | null {
  return db.get<GameRow>('SELECT * FROM games WHERE id = ?', [gameId]) ?? null;
}

export function findGameBySlug(db: Db, ownerId: string, slug: string): GameRow | null {
  return db.get<GameRow>('SELECT * FROM games WHERE owner_id = ? AND slug = ?', [ownerId, slug]) ?? null;
}

export function assertGameOwner(db: Db, gameId: string, userId: string | null, role?: string): GameRow {
  const game = findGameRow(db, gameId);
  // Non-owners get 404 so private drafts cannot be enumerated.
  if (!game || (game.owner_id !== userId && role !== 'admin')) throw errors.notFound('Game not found.');
  return game;
}

export function getDraft(db: Db, gameId: string): DraftRow {
  const row = db.get<DraftRow>('SELECT * FROM game_drafts WHERE game_id = ?', [gameId]);
  if (!row) throw errors.notFound('This project has no working draft.');
  return row;
}

export function listDraftFiles(db: Db, gameId: string): DraftFileRow[] {
  return db.all<DraftFileRow>(
    `SELECT df.draft_id, df.path, df.blob_sha, df.size_bytes, df.content_type, df.role, df.updated_at
       FROM draft_files df JOIN game_drafts d ON d.id = df.draft_id
      WHERE d.game_id = ? ORDER BY df.path ASC`,
    [gameId],
  );
}

export function draftUsage(db: Db, gameId: string): { sourceBytes: number; fileCount: number } {
  const row = db.get<{ bytes: number; files: number }>(
    `SELECT COALESCE(SUM(df.size_bytes), 0) AS bytes, COUNT(*) AS files
       FROM draft_files df JOIN game_drafts d ON d.id = df.draft_id WHERE d.game_id = ?`,
    [gameId],
  );
  return { sourceBytes: Number(row?.bytes ?? 0), fileCount: Number(row?.files ?? 0) };
}

export function listVersions(db: Db, gameId: string, limit = 50): SourceVersionRow[] {
  return db.all<SourceVersionRow>('SELECT * FROM source_versions WHERE game_id = ? ORDER BY sequence DESC LIMIT ?', [
    gameId,
    limit,
  ]);
}

export function getVersion(db: Db, versionId: string): SourceVersionRow {
  const row = db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [versionId]);
  if (!row) throw errors.notFound('Source version not found.');
  return row;
}

export function listVersionFiles(db: Db, versionId: string): DraftFileRow[] {
  return db.all<DraftFileRow>(
    `SELECT ? AS draft_id, path, blob_sha, size_bytes, content_type, role, '' AS updated_at
       FROM version_files WHERE version_id = ? ORDER BY path ASC`,
    [versionId, versionId],
  );
}

export function manifestOfVersion(version: SourceVersionRow): GameManifest {
  const parsed = safeJsonParse<GameManifest>(version.manifest_json);
  if (!parsed) throw errors.internal('Stored manifest is unreadable.');
  return parsed;
}

export function computeTreeHash(files: { path: string; blob_sha: string; size_bytes: number }[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.blob_sha}\u0000${file.size_bytes}`)
    .join('\n');
  return sha256Hex(new TextEncoder().encode(canonical));
}

// --- Creation ----------------------------------------------------------------

export interface CreateGameInput {
  ownerId: string;
  title: string;
  slug: string;
  description: string;
  licenseSpdx: string;
  template: string;
  remix?: {
    parentGameId: string;
    parentVersionId: string;
    parentReleaseId: string | null;
    parentFiles: { path: string; blobSha: string; size: number; contentType: string; role: ProjectFileRole }[];
    mode: 'source' | 'parameters';
    rootGameId: string;
    attributionText: string;
    params: Record<string, unknown> | null;
    parentCreatorId: string;
    parentCreatorHandle: string;
    parentTitle: string;
    parentLicenseSpdx: string;
  };
}

/**
 * Create a game from a starter template, or from the file tree of a parent
 * version (source remix). The remix path references the parent's blobs instead of
 * copying bytes; only later edits produce new blobs.
 */
export async function createGame(
  deps: ProjectDeps,
  input: CreateGameInput,
): Promise<{ game: GameRow; draft: DraftRow }> {
  if (findGameBySlug(deps.db, input.ownerId, input.slug)) {
    throw errors.conflict(`You already have a game with the slug "${input.slug}".`, { field: 'slug' });
  }
  assertWithinQuota(deps.db, { userId: input.ownerId, limits: deps.limits });

  let files: { path: string; content: Uint8Array; role: ProjectFileRole; blobSha?: string; contentType?: string }[];
  if (input.remix) {
    files = input.remix.parentFiles.map((file) => ({
      path: file.path,
      content: new Uint8Array(),
      role: file.role,
      blobSha: file.blobSha,
      contentType: file.contentType,
    }));
  } else {
    const { readTemplateFiles } = await import('./templates.ts');
    files = readTemplateFiles(deps.repoRoot, input.template);
  }

  // Resolve the manifest text before opening the transaction: the draft stores
  // a copy so validation does not have to re-read storage on every request.
  let manifestText: string | null = null;
  {
    const manifestFile = files.find((file) => file.path === MANIFEST_FILE_NAME);
    if (manifestFile) {
      if (manifestFile.blobSha) {
        const object = await deps.blobs.read(manifestFile.blobSha);
        manifestText = object ? new TextDecoder().decode(object.body) : null;
      } else {
        manifestText = new TextDecoder().decode(manifestFile.content);
      }
    }
  }

  const timestamp = nowIso();
  const game: GameRow = {
    id: newId('game'),
    owner_id: input.ownerId,
    slug: input.slug,
    title: input.title,
    description: input.description,
    status: 'draft',
    license_spdx: input.licenseSpdx,
    license_source: 'creator-declared',
    thumbnail_path: null,
    accent_color: '#6d5efc',
    tags_json: '[]',
    current_release_id: null,
    current_version_id: null,
    published_at: null,
    removed_at: null,
    removal_reason: null,
    is_remix: input.remix ? 1 : 0,
    root_game_id: input.remix ? input.remix.rootGameId : null,
    remix_depth: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const draft: DraftRow = {
    id: newId('draft'),
    game_id: game.id,
    revision: 1,
    manifest_json: manifestText,
    created_at: timestamp,
    updated_at: timestamp,
  };

  // Upload template bytes (remix files already exist as blobs).
  const prepared: { path: string; role: ProjectFileRole; blobSha: string; size: number; contentType: string }[] = [];
  for (const file of files) {
    if (file.blobSha) {
      prepared.push({
        path: file.path,
        role: file.role,
        blobSha: file.blobSha,
        size: 0, // filled in from the source row below
        contentType: file.contentType ?? contentTypeForPath(file.path),
      });
      continue;
    }
    const contentType = contentTypeForPath(file.path);
    const check = verifyFileBytes(file.path, file.content);
    if (!check.ok) {
      throw errors.validationFailed(`Template file "${file.path}" failed validation: ${check.message}.`, {
        template: input.template,
      });
    }
    const ingest = await deps.blobs.ingest(file.content, { class: 'source', contentType, compress: false });
    prepared.push({ path: file.path, role: file.role, blobSha: ingest.sha256, size: ingest.size, contentType });
  }

  deps.db.transaction(() => {
    deps.db.run(
      `INSERT INTO games (id, owner_id, slug, title, description, status, license_spdx, license_source, thumbnail_path,
         accent_color, tags_json, current_release_id, current_version_id, published_at, removed_at, removal_reason,
         is_remix, root_game_id, remix_depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        game.id,
        game.owner_id,
        game.slug,
        game.title,
        game.description,
        game.status,
        game.license_spdx,
        game.license_source,
        game.thumbnail_path,
        game.accent_color,
        game.tags_json,
        game.current_release_id,
        game.current_version_id,
        game.published_at,
        game.removed_at,
        game.removal_reason,
        game.is_remix,
        game.root_game_id,
        game.remix_depth,
        game.created_at,
        game.updated_at,
      ],
    );
    deps.db.run(
      'INSERT INTO game_drafts (id, game_id, revision, manifest_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [draft.id, draft.game_id, draft.revision, draft.manifest_json, draft.created_at, draft.updated_at],
    );
    deps.db.run('INSERT OR IGNORE INTO game_metrics (game_id, updated_at) VALUES (?, ?)', [game.id, timestamp]);

    for (const file of prepared) {
      const size =
        file.size > 0
          ? file.size
          : Number(
              deps.db.get<{ size_bytes: number }>('SELECT size_bytes FROM blobs WHERE sha256 = ?', [file.blobSha])
                ?.size_bytes ?? 0,
            );
      deps.db.run(
        `INSERT INTO draft_files (draft_id, path, blob_sha, size_bytes, content_type, role, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [draft.id, file.path, file.blobSha, size, file.contentType, file.role, timestamp],
      );
    }
    // The manifest is the source of truth for identity-ish metadata.
    if (manifestText) syncGameFromManifest(deps.db, game.id, new TextEncoder().encode(manifestText));

    if (input.remix) {
      deps.db.run(
        `INSERT INTO remix_relations (id, child_game_id, child_version_id, parent_game_id, parent_version_id,
           parent_release_id, root_game_id, parent_creator_id, parent_creator_handle, parent_title, child_creator_id,
           mode, license_spdx, parent_license_spdx, attribution_text, params_json, shared_blob_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('remix'),
          game.id,
          input.remix.parentVersionId,
          input.remix.parentGameId,
          input.remix.parentVersionId,
          input.remix.parentReleaseId,
          input.remix.rootGameId,
          input.remix.parentCreatorId,
          input.remix.parentCreatorHandle,
          input.remix.parentTitle,
          input.ownerId,
          input.remix.mode,
          input.licenseSpdx,
          input.remix.parentLicenseSpdx,
          input.remix.attributionText,
          input.remix.params ? JSON.stringify(input.remix.params) : null,
          prepared.length,
          timestamp,
        ],
      );
    }
  });

  refreshUsage(deps.db, input.ownerId);
  return { game: getGame(deps.db, game.id), draft: getDraft(deps.db, game.id) };
}

// --- File operations ---------------------------------------------------------

export interface PutDraftFileInput {
  gameId: string;
  path: string;
  content: Uint8Array;
  role?: ProjectFileRole;
  expectedContentType?: string;
}

export async function putDraftFile(deps: ProjectDeps, input: PutDraftFileInput): Promise<DraftFileRow> {
  const problem = checkPathSafety(input.path);
  if (problem) {
    throw errors.validationFailed(`"${input.path}" is not a valid file path: ${problem.message}`, { path: input.path });
  }
  const role = input.role ?? classifyProjectPath(input.path, { allowTests: true });
  if (!role) throw errors.validationFailed(`"${input.path}" is not an allowed project file.`, { path: input.path });

  const check = verifyFileBytes(input.path, input.content, input.expectedContentType);
  if (!check.ok) {
    throw errors.validationFailed(check.message ?? `"${input.path}" failed content validation.`, {
      path: input.path,
      reason: check.reason,
      detected: check.detected,
    });
  }

  const limits = deps.limits;
  if (input.content.byteLength > limits.maxFileBytes) {
    throw errors.payloadTooLarge(
      `"${input.path}" is ${formatBytes(input.content.byteLength)}; the per-file limit is ${formatBytes(limits.maxFileBytes)}.`,
      { path: input.path, limitBytes: limits.maxFileBytes, actualBytes: input.content.byteLength },
    );
  }
  const usage = draftUsage(deps.db, input.gameId);
  const replacing = draftFileExists(deps.db, input.gameId, input.path);
  if (!replacing && usage.fileCount >= limits.maxProjectFiles) {
    throw errors.quotaExceeded(`File limit reached (${limits.maxProjectFiles} files).`, { limit: limits.maxProjectFiles });
  }
  if (usage.sourceBytes + input.content.byteLength > limits.maxSourceBytes) {
    throw errors.quotaExceeded(`Source size limit reached (${formatBytes(limits.maxSourceBytes)}).`, {
      limitBytes: limits.maxSourceBytes,
      usedBytes: usage.sourceBytes,
    });
  }
  assertWithinQuota(deps.db, {
    userId: getGame(deps.db, input.gameId).owner_id,
    limits,
    additionalSourceBytes: replacing ? 0 : input.content.byteLength,
  });

  const contentType = contentTypeForPath(input.path);
  const ingest = await deps.blobs.ingest(input.content, { class: 'source', contentType, compress: false });
  const timestamp = nowIso();

  deps.db.transaction(() => {
    const draft = getDraft(deps.db, input.gameId);
    deps.db.run(
      `INSERT INTO draft_files (draft_id, path, blob_sha, size_bytes, content_type, role, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id, path) DO UPDATE SET
         blob_sha = excluded.blob_sha, size_bytes = excluded.size_bytes,
         content_type = excluded.content_type, role = excluded.role, updated_at = excluded.updated_at`,
      [draft.id, input.path, ingest.sha256, input.content.byteLength, contentType, role, timestamp],
    );
    if (input.path === MANIFEST_FILE_NAME) {
      deps.db.run('UPDATE game_drafts SET manifest_json = ? WHERE id = ?', [
        new TextDecoder().decode(input.content),
        draft.id,
      ]);
      syncGameFromManifest(deps.db, input.gameId, input.content);
    }
    deps.db.run('UPDATE game_drafts SET revision = revision + 1, updated_at = ? WHERE id = ?', [timestamp, draft.id]);
    deps.db.run('UPDATE games SET updated_at = ? WHERE id = ?', [timestamp, input.gameId]);
  });

  return {
    draft_id: getDraft(deps.db, input.gameId).id,
    path: input.path,
    blob_sha: ingest.sha256,
    size_bytes: input.content.byteLength,
    content_type: contentType,
    role,
    updated_at: timestamp,
  };
}

/** Mirror the few identity-ish manifest fields onto the game row. */
export function syncGameFromManifest(db: Db, gameId: string, manifestBytes: Uint8Array): void {
  const parsed = safeJsonParse<Record<string, unknown>>(new TextDecoder().decode(manifestBytes));
  if (!parsed) return;
  const license = (parsed.license ?? {}) as { spdx?: string; attributionText?: string };
  const presentation = (parsed.presentation ?? {}) as { accentColor?: string; tags?: string[]; thumbnail?: string };
  db.run(
    `UPDATE games SET title = COALESCE(?, title), description = COALESCE(?, description),
       license_spdx = COALESCE(?, license_spdx), accent_color = COALESCE(?, accent_color),
       tags_json = COALESCE(?, tags_json), thumbnail_path = COALESCE(?, thumbnail_path)
     WHERE id = ?`,
    [
      typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : null,
      typeof parsed.description === 'string' ? parsed.description.slice(0, 300) : null,
      typeof license.spdx === 'string' ? license.spdx : null,
      typeof presentation.accentColor === 'string' ? presentation.accentColor : null,
      Array.isArray(presentation.tags) ? JSON.stringify(presentation.tags.slice(0, 8)) : null,
      typeof presentation.thumbnail === 'string' ? presentation.thumbnail : null,
      gameId,
    ],
  );
}

export function deleteDraftFile(deps: ProjectDeps, gameId: string, path: string): void {
  const draft = getDraft(deps.db, gameId);
  if (path === MANIFEST_FILE_NAME) {
    throw errors.validationFailed('The project manifest (game.json) cannot be deleted.');
  }
  if (classifyProjectPath(path) === 'license') {
    throw errors.validationFailed('The LICENSE file cannot be deleted: every published game needs an explicit licence.');
  }
  const result = deps.db.run('DELETE FROM draft_files WHERE draft_id = ? AND path = ?', [draft.id, path]);
  if (result.changes === 0) throw errors.notFound('File not found in this project.');
  deps.db.run('UPDATE game_drafts SET revision = revision + 1, updated_at = ? WHERE id = ?', [nowIso(), draft.id]);
}

export function renameDraftFile(deps: ProjectDeps, gameId: string, from: string, to: string): void {
  const problem = checkPathSafety(to);
  if (problem) throw errors.validationFailed(`"${to}" is not a valid path: ${problem.message}`);
  if (!classifyProjectPath(to, { allowTests: true })) {
    throw errors.validationFailed(`"${to}" is not an allowed project file.`);
  }
  const draft = getDraft(deps.db, gameId);
  const existing = deps.db.get<DraftFileRow>('SELECT * FROM draft_files WHERE draft_id = ? AND path = ?', [draft.id, from]);
  if (!existing) throw errors.notFound('File not found in this project.');
  if (draftFileExists(deps.db, gameId, to)) throw errors.conflict(`"${to}" already exists in this project.`);
  const timestamp = nowIso();
  deps.db.transaction(() => {
    deps.db.run('UPDATE draft_files SET path = ?, content_type = ?, updated_at = ? WHERE draft_id = ? AND path = ?', [
      to,
      contentTypeForPath(to),
      timestamp,
      draft.id,
      from,
    ]);
    deps.db.run('UPDATE game_drafts SET revision = revision + 1, updated_at = ? WHERE id = ?', [timestamp, draft.id]);
  });
}

export function readDraftFile(deps: ProjectDeps, gameId: string, path: string): DraftFileRow {
  const draft = getDraft(deps.db, gameId);
  const row = deps.db.get<DraftFileRow>('SELECT * FROM draft_files WHERE draft_id = ? AND path = ?', [draft.id, path]);
  if (!row) throw errors.notFound('File not found in this project.');
  return row;
}

export function draftFileExists(db: Db, gameId: string, path: string): boolean {
  const row = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM draft_files df JOIN game_drafts d ON d.id = df.draft_id WHERE d.game_id = ? AND df.path = ?',
    [gameId, path],
  );
  return Number(row?.count ?? 0) > 0;
}

// --- Validation --------------------------------------------------------------

export interface DraftValidation {
  ok: boolean;
  manifest: GameManifest | null;
  manifestRaw: unknown | null;
  issues: ValidationIssue[];
}

export async function validateDraft(deps: ProjectDeps, gameId: string): Promise<DraftValidation> {
  const files = listDraftFiles(deps.db, gameId);
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE_NAME);
  if (!manifestFile) {
    return {
      ok: false,
      manifest: null,
      manifestRaw: null,
      issues: [{ path: MANIFEST_FILE_NAME, code: 'required', message: 'the project has no game.json manifest' }],
    };
  }
  const object = await deps.blobs.read(manifestFile.blob_sha);
  if (!object) {
    return {
      ok: false,
      manifest: null,
      manifestRaw: null,
      issues: [{ path: MANIFEST_FILE_NAME, code: 'required', message: 'game.json is missing from storage' }],
    };
  }
  const raw = safeJsonParse<unknown>(new TextDecoder().decode(object.body));
  if (raw === null) {
    return {
      ok: false,
      manifest: null,
      manifestRaw: null,
      issues: [{ path: MANIFEST_FILE_NAME, code: 'bad_format', message: 'game.json is not valid JSON' }],
    };
  }
  const result = validateGameManifest(raw, { limits: deps.limits, files: files.map((file) => file.path) });
  return { ok: result.ok, manifest: result.manifest, manifestRaw: raw, issues: result.issues };
}

export function licenseIssuesOf(manifestRaw: unknown) {
  const declaration = (manifestRaw as { license?: unknown } | null)?.license as
    | { spdx?: unknown; file?: unknown; attributionText?: unknown; assets?: unknown }
    | undefined;
  if (!declaration) return { issues: [], declaration: null };
  const issues = validateLicenseDeclaration({
    spdx: typeof declaration.spdx === 'string' ? declaration.spdx : '',
    file: typeof declaration.file === 'string' ? declaration.file : undefined,
    attributionText: typeof declaration.attributionText === 'string' ? declaration.attributionText : undefined,
    assets: Array.isArray(declaration.assets)
      ? (declaration.assets as { path?: string; license?: string; source?: string; attribution?: string }[]).map(
          (entry) => ({
            path: entry.path ?? '',
            license: entry.license ?? '',
            source: entry.source ?? '',
            attribution: entry.attribution,
          }),
        )
      : [],
  });
  return { issues, declaration };
}

// --- Immutable versions ------------------------------------------------------

export interface CreateVersionInput {
  gameId: string;
  createdBy: string;
  kind: 'snapshot' | 'release';
  note?: string;
  parentVersionId?: string | null;
  remixParams?: Record<string, unknown> | null;
}

/** Freeze the current draft into an immutable, validated source version. */
export async function createVersion(deps: ProjectDeps, input: CreateVersionInput): Promise<SourceVersionRow> {
  const validation = await validateDraft(deps, input.gameId);
  if (!validation.ok || !validation.manifest) {
    throw errors.validationFailed('The project cannot be snapshotted while the manifest is invalid.', {
      issues: validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  const manifest = validation.manifest;
  const files = listDraftFiles(deps.db, input.gameId);
  const row: SourceVersionRow = {
    id: newId('version'),
    game_id: input.gameId,
    sequence: 0,
    kind: input.kind,
    manifest_json: JSON.stringify(manifest),
    manifest_hash: sha256Hex(new TextEncoder().encode(stableStringify(manifest))),
    tree_hash: computeTreeHash(files),
    license_spdx: manifest.license.spdx,
    license_notices: JSON.stringify(files.filter((file) => file.role === 'license').map((file) => file.path).sort()),
    created_by: input.createdBy,
    note: input.note ?? '',
    parent_version_id: input.parentVersionId ?? null,
    remix_params_json: input.remixParams ? JSON.stringify(input.remixParams) : null,
    total_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    file_count: files.length,
    created_at: nowIso(),
  };

  deps.db.transaction(() => {
    const next = deps.db.get<{ sequence: number | null }>(
      'SELECT MAX(sequence) AS sequence FROM source_versions WHERE game_id = ?',
      [input.gameId],
    );
    row.sequence = Number(next?.sequence ?? 0) + 1;
    deps.db.run(
      `INSERT INTO source_versions (id, game_id, sequence, kind, manifest_json, manifest_hash, tree_hash, license_spdx,
         license_notices, created_by, note, parent_version_id, remix_params_json, total_bytes, file_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.game_id,
        row.sequence,
        row.kind,
        row.manifest_json,
        row.manifest_hash,
        row.tree_hash,
        row.license_spdx,
        row.license_notices,
        row.created_by,
        row.note,
        row.parent_version_id,
        row.remix_params_json,
        row.total_bytes,
        row.file_count,
        row.created_at,
      ],
    );
    for (const file of files) {
      deps.db.run(
        'INSERT INTO version_files (version_id, path, blob_sha, size_bytes, content_type, role) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, file.path, file.blob_sha, file.size_bytes, file.content_type, file.role],
      );
    }
    deps.db.run('UPDATE games SET current_version_id = ?, updated_at = ? WHERE id = ?', [row.id, nowIso(), input.gameId]);
    // Bind the remix lineage row to the child's own first immutable version.
    deps.db.run('UPDATE remix_relations SET child_version_id = ? WHERE child_game_id = ? AND child_version_id = parent_version_id', [
      row.id,
      input.gameId,
    ]);
  });

  return row;
}

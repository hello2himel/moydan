/**
 * Read-side projection of games, releases and creators into public DTOs.
 *
 * One place decides what a visitor may see, so the feed, the game page, the
 * creator profile and the API's own JSON all agree. Private material (drafts,
 * private blobs, moderation notes) never crosses this boundary.
 */

import {
  defaultRemixParameterValues,
  describeLicense,
  licensePolicy,
  safeJsonParse,
  type GameCard,
  type GameManifest,
  type GameStats,
  type LicenseInfo,
  type LineageNode,
  type ReleaseSummary,
  type RemixOrigin,
  type RemixParameter,
  type RemixParameterValues,
  type SourceInfo,
} from '@moydan/core';
import type { Config, } from '../config.ts';
import { releaseAssetUrl } from '../config.ts';
import type { Db } from '../db/client.ts';
import { creatorRefFromRow } from './identity.ts';
import type { GameRow } from './projects.ts';

export interface ReleaseRow {
  id: string;
  game_id: string;
  version_id: string;
  sequence: number;
  status: ReleaseSummary['status'];
  manifest_version: number;
  artifact_manifest_json: string;
  artifact_hash: string;
  total_bytes: number;
  first_playable_bytes: number;
  file_count: number;
  entry_path: string;
  engine_name: string;
  engine_version: string;
  runtime_api_version: string;
  spec_json: string;
  created_by: string | null;
  created_at: string;
  verified_at: string | null;
  published_at: string | null;
  withdrawn_at: string | null;
}

export interface ReleaseSpec {
  orientation: ReleaseSummary['orientation'];
  viewport: ReleaseSummary['viewport'];
  input: string[];
  capabilities: string[];
}

export interface ArtifactManifestFile {
  path: string;
  size: number;
  contentType: string;
  encodings?: string[];
  sha256: string;
}

export interface ArtifactManifest {
  version: number;
  entry: string;
  files: ArtifactManifestFile[];
  totalBytes: number;
  firstPlayableBytes: number;
}

export interface MetricsRow {
  game_id: string;
  play_count: number;
  score_submissions: number;
  best_score: number | null;
  reaction_count: number;
  comment_count: number;
  save_count: number;
  remix_count: number;
  distinct_players: number;
  updated_at: string;
}

export function licenseInfo(spdx: string): LicenseInfo {
  const described = describeLicense(spdx);
  const policy = licensePolicy(spdx);
  return {
    spdx,
    name: described.name,
    url: described.url,
    family: described.family,
    requiresAttribution: described.requiresAttribution,
    // "Proprietary" publications may be redistributed as *binaries* by the
    // platform, but their source tree is never exposed.
    sourceRedistributable: policy ? policy.sourceRedistributable : false,
  };
}

export function findRelease(db: Db, releaseId: string): ReleaseRow | null {
  return db.get<ReleaseRow>('SELECT * FROM releases WHERE id = ?', [releaseId]) ?? null;
}

export function getReleaseOrThrow(db: Db, releaseId: string): ReleaseRow {
  const row = findRelease(db, releaseId);
  if (!row) throw new Error('release not found');
  return row;
}

export function releaseSpec(release: ReleaseRow): ReleaseSpec {
  const parsed = safeJsonParse<Partial<ReleaseSpec>>(release.spec_json);
  return {
    orientation: parsed?.orientation ?? 'portrait',
    viewport: parsed?.viewport ?? { width: 320, height: 568, scale: 'fit' },
    input: parsed?.input ?? [],
    capabilities: parsed?.capabilities ?? [],
  };
}

export function releaseSummary(config: Config, release: ReleaseRow): ReleaseSummary {
  const spec = releaseSpec(release);
  return {
    id: release.id,
    sequence: release.sequence,
    status: release.status,
    engine: { name: release.engine_name, version: release.engine_version },
    apiVersion: release.runtime_api_version,
    orientation: spec.orientation,
    viewport: spec.viewport,
    input: spec.input,
    capabilities: spec.capabilities,
    entryUrl: releaseAssetUrl(config, release.id, release.entry_path),
    fileCount: release.file_count,
    totalBytes: release.total_bytes,
    firstPlayableBytes: release.first_playable_bytes,
    artifactHash: release.artifact_hash,
    publishedAt: release.published_at,
    createdAt: release.created_at,
  };
}

export function artifactManifestOf(release: ReleaseRow): ArtifactManifest | null {
  const parsed = safeJsonParse<ArtifactManifest>(release.artifact_manifest_json);
  if (!parsed || typeof parsed.entry !== 'string' || !Array.isArray(parsed.files)) return null;
  return parsed;
}

/** The release a visitor would play right now (published only). */
export function currentPublicRelease(db: Db, game: GameRow): ReleaseRow | null {
  if (!game.current_release_id) return null;
  const release = findRelease(db, game.current_release_id);
  if (!release || release.status !== 'published') return null;
  return release;
}

export function metricsOf(db: Db, gameId: string): GameStats {
  const row = db.get<MetricsRow>('SELECT * FROM game_metrics WHERE game_id = ?', [gameId]);
  const breakdown = db.all<{ type: string; count: number }>(
    'SELECT type, COUNT(*) AS count FROM reactions WHERE game_id = ? GROUP BY type',
    [gameId],
  );
  const reactionBreakdown: Record<string, number> = {};
  for (const entry of breakdown) reactionBreakdown[entry.type] = Number(entry.count);
  return {
    reactions: Number(row?.reaction_count ?? 0),
    comments: Number(row?.comment_count ?? 0),
    saves: Number(row?.save_count ?? 0),
    plays: Number(row?.play_count ?? 0),
    remixes: Number(row?.remix_count ?? 0),
    reactionBreakdown,
  };
}

export function manifestOfGame(db: Db, game: GameRow, release: ReleaseRow | null): GameManifest | null {
  if (release) {
    const row = db.get<{ manifest_json: string }>('SELECT manifest_json FROM source_versions WHERE id = ?', [
      release.version_id,
    ]);
    if (row) {
      const manifest = safeJsonParse<GameManifest>(row.manifest_json);
      if (manifest) return manifest;
    }
  }
  const draft = db.get<{ manifest_json: string | null }>('SELECT manifest_json FROM game_drafts WHERE game_id = ?', [
    game.id,
  ]);
  if (draft?.manifest_json) {
    const manifest = safeJsonParse<GameManifest>(draft.manifest_json);
    if (manifest) return manifest;
  }
  if (game.current_version_id) {
    const row = db.get<{ manifest_json: string }>('SELECT manifest_json FROM source_versions WHERE id = ?', [
      game.current_version_id,
    ]);
    if (row) return safeJsonParse<GameManifest>(row.manifest_json);
  }
  return null;
}

function sourceInfoOf(
  db: Db,
  game: GameRow,
  release: ReleaseRow | null,
  manifest: GameManifest | null,
): SourceInfo | null {
  const versionId = release?.version_id ?? game.current_version_id;
  if (!versionId) return null;
  const version = db.get<{
    id: string;
    sequence: number;
    license_spdx: string;
    license_notices: string;
    file_count: number;
    total_bytes: number;
    tree_hash: string;
    manifest_json: string;
    created_at: string;
  }>('SELECT * FROM source_versions WHERE id = ?', [versionId]);
  if (!version) return null;
  const license = licenseInfo(version.license_spdx);
  const versionManifest = manifest ?? safeJsonParse<GameManifest>(version.manifest_json);
  const notices = safeJsonParse<string[]>(version.license_notices) ?? [];
  return {
    license,
    visible: license.sourceRedistributable,
    visibilityNote: license.sourceRedistributable
      ? null
      : `${license.name} publications do not grant source redistribution: the source tree stays private to the creator.`,
    versionId: version.id,
    versionSequence: version.sequence,
    fileCount: version.file_count,
    totalBytes: version.total_bytes,
    treeHash: version.tree_hash,
    notices,
    attributionText: versionManifest?.license?.attributionText ?? null,
    repository: versionManifest?.repository ?? null,
    artifactHash: release?.artifact_hash ?? '',
    publishedAt: release?.published_at ?? null,
  };
}

function remixOriginOf(db: Db, gameId: string): RemixOrigin | null {
  const row = db.get<{
    mode: 'source' | 'parameters';
    parent_game_id: string;
    parent_version_id: string;
    parent_release_id: string | null;
    root_game_id: string;
    parent_creator_id: string;
    parent_creator_handle: string;
    parent_title: string;
    parent_license_spdx: string;
    attribution_text: string;
    params_json: string | null;
    created_at: string;
  }>('SELECT * FROM remix_relations WHERE child_game_id = ?', [gameId]);
  if (!row) return null;
  const creator = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [row.parent_creator_id],
  );
  return {
    mode: row.mode,
    parent: {
      gameId: row.parent_game_id,
      title: row.parent_title,
      creator: creator ? creatorRefFromRow(creator) : { id: row.parent_creator_id, handle: row.parent_creator_handle, displayName: row.parent_creator_handle, avatarUrl: null },
      versionId: row.parent_version_id,
      releaseId: row.parent_release_id,
      licenseSpdx: row.parent_license_spdx,
    },
    rootGameId: row.root_game_id,
    attributionText: row.attribution_text,
    params: row.params_json ? safeJsonParse<RemixParameterValues>(row.params_json) : null,
    createdAt: row.created_at,
  };
}

/** Walk the remix chain upwards: direct parent first, oldest ancestor last. */
export function lineageOf(db: Db, gameId: string): LineageNode[] {
  const nodes: LineageNode[] = [];
  let cursor: string | null = gameId;
  const seen = new Set<string>();
  while (cursor && nodes.length < 20) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const relation: {
      parent_game_id: string;
      parent_version_id: string;
      parent_release_id: string | null;
      parent_creator_id: string;
      parent_creator_handle: string;
      parent_title: string;
      parent_license_spdx: string;
      attribution_text: string;
      mode: 'source' | 'parameters';
      created_at: string;
    } | undefined = db.get('SELECT * FROM remix_relations WHERE child_game_id = ?', [cursor]);
    if (!relation) break;
    const creator = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
      `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
         FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
      [relation.parent_creator_id],
    );
    nodes.push({
      gameId: relation.parent_game_id,
      title: relation.parent_title,
      creator: creator
        ? creatorRefFromRow(creator)
        : { id: relation.parent_creator_id, handle: relation.parent_creator_handle, displayName: relation.parent_creator_handle, avatarUrl: null },
      versionId: relation.parent_version_id,
      releaseId: relation.parent_release_id,
      licenseSpdx: relation.parent_license_spdx,
      mode: relation.mode,
      attributionText: relation.attribution_text,
      createdAt: relation.created_at,
    });
    cursor = relation.parent_game_id;
  }
  return nodes;
}

export interface ViewerQuery {
  viewerId: string | null;
}

export function loadGameCard(
  db: Db,
  config: Config,
  game: GameRow,
  viewerId: string | null,
  options: { publicOnly?: boolean } = {},
): GameCard | null {
  const release = currentPublicRelease(db, game);
  if (options.publicOnly && (!release || game.status !== 'published')) return null;

  const creatorRow = db.get<{ id: string; handle: string; display_name: string; avatar_url: string | null }>(
    `SELECT u.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar_url AS avatar_url
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [game.owner_id],
  );
  if (!creatorRow) return null;

  const manifest = manifestOfGame(db, game, release);
  const remixRelation = db.get<{ params_json: string | null }>(
    'SELECT * FROM remix_relations WHERE child_game_id = ?',
    [game.id],
  );
  const parameters: RemixParameter[] = manifest?.remix?.parameters ?? [];
  const overrides = remixRelation?.params_json ? safeJsonParse<RemixParameterValues>(remixRelation.params_json) : null;
  const releaseParams = release
    ? safeJsonParse<RemixParameterValues>(
        db.get<{ remix_params_json: string | null }>('SELECT * FROM source_versions WHERE id = ?', [release.version_id])
          ?.remix_params_json ?? 'null',
      )
    : null;
  const params: RemixParameterValues = { ...defaultRemixParameterValues(parameters), ...(overrides ?? {}), ...(releaseParams ?? {}) };

  const tags = safeJsonParse<string[]>(game.tags_json) ?? [];
  const reaction = viewerId
    ? db.get<{ type: string }>('SELECT type FROM reactions WHERE user_id = ? AND game_id = ?', [viewerId, game.id])
    : undefined;
  const saved = viewerId
    ? Boolean(db.get<{ game_id: string }>('SELECT game_id FROM saved_games WHERE user_id = ? AND game_id = ?', [viewerId, game.id]))
    : false;
  const following = viewerId
    ? Boolean(
        db.get<{ follower_id: string }>('SELECT follower_id FROM follows WHERE follower_id = ? AND followee_id = ?', [
          viewerId,
          game.owner_id,
        ]),
      )
    : false;

  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    description: game.description,
    thumbnailUrl:
      game.thumbnail_path && release ? releaseAssetUrl(config, release.id, game.thumbnail_path) : null,
    accentColor: game.accent_color ?? '#6d5efc',
    tags,
    status: game.status,
    isRemix: game.is_remix === 1,
    createdAt: game.created_at,
    publishedAt: game.published_at,
    creator: creatorRefFromRow(creatorRow),
    release: release ? releaseSummary(config, release) : null,
    source: sourceInfoOf(db, game, release, manifest),
    remixOrigin: remixOriginOf(db, game.id),
    remixParameters: parameters,
    params,
    stats: metricsOf(db, game.id),
    viewer: { reacted: reaction?.type ?? null, saved, following },
    owned: viewerId === game.owner_id,
  };
}

export function listGameCards(
  db: Db,
  config: Config,
  games: GameRow[],
  viewerId: string | null,
  options: { publicOnly?: boolean } = {},
): GameCard[] {
  const cards: GameCard[] = [];
  for (const game of games) {
    const card = loadGameCard(db, config, game, viewerId, options);
    if (card) cards.push(card);
  }
  return cards;
}

export function canViewGame(game: GameRow, viewer: { id: string; role: 'user' | 'admin' } | null): boolean {
  if (game.status === 'published') return true;
  if (!viewer) return false;
  return viewer.id === game.owner_id || viewer.role === 'admin';
}

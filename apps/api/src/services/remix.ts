/**
 * Remixing.
 *
 * Two modes exist and they have different legal and product consequences:
 *
 *   parameters - the child runs the parent's code with different declared
 *                parameters. The source tree is inherited unchanged.
 *   source     - the child receives a copy of the parent's source tree (sharing
 *                the same blobs until a file is edited) and is meant to be
 *                modified.
 *
 * Both modes are derivative works, so the parent's licence policy governs
 * whether they are allowed at all and which licences the child may declare
 * (share-alike is enforced, never hand-waved away).
 */

import {
  allowedDerivativeLicenses,
  applyRemixParameters,
  buildAttributionText,
  errors,
  licensePolicy,
  newId,
  type GameManifest,
  type RemixParameterValues,
} from '@moydan/core';
import { nowIso, type Db } from '../db/client.ts';
import { currentPublicRelease, manifestOfGame } from './catalog.ts';
import { createGame, type GameRow, type ProjectDeps, type SourceVersionRow } from './projects.ts';
import { isKnownLicense } from '@moydan/core';

export type RemixDeps = ProjectDeps;

export interface RemixInput {
  parentGame: GameRow;
  viewerId: string;
  mode: 'source' | 'parameters';
  params?: Record<string, unknown> | null;
  title?: string;
  slug?: string;
  childLicenseSpdx?: string;
}

export interface RemixResult {
  game: GameRow;
  versionId: string;
}

export function remixCapabilities(db: Db, parent: GameRow): {
  allowed: boolean;
  modes: string[];
  reason: string | null;
  parameters: GameManifest['remix']['parameters'];
  allowedChildLicenses: string[];
} {
  const release = currentPublicRelease(db, parent);
  const manifest = manifestOfGame(db, parent, release);
  const policy = licensePolicy(parent.license_spdx);
  const modes: string[] = [];
  let reason: string | null = null;

  if (parent.status !== 'published') reason = 'Only published games can be remixed.';
  else if (!policy) reason = 'This game does not declare a licence the platform understands.';
  else if (!policy.allowsSourceRemix && !policy.allowsParameterRemix) {
    reason = `${policy.name} does not permit derivative games.`;
  } else if (!manifest?.remix?.allowed) {
    reason = 'The creator disabled remixing for this game.';
  }

  if (!reason && manifest && policy) {
    if (policy.allowsParameterRemix && manifest.remix.modes.includes('parameters')) modes.push('parameters');
    if (policy.allowsSourceRemix && manifest.remix.modes.includes('source')) modes.push('source');
    if (modes.length === 0) reason = 'This game declares no remix mode.';
  }

  return {
    allowed: reason === null,
    modes,
    reason,
    parameters: manifest?.remix?.parameters ?? [],
    allowedChildLicenses: allowedDerivativeLicenses(parent.license_spdx),
  };
}

export async function remixGame(deps: RemixDeps, input: RemixInput): Promise<RemixResult> {
  const parent = input.parentGame;
  const capabilities = remixCapabilities(deps.db, parent);
  if (!capabilities.allowed) {
    throw errors.remixNotAllowed(capabilities.reason ?? 'This game cannot be remixed.', {
      parentGameId: parent.id,
    });
  }
  if (!capabilities.modes.includes(input.mode)) {
    throw errors.remixNotAllowed(`This game only allows: ${capabilities.modes.join(', ') || 'no remix mode'}.`, {
      requested: input.mode,
      available: capabilities.modes,
    });
  }

  const release = currentPublicRelease(deps.db, parent);
  const manifest = manifestOfGame(deps.db, parent, release);
  if (!manifest) throw errors.conflict('The game has no valid manifest to remix from.');

  const versionId = release?.version_id ?? parent.current_version_id;
  if (!versionId) throw errors.conflict('The game has no frozen version to remix from.');
  const version = deps.db.get<SourceVersionRow>('SELECT * FROM source_versions WHERE id = ?', [versionId]);
  if (!version) throw errors.conflict('The game has no frozen version to remix from.');
  const parentFiles = deps.db.all<{ path: string; blob_sha: string; size_bytes: number; content_type: string; role: 'source' | 'asset' | 'document' | 'manifest' | 'license' }>(
    'SELECT path, blob_sha, size_bytes, content_type, role FROM version_files WHERE version_id = ?',
    [version.id],
  );
  if (parentFiles.length === 0) throw errors.internal('The parent version has no files.');

  const parameterCheck = applyRemixParameters(manifest.remix.parameters, input.params ?? null);
  if (!parameterCheck.ok) {
    throw errors.validationFailed('Those remix parameters are not valid for this game.', {
      issues: parameterCheck.issues,
    });
  }
  const params: RemixParameterValues = parameterCheck.value;

  // Licence: the child must declare a licence the parent's policy allows.
  const allowed = capabilities.allowedChildLicenses;
  const parentPolicy = licensePolicy(parent.license_spdx);
  let childLicense = input.childLicenseSpdx ?? '';
  if (!childLicense) {
    childLicense = allowed.includes(parent.license_spdx) && parentPolicy?.appliesToCode ? parent.license_spdx : (allowed[0] ?? '');
  }
  if (!childLicense || !isKnownLicense(childLicense)) {
    throw errors.licenseRejected(
      `${parent.license_spdx} does not allow publishing a derivative under an unsupported licence.`,
      { allowedLicenses: allowed },
    );
  }
  if (allowed.length > 0 && !allowed.includes(childLicense)) {
    throw errors.licenseRejected(
      `${parent.license_spdx} derivations must be published under: ${allowed.join(', ')}.`,
      { declared: childLicense, allowedLicenses: allowed },
    );
  }

  const title = (input.title ?? `${parent.title} remix`).slice(0, 60);
  const slug = (input.slug ?? defaultSlug(title)).slice(0, 40);
  const creator = deps.db.get<{ handle: string }>('SELECT handle FROM profiles WHERE user_id = ?', [input.viewerId]);
  const attributionText = buildAttributionText({
    childTitle: title,
    childHandle: creator?.handle ?? 'creator',
    parentTitle: parent.title,
    parentHandle: deps.db.get<{ handle: string }>('SELECT handle FROM profiles WHERE user_id = ?', [parent.owner_id])?.handle ?? 'creator',
    parentSpdx: parent.license_spdx,
    parentAttributionText: manifest.license.attributionText,
    mode: input.mode,
  });

  const { game } = await createGame(deps, {
    ownerId: input.viewerId,
    title,
    slug,
    description: `A ${input.mode} remix of "${parent.title}".`,
    licenseSpdx: childLicense,
    template: '',
    remix: {
      parentGameId: parent.id,
      parentVersionId: version.id,
      parentReleaseId: release?.id ?? null,
      parentFiles: parentFiles.map((file) => ({
        path: file.path,
        blobSha: file.blob_sha,
        size: file.size_bytes,
        contentType: file.content_type,
        role: file.role,
      })),
      mode: input.mode,
      rootGameId: parent.root_game_id ?? parent.id,
      attributionText,
      params: input.mode === 'parameters' ? params : null,
      parentCreatorId: parent.owner_id,
      parentCreatorHandle: deps.db.get<{ handle: string }>('SELECT handle FROM profiles WHERE user_id = ?', [parent.owner_id])?.handle ?? 'creator',
      parentTitle: parent.title,
      parentLicenseSpdx: parent.license_spdx,
    },
  });

  auditRemix(deps.db, {
    actorId: input.viewerId,
    childGameId: game.id,
    parentGameId: parent.id,
    parentVersionId: version.id,
    mode: input.mode,
    license: childLicense,
  });

  return { game, versionId: version.id };
}

function auditRemix(
  db: Db,
  detail: {
    actorId: string;
    childGameId: string;
    parentGameId: string;
    parentVersionId: string;
    mode: string;
    license: string;
  },
): void {
  db.run(
    'INSERT INTO security_events (id, kind, actor_id, ip_hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('event'), 'remix.created', detail.actorId, '', JSON.stringify(detail), nowIso()],
  );
}

function defaultSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base.length >= 3 ? base : `remix-${Date.now().toString(36).slice(-4)}`;
}

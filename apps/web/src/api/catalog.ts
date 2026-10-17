/**
 * Public catalog reads (`routes/catalog.ts`): the game card, its release
 * detail, lineage and public scores.
 *
 * Everything here is optional in practice: a game may have no release yet, no
 * public source, or no scores. The types mirror that by keeping those fields
 * nullable so screens can render an honest "not available" state.
 */

import type { GameCard, LineageNode, Paginated, ReleaseDetail, RemixOrigin } from '@moydan/core';
import { apiJson } from './client.ts';

export interface LineageResponse {
  origin: RemixOrigin | null;
  ancestors: LineageNode[];
}

export interface PublicScore {
  id: string;
  value: number;
  unit: string;
  difficulty: string | null;
  createdAt: string;
  player: { handle: string; displayName: string; avatarUrl: string | null } | null;
  verified: boolean;
}

export interface SourceListing {
  versionId: string;
  licenseSpdx: string;
  treeHash: string;
  kind: string;
  createdAt: string;
  visible: boolean;
  files: { path: string; size: number; contentType: string; role: string }[];
}

export function getGame(gameId: string, signal?: AbortSignal): Promise<GameCard> {
  return apiJson<GameCard>(`/api/games/${gameId}`, { signal });
}

export function getLineage(gameId: string, signal?: AbortSignal): Promise<LineageResponse> {
  return apiJson<LineageResponse>(`/api/games/${gameId}/lineage`, { signal });
}

export function getScores(gameId: string, limit = 10, signal?: AbortSignal): Promise<Paginated<PublicScore>> {
  return apiJson<Paginated<PublicScore>>(`/api/games/${gameId}/scores`, { query: { limit }, signal });
}

export function getSourceListing(gameId: string, signal?: AbortSignal): Promise<SourceListing> {
  return apiJson<SourceListing>(`/api/games/${gameId}/source`, { signal });
}

export function getRelease(releaseId: string, signal?: AbortSignal): Promise<ReleaseDetail> {
  return apiJson<ReleaseDetail>(`/api/releases/${releaseId}`, { signal });
}
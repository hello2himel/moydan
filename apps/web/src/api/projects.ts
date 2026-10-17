/**
 * Creator project lifecycle (`routes/projects.ts`).
 *
 * Every function here is owner-only unless noted in `docs/API.md`. File uploads
 * and zip imports are raw bytes: the API decides how to interpret them from the
 * path, so the client sends `application/octet-stream` and never a
 * client-authored content type.
 */

import type {
  BuildJob,
  DraftState,
  GameCard,
  ProjectFile,
  ReleaseDetail,
  ReleaseSummary,
} from '@moydan/core';
import { apiBytes, apiJson, apiResponse, apiSend, apiSendBytes, apiPutBytes, fileSegment } from './client.ts';

/** `GET /api/games/:id/versions` has no shared DTO yet; every field is optional. */
export interface SourceVersionSummary {
  id: string;
  kind?: string;
  licenseSpdx?: string;
  treeHash?: string;
  fileCount?: number;
  totalBytes?: number;
  createdAt?: string;
}

export interface CreateGameInput {
  title: string;
  slug: string;
  description: string;
  licenseSpdx: string;
  template: string;
}

export interface UpdateGameInput {
  title?: string;
  description?: string;
  accentColor?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest: unknown | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  totalBytes: number;
}

export interface PreviewGrant {
  token: string;
  expiresAt: string;
  url: string;
}

export interface StatusResult {
  status: string;
}

export interface CreatedGame {
  game: GameCard;
  draft: DraftState;
}

function draftPath(gameId: string): string {
  return `/api/games/${gameId}/draft`;
}

function filePath(gameId: string, path: string): string {
  return `${draftPath(gameId)}/files/${fileSegment(path)}`;
}

export function getDraft(gameId: string, signal?: AbortSignal): Promise<DraftState> {
  return apiJson<DraftState>(draftPath(gameId), { signal });
}

export function putDraftFile(gameId: string, path: string, bytes: Uint8Array): Promise<ProjectFile> {
  return apiPutBytes<ProjectFile>(filePath(gameId, path), bytes, 'application/octet-stream');
}

export function getDraftFile(gameId: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  return apiBytes(filePath(gameId, path), { signal });
}

export function deleteDraftFile(gameId: string, path: string): Promise<{ deleted: true }> {
  return apiSend<{ deleted: true }>('DELETE', filePath(gameId, path));
}

export function renameDraftFile(gameId: string, from: string, to: string): Promise<{ from: string; to: string }> {
  return apiSend<{ from: string; to: string }>('POST', `${draftPath(gameId)}/files/rename`, { from, to });
}

export function importDraftArchive(gameId: string, zip: Uint8Array): Promise<ImportResult> {
  return apiSendBytes<ImportResult>('POST', `${draftPath(gameId)}/import`, zip, 'application/zip');
}

/** Zip bytes; the caller turns them into an object URL for the browser. */
export function exportDraftArchive(gameId: string, signal?: AbortSignal): Promise<Response> {
  return apiResponse(`${draftPath(gameId)}/export`, { signal });
}

export function validateDraft(gameId: string): Promise<ValidationResult> {
  return apiSend<ValidationResult>('POST', `${draftPath(gameId)}/validate`);
}

export function createGame(input: CreateGameInput): Promise<CreatedGame> {
  return apiSend<CreatedGame>('POST', '/api/games', input);
}

export function updateGame(gameId: string, input: UpdateGameInput): Promise<GameCard> {
  return apiSend<GameCard>('PATCH', `/api/games/${gameId}`, input);
}

export function listVersions(gameId: string, signal?: AbortSignal): Promise<{ items: SourceVersionSummary[] }> {
  return apiJson<{ items: SourceVersionSummary[] }>(`/api/games/${gameId}/versions`, { signal });
}

export function listBuilds(gameId: string, signal?: AbortSignal): Promise<{ items: BuildJob[] }> {
  return apiJson<{ items: BuildJob[] }>(`/api/games/${gameId}/builds`, { signal });
}

export function getBuild(jobId: string, signal?: AbortSignal): Promise<BuildJob> {
  return apiJson<BuildJob>(`/api/builds/${jobId}`, { signal });
}

export function startBuild(gameId: string, note?: string): Promise<BuildJob> {
  return apiSend<BuildJob>('POST', `/api/games/${gameId}/build`, note ? { note } : {});
}

export function publishGame(gameId: string, releaseId: string): Promise<ReleaseDetail> {
  return apiSend<ReleaseDetail>('POST', `/api/games/${gameId}/publish`, { releaseId });
}

export function unpublishGame(gameId: string): Promise<StatusResult> {
  return apiSend<StatusResult>('POST', `/api/games/${gameId}/unpublish`);
}

export function republishGame(gameId: string): Promise<StatusResult> {
  return apiSend<StatusResult>('POST', `/api/games/${gameId}/republish`);
}

export function withdrawRelease(releaseId: string, reason: string): Promise<StatusResult> {
  return apiSend<StatusResult>('POST', `/api/releases/${releaseId}/withdraw`, { reason });
}

export function createPreviewGrant(releaseId: string): Promise<PreviewGrant> {
  return apiSend<PreviewGrant>('POST', `/api/releases/${releaseId}/preview-grant`);
}

export function listReleases(gameId: string, signal?: AbortSignal): Promise<{ items: ReleaseSummary[] }> {
  return apiJson<{ items: ReleaseSummary[] }>(`/api/games/${gameId}/releases`, { signal });
}
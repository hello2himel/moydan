/**
 * Social endpoints (`routes/social.ts`): reactions, saves, comments, shares,
 * follows and moderation reports.
 *
 * Each write returns the authoritative new state (counts included) so the UI
 * can reconcile an optimistic update instead of guessing. Duplicate saves are a
 * `409` server-side, which is why every toggle is expressed as an absolute
 * PUT/DELETE rather than a flip.
 */

import type { Comment, ModerationReport, Paginated } from '@moydan/core';
import { apiJson, apiSend } from './client.ts';

export const REACTION_TYPES = ['like', 'love', 'fire', 'wow'] as const;
export type ReactionType = (typeof REACTION_TYPES)[number];

export interface ReactionResult {
  reacted: string | null;
  reactions: number;
}

export interface SaveResult {
  saved: boolean;
  saves: number;
}

export interface FollowResult {
  following: boolean;
  followers?: number;
}

export interface ShareResult {
  url: string;
  title: string;
}

export interface ReportInput {
  targetType: 'game' | 'comment' | 'user';
  targetId: string;
  reasonCode: string;
  details?: string;
}

export interface CommentQuery {
  cursor?: string | null;
  limit?: number;
  parentId?: string | null;
}

export function setReaction(gameId: string, type: ReactionType): Promise<ReactionResult> {
  return apiSend<ReactionResult>('PUT', `/api/games/${gameId}/reaction`, { type });
}

export function clearReaction(gameId: string): Promise<ReactionResult> {
  return apiSend<ReactionResult>('DELETE', `/api/games/${gameId}/reaction`);
}

export function saveGame(gameId: string): Promise<SaveResult> {
  return apiSend<SaveResult>('PUT', `/api/games/${gameId}/save`);
}

export function unsaveGame(gameId: string): Promise<SaveResult> {
  return apiSend<SaveResult>('DELETE', `/api/games/${gameId}/save`);
}

export function getComments(gameId: string, query?: CommentQuery, signal?: AbortSignal): Promise<Paginated<Comment>> {
  const limit = Math.max(1, Math.min(50, Math.floor(query?.limit ?? 20)));
  return apiJson<Paginated<Comment>>(`/api/games/${gameId}/comments`, {
    query: { cursor: query?.cursor ?? undefined, limit, parentId: query?.parentId ?? undefined },
    signal,
  });
}

export function createComment(gameId: string, body: string, parentId?: string | null): Promise<Comment> {
  return apiSend<Comment>('POST', `/api/games/${gameId}/comments`, { body, parentId: parentId ?? null });
}

export function updateComment(commentId: string, body: string): Promise<Comment> {
  return apiSend<Comment>('PATCH', `/api/comments/${commentId}`, { body });
}

export function deleteComment(commentId: string): Promise<{ removed: true }> {
  return apiSend<{ removed: true }>('DELETE', `/api/comments/${commentId}`);
}

/** Stable, shareable application URL for a game. */
export function createShareLink(gameId: string): Promise<ShareResult> {
  return apiSend<ShareResult>('POST', `/api/games/${gameId}/share`);
}

export function followCreator(handle: string): Promise<FollowResult> {
  return apiSend<FollowResult>('POST', `/api/profiles/${encodeURIComponent(handle)}/follow`);
}

export function unfollowCreator(handle: string): Promise<FollowResult> {
  return apiSend<FollowResult>('DELETE', `/api/profiles/${encodeURIComponent(handle)}/follow`);
}

export function createReport(input: ReportInput): Promise<ModerationReport> {
  return apiSend<ModerationReport>('POST', '/api/reports', input);
}
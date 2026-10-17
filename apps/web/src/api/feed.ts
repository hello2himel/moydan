/**
 * Feed, saved list and creator listings (`routes/feed.ts`).
 *
 * Every one of these is cursor paginated. Cursors are opaque, so the client
 * only ever echoes back what the server returned - it never parses or builds
 * one itself.
 */

import type { GameCard, Paginated } from '@moydan/core';
import { apiJson } from './client.ts';

export type FeedTab = 'foryou' | 'following';

export interface PageQuery {
  cursor?: string | null;
  limit?: number;
}

export const DEFAULT_PAGE_SIZE = 8;

function pageQuery(query: PageQuery | undefined, defaultLimit: number): { cursor?: string; limit: number } {
  const limit = Math.max(1, Math.min(25, Math.floor(query?.limit ?? defaultLimit)));
  const cursor = query?.cursor ?? undefined;
  return cursor ? { cursor, limit } : { limit };
}

export function getForYouFeed(query?: PageQuery, signal?: AbortSignal): Promise<Paginated<GameCard>> {
  return apiJson<Paginated<GameCard>>('/api/feed/foryou', { query: pageQuery(query, DEFAULT_PAGE_SIZE), signal });
}

export function getFollowingFeed(query?: PageQuery, signal?: AbortSignal): Promise<Paginated<GameCard>> {
  return apiJson<Paginated<GameCard>>('/api/feed/following', { query: pageQuery(query, DEFAULT_PAGE_SIZE), signal });
}

export function getSavedGames(query?: PageQuery, signal?: AbortSignal): Promise<Paginated<GameCard>> {
  return apiJson<Paginated<GameCard>>('/api/me/saved', { query: pageQuery(query, 12), signal });
}

/** Public listing of a creator's games; drafts are only included for the owner. */
export function getCreatorGames(handle: string, signal?: AbortSignal): Promise<Paginated<GameCard>> {
  return apiJson<Paginated<GameCard>>(`/api/profiles/${encodeURIComponent(handle)}/games`, { signal });
}
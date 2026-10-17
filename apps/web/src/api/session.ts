/**
 * Session and account endpoints (`routes/auth.ts`, `routes/profiles.ts`).
 *
 * The browser never stores a token: `GET /api/auth/session` reads the HttpOnly
 * session cookie and the UI simply asks "who am I?". Everything else here is
 * the account surface behind the profile and settings screens.
 */

import type { GameCard, Paginated, PublicProfile, SessionResponse, StorageUsageResponse } from '@moydan/core';
import { apiJson, apiSend } from './client.ts';

/** `GET /api/auth/session` answers `{ user: null }` for anonymous visitors. */
export interface SessionState {
  user: SessionResponse['user'] | null;
  devNotice?: string;
}

export type Viewer = SessionResponse['user'];

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  handle: string;
  displayName: string;
}

export interface ProfileUpdateInput {
  displayName?: string;
  bio?: string;
  avatarUrl?: string | null;
}

export interface HandleAvailability {
  handle: string;
  available: boolean;
  suggestion: string;
}

export function getSession(signal?: AbortSignal): Promise<SessionState> {
  return apiJson<SessionState>('/api/auth/session', { signal });
}

export function login(input: LoginInput): Promise<SessionResponse> {
  return apiSend<SessionResponse>('POST', '/api/auth/login', input);
}

export function register(input: RegisterInput): Promise<SessionResponse> {
  return apiSend<SessionResponse>('POST', '/api/auth/register', input);
}

export function logout(): Promise<{ ok: true }> {
  return apiSend<{ ok: true }>('POST', '/api/auth/logout');
}

export function getOwnProfile(signal?: AbortSignal): Promise<PublicProfile> {
  return apiJson<PublicProfile>('/api/me/profile', { signal });
}

/** Public profile of any creator. */
export function getProfile(handle: string, signal?: AbortSignal): Promise<PublicProfile> {
  return apiJson<PublicProfile>(`/api/profiles/${encodeURIComponent(handle)}`, { signal });
}

export function updateOwnProfile(input: ProfileUpdateInput): Promise<PublicProfile> {
  return apiSend<PublicProfile>('PATCH', '/api/me/profile', input);
}

export function getStorageUsage(signal?: AbortSignal): Promise<StorageUsageResponse> {
  return apiJson<StorageUsageResponse>('/api/me/storage', { signal });
}

/** Every game the viewer owns, drafts included. Not paginated server-side. */
export function getOwnGames(signal?: AbortSignal): Promise<Paginated<GameCard>> {
  return apiJson<Paginated<GameCard>>('/api/me/games', { signal });
}

export function getHandleAvailability(handle: string, signal?: AbortSignal): Promise<HandleAvailability> {
  return apiJson<HandleAvailability>('/api/handles/available', { query: { handle }, signal });
}
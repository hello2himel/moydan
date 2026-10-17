/**
 * Play session protocol (`routes/play.ts`).
 *
 * The player is untrusted input from the API's point of view: a score sent by a
 * game is a claim, never proof. The web client therefore reports what the host
 * runtime observed and nothing more.
 */

import { apiSend } from './client.ts';

export interface PlaySessionConfig {
  apiVersion?: string;
  heartbeatMs?: number;
  maxMessagesPerSecond?: number;
  storage?: boolean;
  score?: boolean;
}

export interface PlaySession {
  sessionId: string;
  entryUrl: string;
  config: PlaySessionConfig;
}

export interface HeartbeatResult {
  firstFrame: boolean;
  ended: boolean;
}

export interface ReportInput {
  outcome: 'completed' | 'abandoned' | 'error';
  score?: number;
  scoreUnit?: string;
  difficulty?: string;
  durationMs?: number;
  errorCode?: string;
}

export interface ReportResult {
  alreadyReported: boolean;
  bestScore: number | null;
}

export function createPlaySession(gameId: string, releaseId: string): Promise<PlaySession> {
  return apiSend<PlaySession>('POST', '/api/play/sessions', { gameId, releaseId });
}

export function heartbeat(sessionId: string, frames: number, fps?: number): Promise<HeartbeatResult> {
  return apiSend<HeartbeatResult>('POST', `/api/play/sessions/${sessionId}/heartbeat`, {
    frames,
    fps: fps ?? null,
  });
}

export function reportSession(sessionId: string, input: ReportInput): Promise<ReportResult> {
  return apiSend<ReportResult>('POST', `/api/play/sessions/${sessionId}/report`, input);
}
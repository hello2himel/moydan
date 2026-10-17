/**
 * Host <-> game bridge protocol, version 1.
 *
 * The game runs in a sandboxed iframe on a dedicated origin. Everything that
 * crosses the boundary is JSON, validated on both sides:
 *
 *   - host -> game : lifecycle commands and capability grants
 *   - game -> host : lifecycle events, score submissions, storage requests
 *
 * Rules enforced here (and asserted in tests):
 *   - messages are plain objects with `type`, `protocol`, and `id` fields only;
 *   - unknown keys are rejected (no smuggling data through extra fields);
 *   - payloads are schema-validated and size bounded;
 *   - unknown `type` values are rejected by the receiver;
 *   - request/response correlation uses host-generated ids.
 */

import { schema, type Shape } from './schema.ts';
import { type RemixParameterValues } from './manifest.ts';

export const BRIDGE_PROTOCOL_VERSION = 1;
/**
 * Every bridge message type starts with this prefix (`mo:init`, `mo:ready`, …).
 *
 * It is part of the published wire contract: a game built against one value must
 * never be replayed against another, so the value is versioned with the protocol
 * and only changed by a major protocol bump.
 */
export const BRIDGE_MESSAGE_PREFIX = 'mo';

export const BRIDGE_MAX_MESSAGE_BYTES = 8 * 1024;
export const BRIDGE_MESSAGES_PER_SECOND = 30;

export type HostToGameType =
  | 'mo:init'
  | 'mo:start'
  | 'mo:pause'
  | 'mo:resume'
  | 'mo:restart'
  | 'mo:mute'
  | 'mo:visibility'
  | 'mo:dispose'
  | 'mo:ping'
  | 'mo:res';

export type GameToHostType =
  | 'mo:ready'
  | 'mo:started'
  | 'mo:paused'
  | 'mo:resumed'
  | 'mo:restarted'
  | 'mo:score'
  | 'mo:storage'
  | 'mo:heartbeat'
  | 'mo:error'
  | 'mo:log'
  | 'mo:ended'
  | 'mo:req';

export interface BridgeEnvelopeBase {
  protocol: number;
  /** Host-generated correlation identifier (never trusted for authorization). */
  id: string;
}

export interface GameInitConfig {
  releaseId: string;
  gameId: string;
  gameTitle: string;
  /** Immutable parameter values for this specific release/remix. */
  params: RemixParameterValues;
  /** Capabilities the host grants for this session (intersection with manifest). */
  capabilities: string[];
  apiVersion: string;
  locale: string;
  /** Design viewport from the manifest. */
  viewport: { width: number; height: number; scale: 'fit' | 'cover' | 'stretch' };
  orientation: 'portrait' | 'landscape' | 'any';
  /** True when the host already muted the game (it starts paused/offscreen). */
  muted: boolean;
  /** Session id is opaque and rotates per play; games must not persist it. */
  sessionId: string;
  /** True when the release is a preview build (not public). */
  preview: boolean;
  limits: {
    heartbeatMs: number;
    maxMessageBytes: number;
    messagesPerSecond: number;
  };
}

export interface GameInitMessage extends BridgeEnvelopeBase {
  type: 'mo:init';
  payload: GameInitConfig;
}

export interface SimpleCommandMessage extends BridgeEnvelopeBase {
  type: 'mo:start' | 'mo:pause' | 'mo:resume' | 'mo:restart' | 'mo:dispose';
  payload?: Record<string, never>;
}

export interface MuteMessage extends BridgeEnvelopeBase {
  type: 'mo:mute';
  payload: { muted: boolean };
}

export interface VisibilityMessage extends BridgeEnvelopeBase {
  type: 'mo:visibility';
  payload: { visible: boolean };
}

export interface PingMessage extends BridgeEnvelopeBase {
  type: 'mo:ping';
  payload: { nonce: string };
}

export interface HostResponseMessage extends BridgeEnvelopeBase {
  type: 'mo:res';
  payload: { requestId: string; ok: boolean; result?: unknown; error?: string };
}

export type HostToGameMessage =
  | GameInitMessage
  | SimpleCommandMessage
  | MuteMessage
  | VisibilityMessage
  | PingMessage
  | HostResponseMessage;

export interface ReadyMessage extends BridgeEnvelopeBase {
  type: 'mo:ready';
  payload: { sdkVersion: string; capabilitiesUsed: string[] };
}

export interface StartedMessage extends BridgeEnvelopeBase {
  type: 'mo:started';
  payload: { instanceId: string; msToStart: number };
}

export interface LifecycleAckMessage extends BridgeEnvelopeBase {
  type: 'mo:paused' | 'mo:resumed';
  payload: Record<string, never>;
}

export interface RestartedMessage extends BridgeEnvelopeBase {
  type: 'mo:restarted';
  payload: { instanceId: string; instanceCount: number };
}

export interface ScoreMessage extends BridgeEnvelopeBase {
  type: 'mo:score';
  payload: { value: number; unit?: string; difficulty?: string; durationMs?: number; meta?: unknown };
}

export interface StorageRequestMessage extends BridgeEnvelopeBase {
  type: 'mo:storage';
  payload: { op: 'get' | 'set' | 'remove' | 'clear'; key?: string; value?: unknown };
}

export interface HeartbeatMessage extends BridgeEnvelopeBase {
  type: 'mo:heartbeat';
  payload: { instanceId: string; frames: number; fps?: number; memoryMb?: number };
}

export interface ErrorMessage extends BridgeEnvelopeBase {
  type: 'mo:error';
  payload: { message: string; source?: string; fatal: boolean; stack?: string };
}

export interface LogMessage extends BridgeEnvelopeBase {
  type: 'mo:log';
  payload: { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
}

export interface EndedMessage extends BridgeEnvelopeBase {
  type: 'mo:ended';
  payload: { reason: 'game-over' | 'completed' | 'user' | 'error'; score?: number; durationMs?: number };
}

export interface HostRequestMessage extends BridgeEnvelopeBase {
  type: 'mo:req';
  payload: { method: 'storage.get' | 'storage.set' | 'storage.remove' | 'storage.clear' | 'share' | 'open-link'; params?: unknown };
}

export type GameToHostMessage =
  | ReadyMessage
  | StartedMessage
  | LifecycleAckMessage
  | RestartedMessage
  | ScoreMessage
  | StorageRequestMessage
  | HeartbeatMessage
  | ErrorMessage
  | LogMessage
  | EndedMessage
  | HostRequestMessage;

export type BridgeMessage = HostToGameMessage | GameToHostMessage;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const envelope = {
  protocol: schema.literal(BRIDGE_PROTOCOL_VERSION),
  id: schema.string({ minLength: 6, maxLength: 64, pattern: /^[A-Za-z0-9_-]+$/ }),
};

const emptyPayload = schema.record(schema.json({ maxBytes: 64, maxDepth: 1 }), { maxKeys: 0 });

const remixParameterValuesShape = schema.record(
  schema.union<number | boolean | string>(
    schema.number({}),
    schema.boolean(),
    schema.string({ maxLength: 64 }),
  ),
  { maxKeys: 32 },
);

export const hostToGameShape: Shape<HostToGameMessage> = schema.union<HostToGameMessage>(
  schema.object({
    ...envelope,
    type: schema.literal('mo:init'),
    payload: schema.object({
      releaseId: schema.string({ minLength: 3, maxLength: 64 }),
      gameId: schema.string({ minLength: 3, maxLength: 64 }),
      gameTitle: schema.string({ minLength: 1, maxLength: 80 }),
      params: remixParameterValuesShape,
      capabilities: schema.array(schema.string({ maxLength: 32 }), { maxLength: 12 }),
      apiVersion: schema.string({ minLength: 1, maxLength: 8 }),
      locale: schema.string({ minLength: 2, maxLength: 20 }),
      viewport: schema.object({
        width: schema.number({ min: 1, max: 8192 }),
        height: schema.number({ min: 1, max: 8192 }),
        scale: schema.enum(['fit', 'cover', 'stretch'] as const),
      }),
      orientation: schema.enum(['portrait', 'landscape', 'any'] as const),
      muted: schema.boolean(),
      sessionId: schema.string({ minLength: 6, maxLength: 64 }),
      preview: schema.boolean(),
      limits: schema.object({
        heartbeatMs: schema.number({ min: 250, max: 60_000, integer: true }),
        maxMessageBytes: schema.number({ min: 512, max: 1024 * 1024, integer: true }),
        messagesPerSecond: schema.number({ min: 1, max: 1000, integer: true }),
      }),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.enum(['mo:start', 'mo:pause', 'mo:resume', 'mo:restart', 'mo:dispose'] as const),
    payload: emptyPayload.optional(),
  }),
  schema.object({ ...envelope, type: schema.literal('mo:mute'), payload: schema.object({ muted: schema.boolean() }) }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:visibility'),
    payload: schema.object({ visible: schema.boolean() }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:ping'),
    payload: schema.object({ nonce: schema.string({ minLength: 1, maxLength: 32 }) }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:res'),
    payload: schema.object({
      requestId: schema.string({ minLength: 6, maxLength: 64 }),
      ok: schema.boolean(),
      result: schema.json({ maxBytes: 4096 }).optional(),
      error: schema.string({ maxLength: 200 }).optional(),
    }),
  }),
) as unknown as Shape<HostToGameMessage>;

export const gameToHostShape: Shape<GameToHostMessage> = schema.union<GameToHostMessage>(
  schema.object({
    ...envelope,
    type: schema.literal('mo:ready'),
    payload: schema.object({
      sdkVersion: schema.string({ minLength: 1, maxLength: 32 }),
      capabilitiesUsed: schema.array(schema.string({ maxLength: 32 }), { maxLength: 12 }),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:started'),
    payload: schema.object({
      instanceId: schema.string({ minLength: 1, maxLength: 64 }),
      msToStart: schema.number({ min: 0, max: 600_000 }),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.enum(['mo:paused', 'mo:resumed'] as const),
    payload: emptyPayload.optional(),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:restarted'),
    payload: schema.object({
      instanceId: schema.string({ minLength: 1, maxLength: 64 }),
      instanceCount: schema.number({ min: 1, max: 500, integer: true }),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:score'),
    payload: schema.object({
      value: schema.number({ min: -1_000_000_000, max: 1_000_000_000 }),
      unit: schema.string({ maxLength: 16 }).optional(),
      difficulty: schema.string({ maxLength: 24 }).optional(),
      durationMs: schema.number({ min: 0, max: 24 * 60 * 60 * 1000 }).optional(),
      meta: schema.json({ maxBytes: 1024 }).optional(),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:storage'),
    payload: schema.object({
      op: schema.enum(['get', 'set', 'remove', 'clear'] as const),
      key: schema.string({ minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9._-]+$/ }).optional(),
      value: schema.json({ maxBytes: 4096 }).optional(),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:heartbeat'),
    payload: schema.object({
      instanceId: schema.string({ minLength: 1, maxLength: 64 }),
      frames: schema.number({ min: 0, max: 100_000_000, integer: true }),
      fps: schema.number({ min: 0, max: 1000 }).optional(),
      memoryMb: schema.number({ min: 0, max: 100_000 }).optional(),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:error'),
    payload: schema.object({
      message: schema.string({ minLength: 1, maxLength: 500 }),
      source: schema.string({ maxLength: 200 }).optional(),
      fatal: schema.boolean(),
      stack: schema.string({ maxLength: 2000 }).optional(),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:log'),
    payload: schema.object({
      level: schema.enum(['debug', 'info', 'warn', 'error'] as const),
      message: schema.string({ minLength: 1, maxLength: 500 }),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:ended'),
    payload: schema.object({
      reason: schema.enum(['game-over', 'completed', 'user', 'error'] as const),
      score: schema.number({ min: -1_000_000_000, max: 1_000_000_000 }).optional(),
      durationMs: schema.number({ min: 0, max: 24 * 60 * 60 * 1000 }).optional(),
    }),
  }),
  schema.object({
    ...envelope,
    type: schema.literal('mo:req'),
    payload: schema.object({
      method: schema.enum(['storage.get', 'storage.set', 'storage.remove', 'storage.clear', 'share', 'open-link'] as const),
      params: schema.json({ maxBytes: 1024, maxDepth: 3 }).optional(),
    }),
  }),
) as unknown as Shape<GameToHostMessage>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface BridgeParseOptions {
  maxBytes?: number;
}

export type BridgeParseResult<T> =
  | { ok: true; message: T; size: number }
  | { ok: false; reason: 'too_large' | 'not_an_object' | 'unknown_type' | 'invalid' | 'wrong_direction'; detail: string };

function parseEnvelope(
  data: unknown,
  direction: 'host-to-game' | 'game-to-host',
  options: BridgeParseOptions,
): BridgeParseResult<BridgeMessage> {
  const maxBytes = options.maxBytes ?? BRIDGE_MAX_MESSAGE_BYTES;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'not_an_object', detail: 'bridge messages must be objects' };
  }
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return { ok: false, reason: 'invalid', detail: 'message could not be serialized' };
  }
  if (size > maxBytes) {
    return { ok: false, reason: 'too_large', detail: `message of ${size} bytes exceeds the ${maxBytes} byte limit` };
  }
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !type.startsWith('mo:')) {
    return { ok: false, reason: 'invalid', detail: 'bridge messages require a "mo:" type' };
  }
  const shape = direction === 'host-to-game' ? hostToGameShape : gameToHostShape;
  const result = shape.parse(data, '');
  if (!result.ok) {
    return {
      ok: false,
      reason: 'invalid',
      detail: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ').slice(0, 400),
    };
  }
  return { ok: true, message: result.value, size };
}

/** Validate a message the host is about to send to a game. */
export function parseHostToGame(data: unknown, options: BridgeParseOptions = {}): BridgeParseResult<HostToGameMessage> {
  const result = parseEnvelope(data, 'host-to-game', options);
  if (!result.ok) return result;
  return { ok: true, message: result.message as HostToGameMessage, size: result.size };
}

/** Validate a message a game sent to the host. Never trusted for authorization. */
export function parseGameToHost(data: unknown, options: BridgeParseOptions = {}): BridgeParseResult<GameToHostMessage> {
  const result = parseEnvelope(data, 'game-to-host', options);
  if (!result.ok) return result;
  return { ok: true, message: result.message as GameToHostMessage, size: result.size };
}

/** Simple per-sender token bucket used to rate limit bridge traffic. */
export class MessageRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private ratePerSecond: number;
  private burst: number;
  private now: () => number;

  constructor(ratePerSecond: number, burst: number = ratePerSecond, now: () => number = () => Date.now()) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.lastRefill = now();
  }

  take(count = 1): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.ratePerSecond);
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Headroom for diagnostics/UIs. */
  available(): number {
    return Math.floor(this.tokens);
  }
}

export function newBridgeId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * The host <-> game bridge: the only channel across the sandbox boundary. The
 * rules that matter are "reject by default" (unknown types and unknown keys are
 * errors, never ignored) and bounded traffic (size cap plus a token bucket).
 */

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  gameToHostShape,
  hostToGameShape,
  MessageRateLimiter,
  newBridgeId,
  parseGameToHost,
  parseHostToGame,
  type BridgeParseResult,
  type GameInitConfig,
  type GameToHostMessage,
  type HostToGameMessage,
} from '@moydan/core';

const ENVELOPE = { protocol: BRIDGE_PROTOCOL_VERSION, id: 'msg-000001' };

const INIT_PAYLOAD: GameInitConfig = {
  releaseId: 'rel_0123456789abcdef',
  gameId: 'gam_0123456789abcdef',
  gameTitle: 'Bounce Dodge',
  params: { speed: 1.5, shake: true, accent: '#7c5cff' },
  capabilities: ['score', 'storage'],
  apiVersion: '1',
  locale: 'en-GB',
  viewport: { width: 720, height: 1280, scale: 'fit' },
  orientation: 'portrait',
  muted: false,
  sessionId: 'sess-0123456789',
  preview: false,
  limits: { heartbeatMs: 2000, maxMessageBytes: 8192, messagesPerSecond: 30 },
};

const HOST_TO_GAME: HostToGameMessage[] = [
  { ...ENVELOPE, type: 'mo:init', payload: INIT_PAYLOAD },
  { ...ENVELOPE, type: 'mo:start' },
  { ...ENVELOPE, type: 'mo:start', payload: {} },
  { ...ENVELOPE, type: 'mo:pause' },
  { ...ENVELOPE, type: 'mo:resume' },
  { ...ENVELOPE, type: 'mo:restart' },
  { ...ENVELOPE, type: 'mo:dispose' },
  { ...ENVELOPE, type: 'mo:mute', payload: { muted: true } },
  { ...ENVELOPE, type: 'mo:visibility', payload: { visible: false } },
  { ...ENVELOPE, type: 'mo:ping', payload: { nonce: 'n-1' } },
  { ...ENVELOPE, type: 'mo:res', payload: { requestId: 'req-000001', ok: true, result: { score: 3 } } },
  { ...ENVELOPE, type: 'mo:res', payload: { requestId: 'req-000001', ok: false, error: 'not allowed' } },
];

const GAME_TO_HOST: GameToHostMessage[] = [
  { ...ENVELOPE, type: 'mo:ready', payload: { sdkVersion: '1.0.0', capabilitiesUsed: ['score'] } },
  { ...ENVELOPE, type: 'mo:started', payload: { instanceId: 'i-1', msToStart: 120 } },
  { ...ENVELOPE, type: 'mo:paused', payload: {} },
  { ...ENVELOPE, type: 'mo:resumed', payload: {} },
  { ...ENVELOPE, type: 'mo:restarted', payload: { instanceId: 'i-2', instanceCount: 2 } },
  { ...ENVELOPE, type: 'mo:score', payload: { value: 42, unit: 'points', difficulty: 'normal', durationMs: 60_000 } },
  { ...ENVELOPE, type: 'mo:storage', payload: { op: 'get', key: 'best' } },
  { ...ENVELOPE, type: 'mo:storage', payload: { op: 'set', key: 'best', value: { score: 9 } } },
  { ...ENVELOPE, type: 'mo:storage', payload: { op: 'clear' } },
  { ...ENVELOPE, type: 'mo:heartbeat', payload: { instanceId: 'i-1', frames: 120, fps: 60, memoryMb: 24 } },
  { ...ENVELOPE, type: 'mo:error', payload: { message: 'boom', fatal: true, source: 'main.ts' } },
  { ...ENVELOPE, type: 'mo:log', payload: { level: 'warn', message: 'slow frame' } },
  { ...ENVELOPE, type: 'mo:ended', payload: { reason: 'game-over', score: 42, durationMs: 61_000 } },
  { ...ENVELOPE, type: 'mo:req', payload: { method: 'storage.set', params: { key: 'best', value: 3 } } },
];

/** Narrow a parse result that the test expects to be a rejection. */
function rejected<T>(result: BridgeParseResult<T>): { reason: string; detail: string } {
  if (result.ok) throw new Error(`expected the message to be rejected, got ${JSON.stringify(result.message)}`);
  return result;
}

describe('host -> game messages', () => {
  it.each(HOST_TO_GAME.map((message, index) => [message.type, index] as const))(
    'accepts %s',
    (_type, index) => {
      const message = HOST_TO_GAME[index];
      expect(message).toBeDefined();
      const result = parseHostToGame(message);
      expect(result.ok).toBe(true);
    },
  );

  it('reports the serialized size of an accepted message', () => {
    const result = parseHostToGame(HOST_TO_GAME[0]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.size).toBe(JSON.stringify(HOST_TO_GAME[0]).length);
  });

  it('rejects a message that is not a plain object', () => {
    expect(rejected(parseHostToGame('mo:start')).reason).toBe('not_an_object');
    expect(rejected(parseHostToGame(null)).reason).toBe('not_an_object');
    expect(rejected(parseHostToGame([{ ...ENVELOPE, type: 'mo:start' }])).reason).toBe('not_an_object');
  });

  it('rejects a type outside the mo: namespace', () => {
    const result = rejected(parseHostToGame({ ...ENVELOPE, type: 'start' }));
    expect(result.detail).toContain('mo:');
  });

  it('rejects an unknown type', () => {
    expect(rejected(parseHostToGame({ ...ENVELOPE, type: 'mo:teleport' })).reason).toBe('invalid');
  });

  it('rejects an unknown key, so nothing can be smuggled through extra fields', () => {
    // Both directions are `union` shapes, so a failed variant reports one generic
    // issue; the assertion that matters is "rejected, not silently accepted".
    expect(parseHostToGame({ ...ENVELOPE, type: 'mo:start' }).ok).toBe(true);
    expect(rejected(parseHostToGame({ ...ENVELOPE, type: 'mo:start', extra: 'payload' })).reason).toBe('invalid');
  });

  it('rejects a wrong protocol version', () => {
    expect(parseHostToGame({ protocol: 2, id: 'msg-000001', type: 'mo:start' }).ok).toBe(false);
  });

  it('rejects a malformed correlation id', () => {
    expect(parseHostToGame({ ...ENVELOPE, id: 'a b', type: 'mo:start' }).ok).toBe(false);
    expect(parseHostToGame({ ...ENVELOPE, id: 'x', type: 'mo:start' }).ok).toBe(false);
  });

  it('rejects a non-empty payload on a bare lifecycle command', () => {
    expect(parseHostToGame({ ...ENVELOPE, type: 'mo:start', payload: { speed: 2 } }).ok).toBe(false);
  });

  it('rejects out-of-contract init values', () => {
    const result = rejected(
      parseHostToGame({
        ...ENVELOPE,
        type: 'mo:init',
        payload: { ...INIT_PAYLOAD, viewport: { width: 720, height: 1280, scale: 'squish' } },
      }),
    );
    expect(result.reason).toBe('invalid');
  });

  it('rejects a message larger than the byte cap', () => {
    const result = rejected(
      parseHostToGame({
        ...ENVELOPE,
        type: 'mo:res',
        payload: { requestId: 'req-000001', ok: true, result: 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES) },
      }),
    );
    expect(result.reason).toBe('too_large');
    expect(result.detail).toContain('exceeds');
  });

  it('honours a caller-supplied byte cap', () => {
    expect(rejected(parseHostToGame({ ...ENVELOPE, type: 'mo:ping', payload: { nonce: 'n' } }, { maxBytes: 16 })).reason).toBe(
      'too_large',
    );
  });
});

describe('game -> host messages', () => {
  it.each(GAME_TO_HOST.map((message, index) => [message.type, index] as const))(
    'accepts %s',
    (_type, index) => {
      const message = GAME_TO_HOST[index];
      expect(message).toBeDefined();
      expect(parseGameToHost(message).ok).toBe(true);
    },
  );

  it('rejects a host message arriving in the wrong direction', () => {
    expect(rejected(parseGameToHost({ ...ENVELOPE, type: 'mo:start' })).reason).toBe('invalid');
  });

  it('rejects an unknown type', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:whatever' }).ok).toBe(false);
  });

  it('rejects an unknown key inside a payload', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:score', payload: { value: 1 } }).ok).toBe(true);
    expect(rejected(parseGameToHost({ ...ENVELOPE, type: 'mo:score', payload: { value: 1, cheat: true } })).reason).toBe(
      'invalid',
    );
  });

  it('rejects a score outside the accepted range', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:score', payload: { value: Number.MAX_SAFE_INTEGER } }).ok).toBe(
      false,
    );
  });

  it('rejects a storage key that is not a plain identifier', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:storage', payload: { op: 'get', key: '../secret' } }).ok).toBe(
      false,
    );
  });

  it('rejects a lifecycle event with no payload', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:heartbeat', payload: { frames: 1 } }).ok).toBe(false);
  });

  it('rejects an out-of-contract log level', () => {
    expect(parseGameToHost({ ...ENVELOPE, type: 'mo:log', payload: { level: 'fatal', message: 'x' } }).ok).toBe(false);
  });

  it('rejects a message larger than the byte cap', () => {
    const result = rejected(
      parseGameToHost({
        ...ENVELOPE,
        type: 'mo:log',
        payload: { level: 'info', message: 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES) },
      }),
    );
    expect(result.reason).toBe('too_large');
  });
});

describe('prototype pollution', () => {
  // `JSON.parse` is the realistic source of an own `__proto__` key: a literal in
  // source would set the prototype instead.
  const pollutedEnvelope = (key: string, type: string, payload?: unknown): unknown =>
    JSON.parse(
      `{"${key}":{"polluted":true},"protocol":1,"id":"msg-000001","type":"${type}"${payload ? `,"payload":${JSON.stringify(payload)}` : ''}}`,
    );

  it.each(['__proto__', 'constructor', 'prototype'])('rejects %s as an envelope key', (key) => {
    expect(parseHostToGame(pollutedEnvelope(key, 'mo:start')).ok).toBe(false);
    expect(parseGameToHost(pollutedEnvelope(key, 'mo:ready', { sdkVersion: '1', capabilitiesUsed: [] })).ok).toBe(
      false,
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a polluting key on the init payload', () => {
    const message = JSON.parse(
      `{"protocol":1,"id":"msg-000001","type":"mo:init","__proto__":{"polluted":true},"payload":${JSON.stringify(INIT_PAYLOAD)}}`,
    );
    expect(parseHostToGame(message).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a polluting key inside the remix parameter record', () => {
    const message = JSON.parse(
      `{"protocol":1,"id":"msg-000001","type":"mo:init","payload":${JSON.stringify({
        ...INIT_PAYLOAD,
        params: { speed: 1 },
      })},"__proto__":{"polluted":true}}`,
    );
    expect(parseHostToGame(message).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('exposes the raw shapes for a receiver that wants to validate without the helpers', () => {
    expect(hostToGameShape.validate({ ...ENVELOPE, type: 'mo:start' }).ok).toBe(true);
    expect(
      gameToHostShape.validate({ ...ENVELOPE, type: 'mo:started', payload: { instanceId: 'i', msToStart: 1 } }).ok,
    ).toBe(true);
  });
});

describe('newBridgeId', () => {
  it('produces distinct, envelope-safe correlation ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newBridgeId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id.length).toBeGreaterThanOrEqual(6);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('MessageRateLimiter', () => {
  it('allows the whole burst immediately', () => {
    let now = 1_000;
    const limiter = new MessageRateLimiter(10, 10, () => now);
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.take()).toBe(true);
    }
    expect(limiter.take()).toBe(false);
    now += 1;
  });

  it('refills at the configured rate', () => {
    let now = 0;
    const limiter = new MessageRateLimiter(10, 10, () => now);
    for (let index = 0; index < 10; index += 1) limiter.take();
    now = 100;
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('caps the bucket at the burst size', () => {
    let now = 0;
    const limiter = new MessageRateLimiter(10, 3, () => now);
    now = 60_000;
    expect(limiter.available()).toBe(3);
    for (let index = 0; index < 3; index += 1) expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('charges a caller that asks for several tokens at once', () => {
    let now = 0;
    const limiter = new MessageRateLimiter(10, 5, () => now);
    expect(limiter.take(5)).toBe(true);
    expect(limiter.take(1)).toBe(false);
    now = 200;
    expect(limiter.take(2)).toBe(true);
    expect(limiter.take(1)).toBe(false);
  });

  it('never goes negative when the clock moves backwards', () => {
    let now = 5_000;
    const limiter = new MessageRateLimiter(10, 10, () => now);
    for (let index = 0; index < 10; index += 1) limiter.take();
    now = 1_000;
    expect(limiter.take()).toBe(false);
    expect(limiter.available()).toBe(0);
  });
});
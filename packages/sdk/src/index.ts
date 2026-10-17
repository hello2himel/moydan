/**
 * Moydan SDK v1 - the creator-facing runtime contract.
 *
 * A game is an ES module that imports `defineGame` from `@moydan/sdk` and
 * describes how to create a game instance. The platform serves this module from
 * the game origin (`/sdk/v1/index.js`) and the artifact shell import-maps
 * `@moydan/sdk` to that URL, so a build never inlines a second copy of the
 * bridge and every release always speaks the same protocol version.
 *
 * Responsibilities kept inside the SDK (so creators cannot get them wrong):
 *   - the postMessage handshake with the host (`mo:ready` ... `mo:init` ...);
 *   - lifecycle commands (start/pause/resume/dispose) and their acknowledgements;
 *   - schema validation of every message the host sends (via @moydan/core);
 *   - outgoing message rate limiting and payload size ceiling;
 *   - a request/response channel for host-mediated capabilities (storage, share);
 *   - a pause-aware render loop that survives backgrounded tabs and throttling.
 *
 * The SDK never has network access: everything goes through the host.
 */

import {
  BRIDGE_MESSAGE_PREFIX,
  BRIDGE_MESSAGES_PER_SECOND,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  MessageRateLimiter,
  SDK_VERSION,
  newBridgeId,
  parseHostToGame,
  type GameInitConfig,
  type RemixParameterValues,
} from '@moydan/core';

export const PF_SDK_VERSION = SDK_VERSION;

export interface ViewportSpec {
  width: number;
  height: number;
  scale: 'fit' | 'cover' | 'stretch';
}

export interface ScoreOptions {
  unit?: string;
  difficulty?: string;
  durationMs?: number;
  meta?: unknown;
}

export interface EndOptions {
  reason?: 'game-over' | 'completed' | 'user' | 'error';
  score?: number;
  durationMs?: number;
}

export interface MoydanStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GameLoopHandle {
  stop(): void;
  readonly running: boolean;
}

/**
 * Everything a game instance may use. The platform host fills this in from the
 * release manifest and the current play session.
 */
export interface GameApi {
  /** Immutable remix parameter values for this release (defaults merged in). */
  readonly params: RemixParameterValues;
  /** Capabilities the host actually grants (intersection of manifest and policy). */
  readonly capabilities: readonly string[];
  readonly viewport: ViewportSpec;
  readonly orientation: 'portrait' | 'landscape' | 'any';
  /** Opaque play session id; never persist it. */
  readonly sessionId: string;
  readonly preview: boolean;
  /** Element the game should render into. Game-owned, empty on creation. */
  readonly root: HTMLElement;
  /** Submitted scores are attributed to the current play session. */
  score(value: number, options?: ScoreOptions): void;
  /** Signal that the current run ended (game over / completed). */
  ended(options?: EndOptions): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  reportError(message: string, options?: { fatal?: boolean; source?: string; stack?: string }): void;
  /** Pause-aware requestAnimationFrame loop bound to the host lifecycle. */
  createLoop(step: (deltaMs: number, elapsedMs: number) => void): GameLoopHandle;
  /** Host-mediated, per-game persistent storage. Values are JSON. */
  readonly storage: MoydanStorage;
  /** True while the host muted the game. */
  readonly muted: boolean;
}

export interface GameInstance {
  /** Called when the host starts (or restarts) the game. */
  start(): void | Promise<void>;
  /** Stop simulating; must be idempotent. */
  pause?(): void;
  resume?(): void;
  /** Free resources. The instance is never reused after dispose. */
  dispose?(): void;
  /** The host paused/resumed audio. */
  mute?(muted: boolean): void;
  /** The host reports tab/browser visibility changes. */
  visibility?(visible: boolean): void;
}

export interface GameDefinition {
  /** Called exactly once per instance, after `mo:init`. */
  create(api: GameApi): GameInstance | Promise<GameInstance>;
}

type OutgoingMessage = { type: string; payload?: unknown };

/** Errors thrown while a game is being created surface through this hook. */
let onFatal: ((error: unknown) => void) | null = null;

export function setFatalErrorHandler(handler: ((error: unknown) => void) | null): void {
  onFatal = handler;
}

const HANDSHAKE_RETRY_MS = 400;
const HANDSHAKE_MAX_ATTEMPTS = 40;
const HOST_REQUEST_TIMEOUT_MS = 8_000;

export function defineGame(definition: GameDefinition): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('defineGame() must run inside a browser document');
  }
  boot(definition);
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function boot(definition: GameDefinition): void {
  let config: GameInitConfig | null = null;
  let instance: GameInstance | null = null;
  let createPromise: Promise<GameInstance> | null = null;
  let root: HTMLElement | null = null;
  let muted = false;
  let disposed = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeAttempts = 0;
  let startedAt = 0;

  const rateLimiter = new MessageRateLimiter(BRIDGE_MESSAGES_PER_SECOND);
  const pending = new Map<string, PendingRequest>();
  const loops = new Set<LoopImpl>();

  function send(message: OutgoingMessage, options: { critical?: boolean; id?: string } = {}): boolean {
    if (disposed) return false;
    const envelope = {
      protocol: BRIDGE_PROTOCOL_VERSION,
      id: options.id ?? newBridgeId(),
      type: `${BRIDGE_MESSAGE_PREFIX}:${message.type.replace(/^mo:/, '')}`,
      ...(message.payload === undefined ? {} : { payload: message.payload }),
    };
    let size: number;
    try {
      size = JSON.stringify(envelope).length;
    } catch {
      return false;
    }
    if (size > BRIDGE_MAX_MESSAGE_BYTES) {
      console.warn('[moydan] dropping oversized message', size);
      return false;
    }
    if (!rateLimiter.take() && !options.critical) {
      console.warn('[moydan] dropping message: outgoing rate limit exceeded');
      return false;
    }
    window.parent.postMessage(envelope, '*');
    return true;
  }

  function sendReady(): void {
    send({ type: 'mo:ready', payload: { sdkVersion: PF_SDK_VERSION, capabilitiesUsed: [] } }, { critical: true });
  }

  function stopHandshake(): void {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function scheduleHandshake(): void {
    stopHandshake();
    if (config || disposed) return;
    if (handshakeAttempts >= HANDSHAKE_MAX_ATTEMPTS) {
      console.error('[moydan] host never answered the ready handshake');
      return;
    }
    handshakeAttempts += 1;
    sendReady();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      scheduleHandshake();
    }, HANDSHAKE_RETRY_MS);
  }

  function request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = newBridgeId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`host request "${method}" timed out`));
      }, HOST_REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      if (!send({ type: 'mo:req', payload: { method, params } }, { critical: true, id })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('could not reach the host'));
      }
    });
  }

  class LoopImpl implements GameLoopHandle {
    private step: (deltaMs: number, elapsedMs: number) => void;
    private frame = 0;
    private last = 0;
    private elapsed = 0;
    private active = false;
    private stopped = false;

    constructor(step: (deltaMs: number, elapsedMs: number) => void) {
      this.step = step;
    }

    get running(): boolean {
      return this.active;
    }

    begin(): void {
      if (this.stopped || this.active) return;
      this.active = true;
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }

    suspend(): void {
      if (!this.active) return;
      this.active = false;
      cancelAnimationFrame(this.frame);
    }

    /** Advance exactly one frame (used by deterministic tests). */
    stepOnce(deltaMs = 16.6): void {
      this.elapsed += deltaMs;
      this.step(deltaMs, this.elapsed);
    }

    stop(): void {
      this.stopped = true;
      this.suspend();
      loops.delete(this);
    }

    private tick = (now: number): void => {
      if (!this.active) return;
      const delta = Math.min(100, Math.max(0, now - this.last));
      this.last = now;
      this.elapsed += delta;
      try {
        this.step(delta, this.elapsed);
      } catch (error) {
        this.stop();
        fatal(error);
        return;
      }
      this.frame = requestAnimationFrame(this.tick);
    };
  }

  const api: GameApi = {
    get params() {
      return config?.params ?? {};
    },
    get capabilities() {
      return config?.capabilities ?? [];
    },
    get viewport() {
      return config?.viewport ?? { width: 320, height: 480, scale: 'fit' as const };
    },
    get orientation() {
      return config?.orientation ?? 'portrait';
    },
    get sessionId() {
      return config?.sessionId ?? '';
    },
    get preview() {
      return config?.preview ?? false;
    },
    get muted() {
      return muted;
    },
    get root() {
      if (!root) throw new Error('the game root element is only available after init');
      return root;
    },
    score(value, options) {
      if (!Number.isFinite(value)) return;
      send({
        type: 'mo:score',
        payload: {
          value,
          ...(options?.unit ? { unit: options.unit.slice(0, 16) } : {}),
          ...(options?.difficulty ? { difficulty: options.difficulty.slice(0, 24) } : {}),
          ...(options?.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(options.durationMs)) } : {}),
          ...(options?.meta !== undefined ? { meta: safeMeta(options.meta) } : {}),
        },
      });
    },
    ended(options) {
      send(
        {
          type: 'mo:ended',
          payload: {
            reason: options?.reason ?? 'game-over',
            ...(options?.score !== undefined ? { score: options.score } : {}),
            ...(options?.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(options.durationMs)) } : {}),
          },
        },
        { critical: true },
      );
    },
    log(level, message) {
      send({ type: 'mo:log', payload: { level, message: String(message).slice(0, 500) } });
    },
    reportError(message, options) {
      send(
        {
          type: 'mo:error',
          payload: {
            message: String(message).slice(0, 500),
            fatal: options?.fatal ?? false,
            ...(options?.source ? { source: options.source.slice(0, 200) } : {}),
            ...(options?.stack ? { stack: options.stack.slice(0, 2000) } : {}),
          },
        },
        { critical: true },
      );
    },
    createLoop(step) {
      const loop = new LoopImpl(step);
      loops.add(loop);
      return loop;
    },
    storage: {
      async get<T>(key: string) {
        return (await request('storage.get', { key })) as T | undefined;
      },
      async set(key: string, value: unknown) {
        await request('storage.set', { key, value });
      },
      async remove(key: string) {
        await request('storage.remove', { key });
      },
      async clear() {
        await request('storage.clear', {});
      },
    },
  };

  function fatal(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[moydan]', error);
    if (onFatal) onFatal(error);
    try {
      send({ type: 'mo:error', payload: { message, fatal: true, ...(stack ? { stack: stack.slice(0, 2000) } : {}) } }, { critical: true });
      send({ type: 'mo:ended', payload: { reason: 'error' } }, { critical: true });
    } catch {
      // Nothing else we can do from inside a broken game.
    }
    for (const loop of [...loops]) loop.stop();
  }

  async function ensureInstance(): Promise<GameInstance> {
    if (instance) return instance;
    if (!config) throw new Error('game used before init');
    if (!createPromise) {
      createPromise = (async () => {
        const element = document.createElement('div');
        element.id = 'moydan-game';
        element.style.cssText = 'position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none;';
        document.body.appendChild(element);
        root = element;
        try {
          const created = await definition.create(api);
          instance = created;
          return created;
        } catch (error) {
          createPromise = null;
          fatal(error);
          throw error;
        }
      })();
    }
    return createPromise;
  }

  function suspendLoops(): void {
    for (const loop of loops) loop.suspend();
  }

  function resumeLoops(): void {
    for (const loop of loops) loop.begin();
  }

  function applyVisibility(): void {
    const visible = typeof document.visibilityState === 'string' ? document.visibilityState === 'visible' : true;
    instance?.visibility?.(visible);
    if (!visible) suspendLoops();
    else if (instance) resumeLoops();
  }

  document.addEventListener('visibilitychange', applyVisibility);

  window.addEventListener('error', (event) => {
    fatal(event.error ?? new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    fatal(event.reason ?? new Error('unhandled promise rejection'));
  });

  window.addEventListener('message', (event) => {
    if (disposed) return;
    const parsed = parseHostToGame(event.data);
    if (!parsed.ok) {
      // Unknown or malformed host messages are ignored: another script on the
      // page (or a hostile parent) must not be able to drive the game.
      if (parsed.reason !== 'not_an_object') {
        console.debug('[moydan] ignored host message:', parsed.reason, parsed.detail);
      }
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'mo:init': {
        if (config) return;
        config = message.payload;
        muted = message.payload.muted;
        stopHandshake();
        void ensureInstance().catch(() => {});
        return;
      }
      case 'mo:start': {
        void (async () => {
          const active = await ensureInstance();
          startedAt = performance.now();
          await active.start();
          resumeLoops();
          send(
            {
              type: 'mo:started',
              payload: { instanceId: api.sessionId || 'instance', msToStart: Math.round(performance.now() - startedAt) },
            },
            { critical: true },
          );
        })().catch(() => {});
        return;
      }
      case 'mo:pause': {
        suspendLoops();
        instance?.pause?.();
        send({ type: 'mo:paused', payload: {} }, { critical: true });
        return;
      }
      case 'mo:resume': {
        instance?.resume?.();
        resumeLoops();
        send({ type: 'mo:resumed', payload: {} }, { critical: true });
        return;
      }
      case 'mo:restart': {
        void (async () => {
          suspendLoops();
          instance?.dispose?.();
          instance = null;
          createPromise = null;
          if (root) {
            root.remove();
            root = null;
          }
          const active = await ensureInstance();
          await active.start();
          resumeLoops();
          send({ type: 'mo:restarted', payload: { instanceId: api.sessionId || 'instance', instanceCount: 1 } }, { critical: true });
        })().catch(() => {});
        return;
      }
      case 'mo:mute': {
        muted = message.payload.muted;
        instance?.mute?.(muted);
        return;
      }
      case 'mo:visibility': {
        instance?.visibility?.(message.payload.visible);
        if (message.payload.visible) resumeLoops();
        else suspendLoops();
        return;
      }
      case 'mo:dispose': {
        disposeGame();
        return;
      }
      case 'mo:res': {
        const entry = pending.get(message.payload.requestId);
        if (!entry) return;
        pending.delete(message.payload.requestId);
        clearTimeout(entry.timer);
        if (message.payload.ok) entry.resolve(message.payload.result);
        else entry.reject(new Error(message.payload.error ?? 'host request failed'));
        return;
      }
      case 'mo:ping': {
        return;
      }
    }
  });

  function disposeGame(): void {
    if (disposed) return;
    disposed = true;
    stopHandshake();
    document.removeEventListener('visibilitychange', applyVisibility);
    for (const loop of [...loops]) loop.stop();
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('game disposed'));
      pending.delete(id);
    }
    try {
      instance?.dispose?.();
    } finally {
      instance = null;
      root?.remove();
      root = null;
    }
  }

  scheduleHandshake();
}

function safeMeta(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > 1024) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Canvas helper
// ---------------------------------------------------------------------------

export interface CanvasSetup {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Design-space width/height (viewport from the manifest). */
  width: number;
  height: number;
  /** Stop tracking resizes. */
  dispose(): void;
}

/**
 * Create a DPR-aware canvas that always covers its container while keeping the
 * design resolution from the manifest. Games draw in design coordinates.
 */
export function setupCanvas(api: GameApi, options: { className?: string } = {}): CanvasSetup {
  const canvas = document.createElement('canvas');
  if (options.className) canvas.className = options.className;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  api.root.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser');
  const { width, height, scale } = api.viewport;

  const resize = (): void => {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const container = api.root.getBoundingClientRect();
    const cssWidth = Math.max(1, container.width);
    const cssHeight = Math.max(1, container.height);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const factor = scale === 'stretch' ? null : scale === 'cover' ? Math.max(cssWidth / width, cssHeight / height) : Math.min(cssWidth / width, cssHeight / height);
    const scaleX = (factor ?? cssWidth / width) * dpr;
    const scaleY = (factor ?? cssHeight / height) * dpr;
    const offsetX = (canvas.width - width * scaleX) / 2;
    const offsetY = (canvas.height - height * scaleY) / 2;
    ctx.setTransform(scaleX, 0, 0, scaleY, offsetX, offsetY);
  };

  resize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(api.root);
  window.addEventListener('resize', resize);

  return {
    canvas,
    ctx,
    width,
    height,
    dispose() {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    },
  };
}

/** Deterministic pseudo random generator available to games that want replays. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

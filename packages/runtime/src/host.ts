/**
 * Game host: the application side of the sandbox boundary.
 *
 * The host is the *only* code allowed to embed a game. It:
 *   - creates the sandboxed iframe on the dedicated game origin;
 *   - performs the handshake (`mo:ready` -> `mo:init` -> `mo:start`);
 *   - validates every message the game sends against the shared schemas and
 *     drops anything malformed, oversized or rate-limited;
 *   - mediates privileged operations (storage, share, link-out) with explicit
 *     policies instead of exposing browser APIs inside the sandbox;
 *   - drives playback lifecycle from page visibility and feed position.
 *
 * Messages are never trusted for authorization: a score sent from a game is an
 * unverified claim and is stored as such.
 */

import {
  BRIDGE_MESSAGES_PER_SECOND,
  BRIDGE_PROTOCOL_VERSION,
  MessageRateLimiter,
  newBridgeId,
  parseGameToHost,
  parseHostToGame,
  type GameToHostMessage,
  type HostToGameMessage,
  type RemixParameterValues,
} from '@moydan/core';

export type HostState = 'idle' | 'loading' | 'ready' | 'running' | 'paused' | 'ended' | 'error' | 'disposed';

export interface GameHostOptions {
  /** Element the iframe is appended to. */
  container: HTMLElement;
  /** Absolute URL of the release entry document on the game origin. */
  src: string;
  /** Origin of `src`, used to authenticate incoming messages. */
  gameOrigin: string;
  gameId: string;
  releaseId: string;
  gameTitle: string;
  params: RemixParameterValues;
  capabilities: string[];
  apiVersion: string;
  viewport: { width: number; height: number; scale: 'fit' | 'cover' | 'stretch' };
  orientation: 'portrait' | 'landscape' | 'any';
  sessionId: string;
  preview?: boolean;
  muted?: boolean;
  locale?: string;
  /** Max heartbeat interval granted to the game (ms). */
  heartbeatMs?: number;
  onScore?: (payload: { value: number; unit?: string; difficulty?: string; durationMs?: number; meta?: unknown }) => void;
  onEnded?: (payload: { reason: string; score?: number; durationMs?: number }) => void;
  onError?: (payload: { message: string; fatal: boolean; source?: string }) => void;
  onLog?: (payload: { level: string; message: string }) => void;
  onFirstFrame?: () => void;
  onStateChange?: (state: HostState) => void;
  onShare?: (params: unknown) => Promise<{ ok: boolean; error?: string }>;
  onOpenLink?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

const MAX_STORAGE_VALUE_BYTES = 4 * 1024;
const MAX_STORAGE_KEYS = 32;

export class GameHost {
  readonly iframe: HTMLIFrameElement | null = null;
  state: HostState = 'idle';

  private options: GameHostOptions;
  private limiter = new MessageRateLimiter(BRIDGE_MESSAGES_PER_SECOND);
  private listeners: Array<() => void> = [];
  private frame: HTMLIFrameElement | null = null;
  private startRequested = false;
  private disposed = false;
  private muted: boolean;
  private heartbeat = { frames: 0, fps: 0, receivedAt: 0 };
  private firstFrameSeen = false;

  constructor(options: GameHostOptions) {
    this.options = options;
    this.muted = options.muted ?? false;
    const onMessage = (event: MessageEvent) => this.handleMessage(event);
    window.addEventListener('message', onMessage);
    this.listeners.push(() => window.removeEventListener('message', onMessage));
  }

  /** Create the iframe and begin the handshake. Safe to call once. */
  start(): void {
    if (this.disposed || this.state === 'disposed') return;
    this.startRequested = true;
    if (!this.frame) {
      this.setState('loading');
      const frame = document.createElement('iframe');
      frame.setAttribute('title', `${this.options.gameTitle} (game)`);
      // `allow-same-origin` is deliberately included: the sandboxed document is
      // served from the dedicated game origin, which is a *different* origin
      // from the application. Without it module scripts would be treated as
      // cross-origin requests and the release could not load its own files.
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
      frame.setAttribute('allow', 'autoplay; fullscreen; gamepad; vibrate');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('loading', 'eager');
      frame.className = 'pf-game-frame';
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0b0b12;';
      frame.src = this.options.src;
      frame.addEventListener('load', () => {
        // The SDK re-sends `mo:ready` until it sees `mo:init`, so a load event
        // racing the handshake cannot leave the game waiting forever.
      });
      this.frame = frame;
      this.options.container.appendChild(frame);
    }
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.send({ type: 'mo:pause' });
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.send({ type: 'mo:resume' });
    this.setState('running');
  }

  restart(): void {
    if (this.disposed) return;
    this.send({ type: 'mo:restart' });
    this.setState('running');
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.send({ type: 'mo:mute', payload: { muted } });
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * True when the iframe is displaying the given release. Used by the feed to
   * avoid restarting an already-correct game.
   */
  isShowing(releaseId: string): boolean {
    return this.options.releaseId === releaseId && this.frame !== null;
  }

  stats(): { frames: number; fps: number; heartbeatAgeMs: number } {
    return {
      frames: this.heartbeat.frames,
      fps: this.heartbeat.fps,
      heartbeatAgeMs: this.heartbeat.receivedAt ? Date.now() - this.heartbeat.receivedAt : Number.POSITIVE_INFINITY,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) {
      try {
        this.send({ type: 'mo:dispose' });
      } catch {
        // The frame may already be gone.
      }
    }
    for (const off of this.listeners) off();
    this.listeners = [];
    this.frame?.remove();
    this.frame = null;
    this.setState('disposed');
  }

  private setState(state: HostState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  /**
   * Send a command to the game.
   *
   * The envelope (`protocol` + a host-generated `id`) is added here rather than at
   * every call site: correlation ids must come from the host and must never be
   * forgeable by the game, so callers only describe *what* they want to say. The
   * assembled message is then validated with the same schema the SDK uses, so a
   * host-side bug can never put an invalid message on the wire.
   */
  private send(message: { type: HostToGameMessage['type']; payload?: unknown; protocol?: number; id?: string }): void {
    const frame = this.frame;
    if (!frame || !frame.contentWindow) return;
    const envelope = { ...message, protocol: BRIDGE_PROTOCOL_VERSION, id: newBridgeId() };
    const parsed = parseHostToGame(envelope);
    if (!parsed.ok) {
      // A programming error on the host side: refuse to send a message that
      // does not satisfy the contract every SDK validates.
      console.error('[moydan host] refusing to send invalid message', parsed.reason, parsed.detail, envelope);
      return;
    }
    frame.contentWindow.postMessage(parsed.message, this.options.gameOrigin);
  }

  private nextId(): string {
    return newBridgeId();
  }

  private handleMessage(event: MessageEvent): void {
    if (this.disposed) return;
    const frame = this.frame;
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.origin !== this.options.gameOrigin) return;

    const parsed = parseGameToHost(event.data);
    if (!parsed.ok) {
      if (parsed.reason !== 'not_an_object') {
        console.warn('[moydan host] dropped game message:', parsed.reason, parsed.detail);
      }
      return;
    }
    const message = parsed.message as GameToHostMessage;
    if (!this.allow(message)) return;
    switch (message.type) {
      case 'mo:ready': {
        this.setState(this.state === 'loading' ? 'ready' : this.state);
        this.initialize();
        return;
      }
      case 'mo:started': {
        this.setState('running');
        return;
      }
      case 'mo:paused': {
        this.setState('paused');
        return;
      }
      case 'mo:resumed': {
        this.setState('running');
        return;
      }
      case 'mo:restarted': {
        this.setState('running');
        return;
      }
      case 'mo:heartbeat': {
        this.heartbeat = {
          frames: message.payload.frames,
          fps: message.payload.fps ?? this.heartbeat.fps,
          receivedAt: Date.now(),
        };
        if (!this.firstFrameSeen && message.payload.frames > 0) {
          this.firstFrameSeen = true;
          this.options.onFirstFrame?.();
        }
        return;
      }
      case 'mo:score': {
        this.options.onScore?.(message.payload);
        return;
      }
      case 'mo:ended': {
        this.setState('ended');
        this.options.onEnded?.(message.payload);
        return;
      }
      case 'mo:error': {
        if (message.payload.fatal) this.setState('error');
        this.options.onError?.(message.payload);
        return;
      }
      case 'mo:log': {
        this.options.onLog?.(message.payload);
        if (message.payload.level === 'error') console.error('[game]', message.payload.message);
        else if (message.payload.level === 'warn') console.warn('[game]', message.payload.message);
        return;
      }
      case 'mo:storage': {
        void this.handleStorageRequest(message.id, message.payload).catch(() => {});
        return;
      }
      case 'mo:req': {
        void this.handleHostRequest(message).catch(() => {});
        return;
      }
    }
  }

  /** Lifecycle messages bypass the inbound rate limit. */
  private allow(message: GameToHostMessage): boolean {
    if (message.type !== 'mo:log' && message.type !== 'mo:heartbeat' && message.type !== 'mo:score') return true;
    if (this.limiter.take()) return true;
    console.warn('[moydan host] dropping rate-limited game message', message.type);
    return false;
  }

  private initialize(): void {
    this.send({
      protocol: BRIDGE_PROTOCOL_VERSION,
      id: this.nextId(),
      type: 'mo:init',
      payload: {
        releaseId: this.options.releaseId,
        gameId: this.options.gameId,
        gameTitle: this.options.gameTitle,
        params: this.options.params,
        capabilities: this.options.capabilities,
        apiVersion: this.options.apiVersion,
        locale: this.options.locale ?? 'en',
        viewport: this.options.viewport,
        orientation: this.options.orientation,
        muted: this.muted,
        sessionId: this.options.sessionId || 'session',
        preview: this.options.preview ?? false,
        limits: {
          heartbeatMs: this.options.heartbeatMs ?? 2000,
          maxMessageBytes: 8 * 1024,
          messagesPerSecond: BRIDGE_MESSAGES_PER_SECOND,
        },
      },
    });
    if (this.startRequested) {
      this.send({ protocol: BRIDGE_PROTOCOL_VERSION, id: this.nextId(), type: 'mo:start' });
    }
  }

  private storageKey(key: string): string {
    return `pf.game.${this.options.gameId}.${key}`;
  }

  private storageKeys(): string[] {
    const prefix = `pf.game.${this.options.gameId}.`;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(prefix)) keys.push(key.slice(prefix.length));
    }
    return keys;
  }

  private async handleStorageRequest(
    id: string,
    payload: { op: 'get' | 'set' | 'remove' | 'clear'; key?: string; value?: unknown },
  ): Promise<void> {
    let ok = true;
    let error: string | undefined;
    let result: unknown;
    try {
      switch (payload.op) {
        case 'get': {
          if (!payload.key) throw new Error('storage.get requires a key');
          const raw = localStorage.getItem(this.storageKey(payload.key));
          result = raw === null ? undefined : JSON.parse(raw);
          break;
        }
        case 'set': {
          if (!payload.key) throw new Error('storage.set requires a key');
          const text = JSON.stringify(payload.value ?? null);
          if (text === undefined) throw new Error('value is not JSON-serializable');
          if (text.length > MAX_STORAGE_VALUE_BYTES) throw new Error('value exceeds the per-key storage limit');
          if (!localStorage.getItem(this.storageKey(payload.key)) && this.storageKeys().length >= MAX_STORAGE_KEYS) {
            throw new Error(`storage is limited to ${MAX_STORAGE_KEYS} keys per game`);
          }
          localStorage.setItem(this.storageKey(payload.key), text);
          break;
        }
        case 'remove': {
          if (!payload.key) throw new Error('storage.remove requires a key');
          localStorage.removeItem(this.storageKey(payload.key));
          break;
        }
        case 'clear': {
          for (const key of this.storageKeys()) localStorage.removeItem(this.storageKey(key));
          break;
        }
      }
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : 'storage operation failed';
    }
    this.send({
      protocol: BRIDGE_PROTOCOL_VERSION,
      id: this.nextId(),
      type: 'mo:res',
      payload: { requestId: id, ok, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) },
    });
  }

  private async handleHostRequest(message: GameToHostMessage & { type: 'mo:req' }): Promise<void> {
    const { method, params } = message.payload;
    let ok = true;
    let error: string | undefined;
    let result: unknown;
    try {
      switch (method) {
        case 'storage.get':
        case 'storage.set':
        case 'storage.remove':
        case 'storage.clear': {
          const payload = (params ?? {}) as { key?: string; value?: unknown };
          const op = method.slice('storage.'.length) as 'get' | 'set' | 'remove' | 'clear';
          result = await this.runStorage(op, payload);
          break;
        }
        case 'share': {
          const handler = this.options.onShare;
          if (!handler) throw new Error('sharing is not available here');
          const shareResult = await handler(params);
          if (!shareResult.ok) throw new Error(shareResult.error ?? 'share failed');
          break;
        }
        case 'open-link': {
          const url = (params as { url?: string } | undefined)?.url;
          if (!url || !/^https:\/\//.test(url)) throw new Error('only https links can be opened');
          const handler = this.options.onOpenLink;
          if (!handler) throw new Error('link-out is not enabled for this game');
          const linkResult = await handler(url);
          if (!linkResult.ok) throw new Error(linkResult.error ?? 'link could not be opened');
          break;
        }
      }
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : 'request failed';
    }
    this.send({
      protocol: BRIDGE_PROTOCOL_VERSION,
      id: this.nextId(),
      type: 'mo:res',
      payload: { requestId: message.id, ok, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}) },
    });
  }

  private async runStorage(
    op: 'get' | 'set' | 'remove' | 'clear',
    payload: { key?: string; value?: unknown },
  ): Promise<unknown> {
    switch (op) {
      case 'get': {
        if (!payload.key) throw new Error('storage.get requires a key');
        const raw = localStorage.getItem(this.storageKey(payload.key));
        return raw === null ? undefined : JSON.parse(raw);
      }
      case 'set': {
        if (!payload.key) throw new Error('storage.set requires a key');
        const text = JSON.stringify(payload.value ?? null);
        if (text === undefined) throw new Error('value is not JSON-serializable');
        if (text.length > MAX_STORAGE_VALUE_BYTES) throw new Error('value exceeds the per-key storage limit');
        localStorage.setItem(this.storageKey(payload.key), text);
        return undefined;
      }
      case 'remove': {
        if (payload.key) localStorage.removeItem(this.storageKey(payload.key));
        return undefined;
      }
      case 'clear': {
        for (const key of this.storageKeys()) localStorage.removeItem(this.storageKey(key));
        return undefined;
      }
    }
  }
}

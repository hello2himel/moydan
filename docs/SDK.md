# Game SDK and runtime bridge

The SDK (`packages/sdk`) is the only supported way for a published game to talk to Moydan. It is
engine-agnostic: the same API works for a hand-written Canvas game and for a Phaser game. The
bridge underneath it (`packages/core/src/bridge.ts`) is a versioned `postMessage` protocol that
both sides validate.

## Lifecycle

```
game frame                                  host (apps/web)
-----------                                 ------------------
mo:ready   { sdkVersion, capabilitiesUsed } ──▶
                            ◀── mo:init    { release, params, capabilities, viewport, limits, sessionId }
                      start()
                            ──▶ mo:started { instanceId, msToStart }
       (playing)
                            ◀── mo:pause / mo:mute / mo:visibility
   pause() / mute() / visibility()
                            ──▶ mo:paused, mo:resumed, mo:heartbeat
                            ◀── mo:restart        → new instance, no duplicate listeners
                            ──▶ mo:restarted { instanceId, instanceCount }
                            ──▶ mo:ended { reason, score? }
                            ◀── mo:dispose
  dispose()
```

Every message carries `protocol: 1` and a host-generated `id`. The SDK re-sends `mo:ready` until it
receives `mo:init`, so a slow frame load never deadlocks the host.

## Writing a game

```ts
import { defineGame, setupCanvas } from '@moydan/sdk';

defineGame({
  create(api) {
    const { canvas, ctx, width, height, dispose } = setupCanvas(api);
    return {
      start() { /* … */ },
      pause() { /* stop simulation */ },
      resume() { /* continue */ },
      mute(muted) { /* set audio gain */ },
      visibility(visible) { /* show/hide pause overlay */ },
      dispose() { /* release everything; never reused */ },
    };
  },
});
```

### `GameApi`

| Member | Meaning |
| --- | --- |
| `params` | Immutable parameter values for this release (manifest defaults merged with remix overrides) |
| `capabilities` | What the host actually granted — the intersection of your manifest and platform policy |
| `viewport` / `orientation` | Design viewport and orientation from the manifest |
| `root` | An empty element you render into. Not the parent document |
| `sessionId` | Opaque, rotates per play. Never persist it |
| `preview` | `true` in a creator preview build |
| `createLoop(step)` | Pause-aware `requestAnimationFrame` loop; returns `{ stop(), running }` |
| `score(value, options?)` | Submit a score for this session (unverified) |
| `ended(options?)` | Signal the run finished (`game-over`, `completed`, `user`, `error`) |
| `storage` | `get/set/remove/clear` JSON values through the host |
| `muted` | `true` while the host muted the game (offscreen/inactive) |
| `log(level, message)` / `reportError(message, opts)` | Diagnostics surfaced in studio logs and error UI |

### Helpers

| Helper | Purpose |
| --- | --- |
| `setupCanvas(api, { className? })` | DPR-aware canvas sized to the viewport; returns `{ canvas, ctx, width, height, dispose }` and cleans up on resize/dispose |
| `createRng(seed)` | Deterministic PRNG for reproducible patterns |

## Capabilities

Declare in `game.json`; the host grants the intersection with platform policy and passes the
result to `api.capabilities`.

| Capability | Grants |
| --- | --- |
| `storage` | `api.storage` |
| `score` | `api.score` / `api.ended` |
| `audio` | audio playback; the host controls the mute state |
| `vibration` | vibration, only where the browser allows it |
| `fullscreen` | fullscreen request from the host chrome |
| `link-out` | `open-link` request; the host shows a confirmation, and only `https:` links are allowed |

Anything not declared is unavailable. There is no network API, no DOM access, no storage access
outside the game's namespace, and no way to reach platform endpoints.

## Request/response

Games request host actions with `mo:req`:

```ts
api.storage.set('bestScore', 42);
```

The host answers with `mo:res` (`{ requestId, ok, result?, error? }`) after validating origin,
message type, payload schema, payload size and a token-bucket rate limit. Timeouts surface as a
rejected promise; the game keeps running.

## Validation and limits

Every message is validated against a strict schema in `packages/core/src/bridge.ts`:

- Unknown message types are rejected.
- Unknown keys inside a payload are rejected (no smuggling).
- Payloads are size-capped (`runtimeMaxMessageBytes`, default 8 KiB) and JSON-depth-capped.
- `mo:storage` keys match `[A-Za-z0-9._-]+`, values are bounded JSON.
- Score values are finite and range-bounded; `durationMs` cannot exceed 24 hours.
- Rate limit: `runtimeMessagesPerSecond` (default 30) with a burst allowance, per sender.
- Prototype-polluting keys (`__proto__`, `constructor`, `prototype`) are rejected everywhere.

## Isolation

- Games run in an iframe on a **separate origin** with a strict `Content-Security-Policy`
  (`default-src 'none'`, `script-src 'self'`, no `connect-src` beyond self, `frame-ancestors`
  limited to the app origin).
- The iframe is sandboxed; it has no access to application cookies, storage, or the API session.
- No cookies are set on the game origin at all.
- The host mutes audio and pauses simulation the moment a game stops being the active feed item,
  and disposes it when it is recycled, so memory does not grow with scroll distance.

## Versioning

| Constant | Meaning |
| --- | --- |
| `SDK_VERSION` | SDK contract version (`1.0.0`) |
| `RUNTIME_API_VERSION` | Bridge API version implemented by the platform (`1`) |
| `BRIDGE_PROTOCOL_VERSION` | Wire format version (`1`) |
| `PROJECT_FORMAT_VERSION` | Project format version (`1`) |

A game declares `runtime.apiVersion` (and optionally `minApiVersion`) in `game.json`. The platform
rejects an unsupported API version at validation time rather than failing at play time. Within a
major version, new optional fields may be added; removing or retyping a field requires a new API
version.

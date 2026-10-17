# Security notes

Creator-submitted game code is untrusted code. This document describes what is enforced, where,
and what is explicitly *not* claimed.

## Threat model

| Adversary | Capability assumed | Primary controls |
| --- | --- | --- |
| Malicious creator | Controls every byte of an uploaded project, manifest, asset and filename | path policy, content sniffing, manifest schema, licence validation, build isolation, quotas |
| Malicious game at runtime | Full JS in its own frame, network access to its own origin, persistence tricks | separate origin, CSP, sandboxed iframe, validated `postMessage` only, no cookies, rate limits, watchdog, disposal |
| Abusive user | Valid account, wants to spam or grief | rate limits, quota accounting, one-reaction/one-save constraints, comment limits, report queue, audit events |
| Network attacker / curious third party | Can observe traffic | HTTPS requirement in production, secure cookies, CSRF tokens, no secrets in responses, immutable artifact URLs |
| Compromised dependency | Build-time code execution | pinned toolchain, allow-listed engines, no creator package installation, isolated worker, server-side artifact re-validation |

## 1. Upload and import

- **Path safety** (`packages/core/src/paths.ts`): one function decides for every path, for every
  caller. Absolute paths, `..`, backslashes, control characters, reserved Windows names, dotfiles,
  `.git`/`node_modules`/`__MACOSX` are rejected before anything touches storage.
- **Archive safety** (`apps/api/src/services/archive.ts`): entry count, per-file size, total
  expanded size and compression ratio are all bounded; entries are normalised and de-duplicated
  before use; zip-slip and archive bombs fail with a specific error. Nothing is written until the
  whole archive validates.
- **Content type**: declared MIME types and extensions are treated as claims. Magic bytes decide,
  and a mismatch is a rejection. SVGs containing script/animation/foreign content are refused.
  Text files must decode as UTF-8 with no NUL bytes.
- **Quotas** (`packages/core/src/limits.ts`): per-file, per-project, per-account source and
  release budgets are checked before ingest and after, and reported to the user.
- **No prototype pollution**: the shared schema library rejects `__proto__`, `constructor` and
  `prototype` as property names everywhere.

## 2. Build isolation

Builds never run inside the API process.

- The worker claims a job with a dedicated secret (`WORKER_JOB_SECRET`), not a user session.
- Only `esbuild` executes. No creator-authored script, shell command or package installation is
  ever run. There is no `package.json` in a project, so there is nothing to install.
- The compile step runs in a child process with `--max-old-space-size` from `BUILD_MEMORY_MB`, a
  wall-clock timeout from `BUILD_TIMEOUT_MS`, a scrubbed environment (no session secret, no cloud
  credentials, no database URL), and in production inside `docker run --network=none` with CPU and
  memory caps. `assertConfigSafety()` refuses to boot a production deployment with
  `BUILD_USE_DOCKER=0`.
- The worker receives source file bytes, not the database. It returns artifact bytes.
- The API re-validates every artifact against its own rows: path policy, count, total size, entry
  document presence, declared manifest agreement. A worker's claims are never trusted.
- Workspaces are per-job directories removed in a `finally`; failed builds never leave the game
  pointing at a partial release.

## 3. Runtime isolation

- The game origin is a **different origin** from the application. This is enforced at boot in
  production and is the single most important control: same-origin would give untrusted code the
  user's session cookies.
- Game documents are served with a strict CSP:

  ```
  default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:;
  connect-src 'self'; worker-src 'none'; child-src 'none';
  frame-ancestors <app origin>; base-uri 'none'; form-action 'none'; object-src 'none'
  ```

  No inline script, no eval-able remote code, no framing by anyone but the app.
- The iframe is sandboxed and holds no application storage, cookies or DOM access. The SDK is the
  only script it loads besides its own bundle.
- The game origin sets **no cookies** and exposes no CORS access to the app origin's credentials.
- `Permissions-Policy` disables geolocation, camera, microphone, USB and payment.
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: cross-origin`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` on every response.

## 4. The bridge protocol

`packages/core/src/bridge.ts` — the only channel between frame and host:

- Validate sending **origin** and **source window** before anything else.
- Strict schemas per message type: unknown message types rejected, unknown payload keys rejected
  (no smuggling), finite numbers only, bounded strings/arrays/JSON depth.
- Size cap per message (`runtimeMaxMessageBytes`) and a token-bucket rate limit per sender.
- The game cannot widen its own capabilities: the host grants the intersection of the manifest
  declaration and platform policy at init.
- Storage is host-mediated, per-game and JSON-only; keys are pattern-validated.
- `link-out` requires host confirmation and only allows `https:` URLs.

## 5. Application security

- Passwords: scrypt with a per-user salt and constant-time comparison.
- Sessions: opaque random tokens, stored hashed, HttpOnly + SameSite=Lax + Secure in production,
  rotated on login, revocable, expired.
- CSRF: double-submit token required for cookie-authenticated writes; bearer-authenticated clients
  are exempt because they cannot be triggered cross-site.
- Authorization is enforced server-side on every mutation: ownership checks for projects, files,
  builds and releases; visibility checks for drafts; admin-only moderation endpoints.
- Error bodies never contain secrets, stack traces or filesystem paths; logs redact tokens.
- Security-sensitive operations (publication, withdrawal, moderation, build start) write
  `security_events` / `moderation_events` audit rows.
- Reported scores are explicitly labelled unverified. Nothing in the UI claims they are cheat
  proof.

## 6. Known limitations (honest list)

- Client-reported scores and play durations are not verifiable without a heavier protocol; a
  competitive mode would need server-side simulation or attestation.
- The `fs` storage driver is a development adapter. It must not be used in production (the boot
  check refuses it).
- Content-Security-Policy cannot stop a game from being *annoying* (spinning a loop); the host
  watchdog pauses and disposes games that exceed their budget, and a hard browser-side memory cap
  would require OS-level isolation.
- Static analysis of game code is limited to "no `eval`/`new Function`/remote URLs" checks in the
  CLI test command. The real protection is that the code runs sandboxed, not scanned.
- Rate limits are per-instance and in-process. A multi-instance deployment needs a shared limiter.

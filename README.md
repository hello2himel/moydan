# Moydan

**Moydan** is an open-source, mobile-first social platform for short, immediately playable
browser games. It is the feed you already know — vertical scroll, reactions, comments, follows,
saves — except every item is a game you can play in place.

Creators build small games inside Moydan itself: a manifest, some source files, some assets, an
explicit licence. Moydan compiles them in an isolated worker, freezes them as immutable releases,
and serves them from a dedicated untrusted-content origin through a sandboxed iframe. Players get
a small, cached, versioned release. Creators keep every byte of their source, and remixing is a
first-class, licence-respecting operation with inspectable lineage.

- **Licence:** AGPL-3.0-only (see [LICENSE](LICENSE)). Games published on the platform carry their
  own, explicitly declared licences — see [docs/LICENSING.md](docs/LICENSING.md).
- **Runtime:** Node 22+ (developed on Node 26, runs `.ts` directly), React 19 + Vite 6, Fastify 5,
  SQLite (bundled driver), S3-compatible object storage, esbuild for builds, Vitest for tests.

---

## Table of contents

1. [Quick start](#quick-start)
2. [What is implemented today](#what-is-implemented-today)
3. [Architecture](#architecture)
4. [Repository layout](#repository-layout)
5. [Commands](#commands)
6. [Configuration](#configuration)
7. [Testing](#testing)
8. [Documentation map](#documentation-map)
9. [Status, limitations and next steps](#status-limitations-and-next-steps)

---

## Quick start

Requirements: Node >= 22.5 (type stripping — no transpile step for server code), npm 10+.

```bash
git clone https://github.com/hello2himel/moydan.git
cd moydan
npm install
cp .env.example .env          # defaults work for local development
npm run vendor:toolchain      # pins esbuild + phaser into vendor/toolchain (offline builds)
npm run migrate               # create ./var/moydan.db and apply migrations
npm run seed                  # 3 demo creators + the 3 template games, built and published
npm run dev                   # api :8787, game origin :5174, worker, web :5173
```

Open <http://localhost:5173>. Demo accounts created by `npm run seed`:

| Handle   | Email                  | Password               |
| -------- | ---------------------- | ---------------------- |
| `nova`   | nova@moydan.local      | `moydan-dev-password`  |
| `kai`    | kai@moydan.local       | `moydan-dev-password`  |
| `mira`   | mira@moydan.local      | `moydan-dev-password`  |

Sign in, swipe the **For You** feed, save a game, open **Saved**, then follow `nova` and check the
**Following** tab. As a creator: **Create** → pick a template → edit a file → **Validate** →
**Build** → **Preview** → **Publish**, then **Remix** it with changed parameters.

Without the demo seed you can still run the API alone (`npm run dev -- --no-web`) and create
accounts from the sign-up screen.

## What is implemented today

**Playing**

- Full-screen, snap-scrolling game feed with **For You** and **Following** as separate routes,
  cursor pagination, prefetch of the next page, skeletons, empty and retryable error states.
- One active game at a time. The active game runs in a sandboxed iframe on a separate origin;
  leaving the viewport pauses and mutes it, and it is disposed when the feed item is recycled.
- Play sessions, first-frame telemetry, score reports (clearly labelled *unverified*), per-game
  score boards.
- Saved page: paginated, persisted per account, duplicate-proof, opens any game straight into
  playable mode, informative state for removed/unpublished games.

**Social** (all backend-enforced, with optimistic UI that rolls back on failure)

- Registration/login with server-side sessions, CSRF double-submit for cookie writes.
- Reactions (one per user per game), comments with one level of replies, edit/delete, pagination,
  rate limits, plain-text rendering.
- Follow/unfollow, creator profiles with Games and Remixes tabs, profile editing, settings.
- Sharing stable game URLs; reporting games, comments and creators; an admin review queue with
  actions that record moderation and security audit events.

**Creating and publishing**

- Project drafts with a real file tree: create, read, write, rename, delete, import a zip,
  export a deterministic zip, validate with actionable issues.
- Content-addressed blob storage with SHA-256 deduplication, per-account quotas and reference
  counting.
- Strict `game.json` manifest validation (schema + file tree + engine/runtime allow-lists).
- Licence validation before anything is publishable: unknown, ambiguous or prohibited licences are
  rejected with a specific error.
- Builds run in an isolated worker (child process with memory/time limits, or Docker with
  `--network=none`), never in the API process and never with creator-supplied shell commands.
- Immutable releases: a published release is never mutated. Publishing again creates a new
  sequence. Failed builds never replace the current release.
- Creator studio: file tree, editor, validation issues, build status and diagnostics, preview with
  a time-limited signed grant, publish / unpublish / withdraw.
- Source display: repository link when the creator declares one, licence, asset licensing,
  attribution, version, tree hash, notices, runtime compatibility, publish date.

**Remixing**

- Two modes. **Parameter remix** (schema-validated editor over the author's declared parameters,
  no bundle copy, pinned to the exact parent release) and **source remix** (a new project whose
  draft references the parent's blobs until a file actually changes).
- Licence checks gate both modes, share-alike parents constrain the child's licence, and required
  notices/attribution are carried forward and cannot be edited away.
- Lineage is a first-class table: parent game, exact parent version and release, parent commit/tree
  hash, root ancestor, creators, licences, applied parameters, timestamp. The full ancestry chain
  is browsable. Unpublishing a parent never rewrites history.

**Security**

- Game code executes on a different origin, behind a strict CSP, in a sandboxed iframe, talking to
  the host only through a validated, versioned `postMessage` protocol (origin + type + schema +
  size + rate limits, unknown keys rejected).
- Build workers get no network, no cloud credentials and no access to session secrets.
- Path traversal, archive bombs, zip-slip, dependency confusion, prototype pollution and MIME
  spoofing are rejected by construction (see [docs/SECURITY.md](docs/SECURITY.md)).

## Architecture

```
                    ┌──────────────────────────┐
   player ─────────▶│  apps/web  (app origin)  │  React SPA, sessions, feed, studio
                    └───────┬──────────────────┘
                            │ /api (JSON, cookie + CSRF)
                    ┌───────▼──────────────────┐
                    │  apps/api                │  Fastify, services, SQLite
                    │  (app origin)            │  structured metadata only
                    └───────┬──────────────────┘
                            │ claims jobs (Bearer WORKER_JOB_SECRET)
                    ┌───────▼──────────────────┐        ┌──────────────────────┐
                    │  apps/worker             │───────▶│ object storage       │
                    │  isolated: no net, no    │ upload │ (S3 / R2 / MinIO)    │
                    │  credentials, esbuild    │        └──────────┬───────────┘
                    └──────────────────────────┘                   │ CDN
                    ┌──────────────────────────┐                   │
   player ─────────▶│  apps/game-origin        │◀──────────────────┘
   (sandboxed iframe)  (separate origin, CSP)  │  /r/<releaseId>/… immutable
                    └──────────────────────────┘
```

Trust boundaries and the reasoning behind them are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

```
moydan/
├── apps/
│   ├── api/            Fastify API, SQLite access, services, migrations
│   ├── web/            React SPA (feed, saved, profile, studio, remix)
│   ├── worker/         isolated build worker + esbuild pipeline
│   └── game-origin/    untrusted-content origin (immutable release delivery)
├── packages/
│   ├── core/           browser-safe contracts: manifest, licence, bridge, DTOs, limits
│   ├── sdk/            creator SDK used by every published game
│   ├── runtime/        browser host: iframe bridge, playback control, feed instrumentation
│   ├── storage/        object storage drivers (fs dev adapter, S3-compatible)
│   └── cli/            `moydan` creator CLI
├── examples/           three complete, playable, MIT-licensed template games
├── docs/               architecture, creator, SDK, remix, licensing, security, deployment
└── scripts/            dev orchestration, toolchain vendoring
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | migrate + API + worker + game origin + web, with prefixed logs |
| `npm run build` | production build of the web app (and type/bundle checks) |
| `npm run typecheck` | `tsc --noEmit` across packages, apps, examples and tests |
| `npm run lint` | ESLint (flat config, typescript-eslint) |
| `npm test` | unit + integration suites (Vitest) |
| `npm run test:unit` / `npm run test:integration` | one suite at a time |
| `npm run test:e2e` | Playwright browser tests (requires a running stack) |
| `npm run migrate` | apply pending migrations (`-- --dry-run` to inspect) |
| `npm run seed` | local development dataset (clearly separated from real data) |
| `npm run gc` | blob garbage collection with reference counting |
| `npm run metrics` | recompute derived counters (plays, saves, reactions) |
| `npm run vendor:toolchain` | pin/copy esbuild + phaser into `vendor/toolchain` (`-- --check` verifies) |

Creator CLI (after `npm run build -w @moydan/cli` or via `node packages/cli/bin/moydan.mjs`):

| Command | What it does |
| --- | --- |
| `moydan init <template>` | scaffold a new project |
| `moydan validate [dir]` | validate `game.json`, licences and asset declarations |
| `moydan build [dir]` | bundle to `dist/` and report the first-playable budget |
| `moydan dev [dir]` | local preview with production CSP headers |
| `moydan test [dir]` | lifecycle/static checks that need no browser |
| `moydan pack [dir]` | deterministic, uploadable zip |
| `moydan login` / `moydan whoami` | store and check a deployment session |

## Configuration

All configuration is environment based; see [.env.example](.env.example) for the annotated list.
No secrets are committed, and `.env` is git-ignored. In production `assertConfigSafety()` refuses
to boot unless the session/worker secrets are real random values, the app and game origins differ,
object storage is S3-compatible (not the dev `fs` adapter), and container build isolation is on.

The most important knobs:

| Variable | Meaning |
| --- | --- |
| `APP_ORIGIN`, `GAME_ORIGIN`, `CDN_BASE_URL` | where the app runs, where untrusted game content runs, CDN in front |
| `SESSION_SECRET`, `WORKER_JOB_SECRET` | 32+ random chars; session signing and worker authentication |
| `DATABASE_URL`, `DATABASE_DRIVER` | SQLite file (bundled driver) |
| `STORAGE_DRIVER`, `S3_*` | `fs` for development, `s3` for production |
| `BUILD_USE_DOCKER`, `BUILD_MEMORY_MB`, `BUILD_TIMEOUT_MS` | build isolation and limits |
| `QUOTA_*`, `MAX_*` | every size/count/time limit used by validation (see docs/OPERATIONS.md) |
| `ADMIN_EMAILS` | accounts promoted to moderator on registration (development convenience) |

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

- **Unit** — manifest/schema/licence/path/media/bridge validation, cursor encoding, limits, storage
  key derivation, SDK protocol conformance.
- **Integration** — the real API against a temporary SQLite database and a temporary storage root:
  auth, feed, social, saves, comments, publishing, remixing, quotas, GC, rate limits, ownership.
  These run against actual storage, not mocks.
- **End-to-end** — Playwright against a running stack (`npm run test:e2e`).

See [docs/TESTING.md](docs/TESTING.md) for what each suite proves and what still needs an external
service (S3, a browser, a container runtime).

## Documentation map

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, data flow, database model, trust boundaries |
| [docs/PROJECT-FORMAT.md](docs/PROJECT-FORMAT.md) | `game.json`, project layout, versioning, blobs, snapshots, artifacts |
| [docs/CREATOR-GUIDE.md](docs/CREATOR-GUIDE.md) | from empty directory to published game |
| [docs/SDK.md](docs/SDK.md) | runtime bridge, lifecycle, capabilities, storage, scoring |
| [docs/REMIX.md](docs/REMIX.md) | parameter and source remixes, licensing, lineage |
| [docs/LICENSING.md](docs/LICENSING.md) | supported licences, compatibility rules, prohibited cases |
| [docs/SECURITY.md](docs/SECURITY.md) | isolation model, CSP, build isolation, threat model |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | services, environment, migrations, workers, backups |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | limits, quotas, storage accounting, retention, GC |
| [docs/API.md](docs/API.md) | every endpoint, request/response shapes, status codes |
| [docs/TESTING.md](docs/TESTING.md) | suites, coverage, what is not covered and why |
| [docs/RELEASES.md](docs/RELEASES.md) | how the packaged releases (Android/Windows/Flatpak) are built |

## Status, limitations and next steps

Moydan is an **alpha**. The vertical slices above are implemented and tested end to end against
real infrastructure; the honest gaps are listed in
[docs/STATUS.md](docs/STATUS.md) — notably: client-reported scores are unverified by design,
parameter remixes require the game author to opt in, and several production deployment steps
(object storage, container builds, CDN) are configuration, not code.

There is no remote-propaganda, no tracking beyond the analytics needed to run the product, and no
external Git provider requirement: a game lives entirely inside Moydan.

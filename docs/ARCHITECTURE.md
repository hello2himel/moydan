# Architecture

Moydan is a modular monolith plus one isolated worker process and one isolated content origin.
There are no microservices, no message broker and no second database. The boundaries that matter
are trust boundaries, not network boundaries.

## Components

| Component | Package | Origin | Responsibility |
| --- | --- | --- | --- |
| Web app | `apps/web` | app origin | Feed, saved, profiles, studio, remix UI, session handling |
| API | `apps/api` | app origin | All structured state, authorization, feed ranking, publication transitions |
| Worker | `apps/worker` | internal | Compiles a frozen source version into an immutable artifact |
| Game origin | `apps/game-origin` | **separate origin** | Serves published releases and the creator SDK to untrusted frames |
| Core | `packages/core` | everywhere | Browser-safe contracts: manifest, licence policy, bridge, DTOs, limits, paths, media sniffing, cursors |
| SDK | `packages/sdk` | inside every game | The only supported API a game may use |
| Runtime | `packages/runtime` | app origin | Iframe bridge, playback control, lifecycle watchdog, feed instrumentation |
| Storage | `packages/storage` | API, worker, origin | Object storage drivers: `fs` (dev) and S3-compatible (production) |
| CLI | `packages/cli` | creator machine | `moydan init/validate/build/dev/test/pack` |

## Request flow (play)

1. The web app asks the API for a feed page (`GET /api/feed/foryou`). The API returns
   `GameCard` objects that already contain the release summary, the immutable `entryUrl` on the
   game origin, licence/source metadata, remix origin and viewer state. The feed never needs a
   second round trip per card.
2. The feed becomes active. `packages/runtime` creates exactly one sandboxed iframe pointing at
   `https://<game-origin>/r/<releaseId>/index.html`.
3. The runtime performs the handshake (`mo:ready` → `mo:init` → `mo:start`) after asking the API
   for a play session. All messages are schema-validated on both sides.
4. When the card scrolls out of the active viewport the runtime sends `mo:pause` + `mo:mute`,
   stops heartbeats and cancels pending work. Disposal tears the frame down and releases memory.
5. The API records the session outcome and score (unverified by design) and refreshes derived
   counters.

No source file, project archive, or build log is ever downloaded during normal play.

## Request flow (publish)

```
creator edits draft
   -> validate (manifest + licence + paths + limits)
   -> startBuild  : freeze draft into an immutable source_version, create build_jobs + releases(building)
   -> worker      : POST /api/internal/builds/claim          (Bearer WORKER_JOB_SECRET)
                    GET  source files by blob digest
                    compile in an isolated child process (esbuild, no network, no creator scripts)
                    POST /api/internal/builds/:id/artifacts   (one call per file, verified server-side)
                    POST /api/internal/builds/:id/finish      (server re-validates against DB rows)
   -> release     : ready_for_review
   -> preview     : signed, expiring grant -> /preview/<releaseId>/<token>/…
   -> publish     : transaction flips the game's current_release_id
```

Every step is idempotent or transactional. A failed build marks the *job* failed; it never
touches the game's current release. Two builds of the same (tree hash, toolchain) collapse into
one job, so a double-click cannot publish twice.

## Data model

SQLite via `node:sqlite` (`apps/api/src/db/client.ts`), foreign keys on, WAL enabled. The schema
lives in `apps/api/migrations/*.sql` and is applied in order by `npm run migrate`, which records a
checksum per migration and reports drift instead of silently re-running.

| Group | Tables |
| --- | --- |
| Identity | `users`, `profiles`, `sessions` |
| Projects | `games`, `game_drafts`, `draft_files`, `source_versions`, `version_files` |
| Publication | `build_jobs`, `releases`, `release_files`, `preview_grants` |
| Storage | `blobs`, `storage_usage` |
| Social | `follows`, `reactions`, `saved_games`, `saved_collections`, `comments`, `game_scores`, `play_sessions`, `feed_impressions` |
| Remix | `remix_relations` |
| Trust | `reports`, `moderation_events`, `security_events` |
| Derived | `game_metrics` (denormalised counters used by ranking and cards) |

Key invariants:

- `games` is identity only. Working state is `game_drafts` + `draft_files`. A snapshot is
  `source_versions` + `version_files`. A published artifact is `releases` + `release_files`.
  These are never conflated into one mutable row.
- `version_files` and `draft_files` reference `blobs.sha256`. Identical content is stored once;
  the row is the reference that makes garbage collection safe.
- `releases.artifact_manifest_json` is written once at `finishBuild` and never mutated; withdrawal
  changes `status`, not the artifact.
- `remix_relations` records the exact parent game, parent version and parent release. It is
  append-only in practice: unpublishing, renaming handles or takedowns never rewrite it.
- Uniqueness constraints make duplicate follows, duplicate reactions, duplicate saves, duplicate
  reports and duplicate build jobs impossible at the storage layer.

## Trust boundaries

| Boundary | Enforcement |
| --- | --- |
| Creator upload → platform | Path policy, extension/content-type agreement, magic-byte sniffing, size/count/ratio limits, manifest schema, licence policy |
| Platform → build worker | Worker holds only `WORKER_JOB_SECRET`; receives source blobs, not the database; returns artifact bytes that the API re-validates |
| Build worker → creator code | Only `esbuild` runs. No shell, no package installation, no network, no `node_modules` resolution outside the workspace and the pinned toolchain |
| App origin → game origin | Different origin required (enforced by `assertConfigSafety`), CSP `frame-ancestors`, sandboxed iframe, `postMessage` allow-list |
| Game frame → platform | Versioned bridge protocol: origin check, source window check, type allow-list, strict schema (unknown keys rejected), size cap, token-bucket rate limit, no DOM/cookie/token access |
| Client → API | Server-side authorization on every mutation, CSRF for cookie writes, rate limits, ownership checks, quota checks |

## Feed ranking

`apps/api/src/services/feed.ts` is the only place feed order is decided, and it is deliberately
simple and inspectable:

- **Following** — newest first from creators the viewer follows, keyset paginated.
- **For You** — a transparent baseline: recently published eligible releases, weighted by a small
  popularity signal (reactions, saves, plays over a decaying window) with a diversity pass that
  avoids showing two remixes of the same parent back to back. No black-box model, no personal
  profiling beyond the viewer's own follows and saves.

## Deliberate non-goals

- No external Git provider integration. A project lives in Moydan; it can declare a repository URL
  for attribution, and that is all.
- No full Git semantics (no branching, no commit graph, no protocol). Immutable snapshots plus file
  references are sufficient and much easier to reason about.
- No client-verified scores. Scores are stored and displayed as *unverified*; a competitive mode
  would need server-side verification, which is a separate design.

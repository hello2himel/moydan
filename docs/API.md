# Moydan HTTP API

All endpoints are served by the API process (`apps/api`) under `/api` (plus `/health`).
Responses are JSON unless stated otherwise. Errors always use:

```json
{ "error": { "code": "validation_failed", "message": "human readable", "details": { } } }
```

`code` is a stable machine readable string from `AppErrorCode` in `@moydan/core`.

## Authentication

| Mechanism | Header / cookie | CSRF |
| --- | --- | --- |
| Browser session | `moydan_session` (HttpOnly cookie) + `moydan_csrf` (readable cookie) | Required on writes: send `moydan_csrf` value in `x-csrf-token` |
| API client (CLI, scripts) | `Authorization: Bearer <token>` | Not required (not cookie authenticated) |

`GET /api/auth/session` returns `{ user: null }` or a `SessionResponse`.

## Route modules

| Module | Prefix | Responsibility |
| --- | --- | --- |
| `routes/auth.ts` | `/api/auth` | register, login, logout, session |
| `routes/profiles.ts` | `/api` | profiles, follows, own games/storage, licences |
| `routes/meta.ts` | `/api` | `/meta`, `/meta/templates`, `/meta/maintenance` |
| `routes/catalog.ts` | `/api` | public game/source/release/score reads |
| `routes/projects.ts` | `/api` | creator project lifecycle: draft files, import/export, builds, publish, remix |
| `routes/feed.ts` | `/api` | `/feed/foryou`, `/feed/following`, `/me/saved` |
| `routes/social.ts` | `/api` | reactions, saves, comments, share links |
| `routes/play.ts` | `/api` | play sessions, heartbeats, score reports |
| `routes/moderation.ts` | `/api` | reports + admin queue |
| `routes/internal.ts` | `/api` | build worker protocol + preview grant resolution |

## Endpoint list

### Feed (public reads; viewer state included when authenticated)

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/api/feed/foryou?cursor&limit` | optional | `Paginated<GameCard>` |
| GET | `/api/feed/following?cursor&limit` | required | `Paginated<GameCard>` |
| GET | `/api/me/saved?cursor&limit` | required | `Paginated<GameCard>` |

`limit` defaults to 10, max 25. Cursors are opaque (`encodeCursor`).

### Social

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| PUT | `/api/games/:gameId/reaction` | required | `{ type: "like"\|"love"\|"fire"\|"wow" }` | `{ reacted, reactions }` |
| DELETE | `/api/games/:gameId/reaction` | required | – | `{ reacted: null, reactions }` |
| PUT | `/api/games/:gameId/save` | required | – | `{ saved: true, saves }` |
| DELETE | `/api/games/:gameId/save` | required | – | `{ saved: false, saves }` |
| GET | `/api/games/:gameId/comments?cursor&limit&parentId` | optional | – | `Paginated<Comment>` |
| POST | `/api/games/:gameId/comments` | required | `{ body, parentId? }` | `Comment` |
| PATCH | `/api/comments/:commentId` | author/admin | `{ body }` | `Comment` |
| DELETE | `/api/comments/:commentId` | author/admin | – | `{ removed: true }` |
| POST | `/api/games/:gameId/share` | required | – | `{ url, title }` (stable app URL) |
| POST | `/api/reports` | required | `{ targetType, targetId, reasonCode, details? }` | `ModerationReport` |
| GET | `/api/admin/reports?status&cursor&limit` | admin | – | `Paginated<ModerationReport>` |
| POST | `/api/admin/reports/:reportId/resolve` | admin | `{ action }` | `ModerationReport` |

Duplicate saves and duplicate reports are prevented server-side (`409 conflict`).

### Play sessions (called by the web player, untrusted input)

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/play/sessions` | optional | `{ gameId, releaseId }` | `{ sessionId, entryUrl, config }` |
| POST | `/api/play/sessions/:sessionId/heartbeat` | optional | `{ frames, fps? }` | `{ firstFrame, ended }` |
| POST | `/api/play/sessions/:sessionId/report` | optional | `{ outcome, score?, scoreUnit?, difficulty?, durationMs?, errorCode? }` | `{ alreadyReported, bestScore }` |

### Creator projects (owner only unless noted)

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/api/games/:gameId/draft` | – | `DraftState` |
| PUT | `/api/games/:gameId/draft/files/*` | raw bytes (`application/octet-stream`) | `ProjectFile` |
| GET | `/api/games/:gameId/draft/files/*` | – | raw bytes (`text/plain; charset=utf-8` for text) |
| DELETE | `/api/games/:gameId/draft/files/*` | – | `{ deleted: true }` |
| POST | `/api/games/:gameId/draft/files/rename` | `{ from, to }` | `{ from, to }` |
| POST | `/api/games/:gameId/draft/import` | raw zip bytes | `{ imported, skipped, totalBytes }` |
| GET | `/api/games/:gameId/draft/export` | – | zip bytes |
| POST | `/api/games/:gameId/draft/validate` | – | `{ ok, issues, manifest }` |
| GET | `/api/games/:gameId/versions` | – | `{ items: SourceVersionSummary[] }` |
| GET | `/api/versions/:versionId` | – | version + files |
| POST | `/api/games` | `{ title, slug, description, licenseSpdx, template }` | `{ game, draft }` |
| PATCH | `/api/games/:gameId` | `{ title?, description?, accentColor? }` | `GameCard` |
| POST | `/api/games/:gameId/build` | `{ note? }` | `BuildJob` |
| POST | `/api/games/:gameId/publish` | `{ releaseId }` | `ReleaseDetail` |
| POST | `/api/games/:gameId/unpublish` | – | `{ status }` |
| POST | `/api/games/:gameId/republish` | – | `{ status }` |
| POST | `/api/releases/:releaseId/withdraw` | `{ reason }` | `{ status }` |
| POST | `/api/releases/:releaseId/preview-grant` | – | `{ token, expiresAt, url }` |
| GET | `/api/games/:gameId/builds` | – | `{ items: BuildJob[] }` |
| GET | `/api/builds/:jobId` | – | `BuildJob` (log only for owner/admin) |
| POST | `/api/games/:gameId/remix` | `{ mode, title, slug, params?, childLicenseSpdx? }` | `{ game, draft }` |

### Internal build protocol (`Authorization: Bearer <WORKER_JOB_SECRET>`)

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/api/internal/builds/claim` | `{ workerId }` | `{ job, version, releaseId, files, manifest, limits }` or `204` |
| POST | `/api/internal/builds/:jobId/heartbeat` | `{ workerId }` | `{ ok, leaseSeconds }` |
| POST | `/api/internal/builds/:jobId/artifacts` | `{ workerId, path, contentType, entry, contentBase64 }` | `{ sha256, size, storedBytes }` |
| POST | `/api/internal/builds/:jobId/finish` | `{ workerId, manifest, log }` | `{ releaseId }` |
| POST | `/api/internal/builds/:jobId/fail` | `{ workerId, code, message, diagnostics, log }` | `{ ok: true }` |
| GET | `/api/internal/preview-grants/:releaseId?token=` | – | `{ gameId }` or `403` |

Worker authentication uses `WORKER_JOB_SECRET` (constant-time compare), never the API session.

## Status codes

| Code | Meaning |
| --- | --- |
| 400 | `invalid_request`, `validation_failed` (with `details.issues`) |
| 401 | `unauthenticated` |
| 403 | `forbidden` (authz or CSRF failure) |
| 404 | `not_found` |
| 409 | `conflict` (duplicate save/report, already published) |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `quota_exceeded`, `license_rejected`, `remix_not_allowed`, `build_failed` |
| 429 | `rate_limited` |
| 5xx | `internal_error`, `storage_error`, `unavailable` |

## Limits

Every limit is configurable (see `.env.example` and `docs/LIMITS.md`) and is returned by
`GET /api/meta` so the UI never hard-codes a number.

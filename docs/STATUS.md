# Status

An honest inventory of what exists in this repository, what is verified, and what is not.
Last updated for the first alpha (v0.1.0).

## Verified end to end

Everything below was executed on this machine, not inferred:

| Flow | How it was verified |
| --- | --- |
| `npm run typecheck` | clean across packages, apps, examples and tests |
| `npm run lint` | clean (ESLint flat config, typescript-eslint) |
| `npm test` | 268 unit + 232 integration tests passing, 9 skipped (S3 contract) |
| Migrations | `npm run migrate` applies 3 migrations to a fresh database |
| Seed | `npm run seed` creates 3 creators and **builds and publishes all 3 template games** |
| API | register/login, feed (For You / Following / Saved), reactions, saves, comments, follows, share, reports, play sessions, scores, source listing, lineage |
| Publishing | create from template → edit file → validate → build (`ready_for_review`) → publish → publicly visible → unpublish |
| Game origin | artifacts served with immutable caching, full CSP + `nosniff` + Permissions-Policy + COOP/CORP, path traversal rejected, SDK served |
| Remixing | parameter remix (schema-validated) and source remix (shares parent blobs, builds and publishes independently, attribution + lineage preserved) |
| Build isolation | child-process with memory/time caps and a scrubbed environment; Docker mode implemented and exercised |
| Web app | production build succeeds; in a real browser the feed renders, the game boots inside the sandboxed iframe and runs (`mo:ready` → `mo:init` → `mo:start`) |
| Creator CLI | `moydan validate|build|test|pack` works for all three templates |
| Desktop (Tauri) | Linux binary builds and links against WebKitGTK; Windows target cross-builds |
| Android | Gradle `assembleRelease` produces an installable APK |
| Flatpak | low-level `flatpak build` + `build-bundle` produces a `.flatpak` |

## Known limitations (deliberate)

| Limitation | Why |
| --- | --- |
| Scores are client-reported and labelled *unverified* | No server-side verification exists; a competitive mode would need one |
| Remixes need the author to opt in | `remix.allowed` is required; the platform never re-enables remixing on a creator's behalf |
| Rate limits are per-process | A multi-instance deployment needs a shared limiter |
| `fs` storage driver is development-only | Production boot refuses it; S3-compatible storage is required |
| Single-database (SQLite) | `DATABASE_DRIVER=postgres` is declared but not implemented; port the migrations |
| No remote IDE | File editing is a textarea, not a full editor; a real IDE was explicitly out of scope for the core lifecycle |
| No push/websocket | Play telemetry is polled on an interval, not streamed |
| Type errors in a *game project* are not caught at build time | The build strips types; `moydan test` runs static checks, not `tsc` |

## Not implemented

- External Git provider integration (explicitly removed by the native-storage architecture update).
- Email verification, password reset, MFA.
- Multi-language UI (English only).
- Offline/PWA service worker.
- Admin UI beyond the moderation queue.
- Automated browser (Playwright) specs — the config exists, the specs do not.

## Known defects fixed since the first assembly pass

Recorded because each was a real, reproducible failure, not a style issue:

1. `sha256HexSync` imported from `@moydan/core`, which never exported it — the API could not start.
2. Template lookup used a non-existent `id` field — every template 404'd.
3. `CONTENT_TYPES` lacked `.ts`/`.tsx`/`.jsx`/`.cjs` and licence files, so **every** TypeScript source file was rejected on upload.
4. `encoding = ""` was unquoted in SQL (identifier, not string literal) — `finishBuild` threw.
5. `AS distinct` used a SQLite reserved word — every play session 500'd.
6. Zip export used `mtime: 0`, outside the representable range — export always 500'd.
7. The feed fed `row.game` from a query that selected `g.*` — the For You feed crashed.
8. Query parameters arrive as strings but were validated as numbers — every paginated endpoint returned 400.
9. The game origin passed `{driver, root}` to a factory expecting `{driver, fsRoot}` — the origin could not boot.
10. `BRIDGE_MESSAGE_PREFIX` had been renamed to `moydan` while every message type is `mo:*` — **no game could ever start**.
11. Build idempotency keyed only on the tree hash — two projects from one template shared a release (cross-tenant), and an unedited source remix could never be built.
12. The For You ranking used `julianday('now')` as a sort key — page 2 could repeat the boundary item.
13. Playback only started from an `IntersectionObserver` callback — where the observer never fires, nothing ever played.
14. Email was validated as a bare string — `not-an-email` was accepted as an account address.
15. `LICENSE-MIT` and `ASSET_LICENSES.md` were misclassified, so required notices were not carried.
16. The owner's view of an unbuilt release returned 500 instead of their build state.

## Reproducing the verification

```bash
npm install
cp .env.example .env
npm run vendor:toolchain
npm run migrate && npm run seed
npm run dev            # http://localhost:5173
npm run typecheck && npm run lint && npm test && npm run build
```

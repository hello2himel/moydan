# Deployment

Moydan runs as four processes plus two external services. Everything is configured by environment
variables; `.env.example` is the annotated reference and contains no real secrets.

## Required services

| Service | Purpose | Production requirement |
| --- | --- | --- |
| Relational database | Structured application state | The bundled SQLite driver is fine for a single node. `DATABASE_DRIVER=postgres` is declared but **not implemented** — port the migrations first |
| Object storage (S3-compatible) | Source blobs, artifacts, previews | Cloudflare R2, AWS S3, MinIO, Garage. `STORAGE_DRIVER=fs` is development only and boot is refused in production |
| CDN | Immutable release delivery | `CDN_BASE_URL` in front of the game origin, with `Cache-Control: public, max-age=31536000, immutable` on `/r/<releaseId>/…` |
| Game content origin | Untrusted content | **Must be a different origin than the app.** Recommended: a dedicated subdomain with its own certificate |
| Build workers | Compilation | Container-isolated (`BUILD_USE_DOCKER=1`), `BUILD_WORKSPACE_ROOT` on tmpfs, no egress |
| Job queue | Build jobs | The build queue is a database table with leases — no broker needed for a single-region deployment |

## Processes

```bash
npm run migrate                 # once per deploy, before the new API starts
node apps/api/src/server.ts                       # app origin
node apps/game-origin/src/server.ts              # game origin
node apps/worker/src/main.ts                     # one or more
npm run build -w @moydan/web && serve apps/web/dist   # app origin (CDN or static host)
```

Run them under a supervisor (systemd, Docker Compose, Kubernetes). The API and worker shut down
cleanly on `SIGTERM`; the worker stops claiming new jobs before exiting.

## Minimum production configuration

```bash
NODE_ENV=production
APP_ORIGIN=https://moydan.example
GAME_ORIGIN=https://play.moydan.example     # different host: required
CDN_BASE_URL=https://cdn.moydan.example     # optional; fronts GAME_ORIGIN
SESSION_SECRET=$(openssl rand -hex 32)      # required, 32+ chars
WORKER_JOB_SECRET=$(openssl rand -hex 32)   # required, 32+ chars
DATABASE_URL=file:/var/lib/moydan/moydan.db # or your Postgres plan

STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=moydan
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false                  # true for MinIO/Garage

BUILD_USE_DOCKER=1
BUILD_MEMORY_MB=768
BUILD_TIMEOUT_MS=120000
BUILD_WORKSPACE_ROOT=/dev/shm/moydan-build
```

`assertConfigSafety()` fails fast on a missing/weak secret, a shared app/game host, the `fs`
storage driver, incomplete S3 credentials, non-HTTPS origins, or disabled container isolation.

## Migrations

- Plain SQL files in `apps/api/migrations/`, applied in filename order by `npm run migrate`.
- Each migration is recorded with a checksum. If an applied migration's file changes, the tool
  reports **drift** instead of silently re-running it.
- `--dry-run` lists what would be applied.
- Migrations are additive by policy: no destructive column drops or data rewrites. Rolling back a
  schema means shipping a new forward migration.

## Backups

| Data | Where | Recommendation |
| --- | --- | --- |
| Relational database | `DATABASE_URL` | Daily snapshot + WAL archive; test a restore |
| Object storage blobs | S3 bucket | Provider-side versioning/replication; blobs are content-addressed, so an old version is always readable by digest |
| Build workspaces | tmpfs | None needed (disposable) |

A database backup without matching blobs is not restorable; back up both, and test the pair.

## CDN and caching

| Path | Cache policy |
| --- | --- |
| `/r/<releaseId>/…` | `public, max-age=31536000, immutable` (the release id changes for every publication) |
| `/sdk/moydan-sdk.js` | `public, max-age=31536000, immutable` |
| `/preview/<releaseId>/<token>/…` | `private, max-age=300` (grants expire) |
| `/api/…` | `no-store` |

Never purge or mutate a published release's objects: historical remixes and shared links depend on
them remaining byte-identical.

## Scaling notes

- **API**: stateless except for the database. Multiple instances are fine; per-process rate limits
  become per-instance, which is a known limitation (see [SECURITY.md](SECURITY.md)).
- **Worker**: horizontally scalable. Jobs are claimed with a lease; `BUILD_JOB_LEASE_SECONDS` must
  exceed the slowest expected build. A worker that dies mid-build has its job reclaimed after the
  lease expires, up to `maxBuildAttempts`.
- **Game origin**: cacheable and stateless; put the CDN in front.

## Observability

Structured JSON logs from every process (`createLogger`), with request logs carrying method, path,
status, duration and user id, and secrets redacted. Track: time to first playable, artifact size
distribution, build failure rate by error code, upload rejection reasons, and bridge error rates.
`game_metrics` holds derived counters; `security_events` holds publication and moderation audit
trails.

## Mobile/Desktop releases

Packaged desktop and mobile builds of the client are produced separately from the web app; see
[RELEASES.md](RELEASES.md) for how they are built and what they wrap.

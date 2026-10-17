# Operations: limits, quotas, storage

Every number below is configuration, not code. `packages/core/src/limits.ts` defines the shape,
`.env.example` shows the environment names, `GET /api/meta` publishes the effective values to the
UI, and validation errors name the limit that was hit.

## Upload and project limits

| Limit | Default | Error |
| --- | --- | --- |
| `maxFileBytes` | 4 MiB | `payload_too_large` naming the file |
| `maxProjectFiles` | 400 | `quota_exceeded` |
| `maxSourceBytes` | 20 MiB | `quota_exceeded` |
| `maxArchiveBytes` | 16 MiB | `payload_too_large` |
| `maxArchiveExpandedBytes` | 64 MiB | `validation_failed` (archive bomb) |
| `maxArchiveRatio` | 100× | `validation_failed` (compression bomb) |
| `maxArchiveEntries` | 600 | `validation_failed` |
| `maxManifestBytes` | 256 KiB | `payload_too_large` |
| `maxUploadsPerHour` | 120 | `rate_limited` |

## Build and artifact limits

| Limit | Default |
| --- | --- |
| `maxArtifactBytes` | 24 MiB per release |
| `maxArtifactFiles` | 400 |
| `maxFirstPlayableBytes` | 4 MiB (index + game bundle) |
| `buildTimeoutMs` | 120 000 |
| `buildMemoryMb` | 768 |
| `buildJobLeaseSeconds` | 300 |
| `maxBuildJobsPerDay` | 50 per account |
| `maxBuildAttempts` | 2 |

The first-playable budget is a *performance target*, not a licence to truncate assets: a game that
needs more should lazy-load optional assets, and the manifest can declare its own budget so the
author sees the disagreement before building.

## Runtime budgets

| Limit | Default |
| --- | --- |
| `runtimeMaxInitMs` | 12 000 ms before a watchdog failure UI |
| `runtimeHeartbeatMs` | 2 000 ms expected heartbeat |
| `runtimeMaxMessageBytes` | 8 KiB per bridge message |
| `runtimeMessagesPerSecond` | 30 per sender |

## Per-account quotas

| Quota | Default |
| --- | --- |
| `quotaUserSourceBytes` | 50 MiB of source blobs |
| `quotaUserReleaseBytes` | 100 MiB of published artifacts |
| `maxGamesPerUser` | 50 projects |
| `maxCommentsPerMinute` | 8 |
| `maxReportsPerHour` | 20 |

`storage_usage` tracks these incrementally (never by scanning storage per request), and
`GET /api/me/storage` shows the user their current usage and limits.

## Storage accounting

Bytes are accounted in four classes, because they have different lifecycles:

| Class | Contents | Retention |
| --- | --- | --- |
| Source blobs | project files, manifests, licences | while referenced by a draft, version or live build |
| Release artifacts | published `index.html`, bundles, assets | **never auto-deleted** while a release is live or referenced by a remix |
| Preview assets | thumbnails, preview images | configurable; unused previews are collectable |
| Temporary | in-flight uploads, build workspaces | removed at job completion; failed uploads expire |

## Garbage collection

```bash
npm run gc              # dry-run first if you like: it prints what it would remove
```

GC deletes a blob only when it has **zero** references across `draft_files`, `version_files`,
`release_files` and claimed build jobs, and it is older than the retention window. It runs
reference counting in SQL against indexed columns; it never lists the object store to decide what
is in use. Concurrency is safe because a blob that gains a reference between the count and the
delete is re-inserted by the writer, and the worst case is a failed delete, not data loss.

Dedup means identical content across projects (for example an untouched template file) is stored
once; the reference count, not the byte count, decides safety.

## Retention policy (configurable)

| Data | Default policy |
| --- | --- |
| Abandoned drafts | kept indefinitely (they are user data); the user deletes them |
| Failed builds | rows kept for diagnostics; their blobs become collectable once unreferenced |
| Build workspaces | deleted when the job finishes, successfully or not |
| Expired preview grants | rows pruned after expiry; artifacts stay (they belong to the release) |
| Sessions | expire after 30 days |
| Play sessions / scores | retained; aggregated into `game_metrics` |

Published releases and the source snapshots a live game or a valid remix depends on are never
deleted automatically. Legal takedown is an explicit, audited moderation action.

# Testing

```bash
npm run typecheck        # tsc --noEmit over packages, apps, examples and tests
npm run lint             # ESLint flat config
npm test                 # unit + integration (Vitest)
npm run build            # production web build
npm run test:e2e         # Playwright, requires a running stack
```

## Suites

### Unit (`packages/*/test`, project `unit`)

Fast, no I/O. Covers the pure contracts that everything else depends on:

- **Manifest**: schema rejection (unknown keys, bad enum, out-of-range), entry-point rules,
  engine pinning, runtime API compatibility, asset/licence cross-checks, remix declaration
  coherence, budget validation.
- **Licences**: known/unknown SPDX, code-vs-asset applicability, share-alike compatibility,
  prohibited cases, notice requirements.
- **Paths/media**: traversal, absolute paths, Windows separators, reserved names, dotfiles,
  extension allow-lists, magic-byte sniffing, SVG active content, declared-type mismatch.
- **Bridge**: message schemas per direction, unknown keys, size caps, prototype-pollution keys,
  rate limiter behaviour.
- **Cursors/ids/limits**: encoding, scope mismatch, malformed input, `limitsFromEnv` fallbacks.
- **Storage keys**: deterministic, namespace-separated key derivation.

### Integration (`apps/api/test`, `packages/storage/test`, project `integration`)

Real Fastify app, real SQLite (temporary file), real object storage (temporary `fs` root; the
same driver interface is used in production against S3). HTTP-level assertions via `app.inject()`.

Proven behaviours include:

| Area | Assertions |
| --- | --- |
| Auth | register/login/logout/session, CSRF rejection for cookie writes, bearer clients exempt, session expiry, password verification |
| Feed | For You ordering and diversity, Following only returns followed creators, cursor pagination does not repeat items, empty feed for a new account |
| Social | react/unreact, save/unsave, duplicate save impossible, saved page lists the game and survives a re-read, follow/unfollow idempotency, comment create/edit/delete authorization, comment pagination, plain-text rendering contract |
| Authorization | unauthenticated writes rejected, other users' drafts/files/releases not readable, admin-only endpoints closed to users |
| Projects | create from template, file write/read/rename/delete, path policy enforced on every write, import rejects traversal entries and archives over limits, export round-trips |
| Quotas | per-file, per-project, per-account source and release budgets produce `quota_exceeded` |
| Publishing | build job lifecycle, idempotency per (tree, toolchain), artifact re-validation against DB rows, failed build never replaces the current release, publish/unpublish/withdraw transitions, preview grant expiry |
| Remixing | eligibility gate by licence and manifest, parameter validation (out-of-range/unknown keys rejected), source remix references parent blobs, parent unchanged, lineage records the exact parent version, share-alike child licence enforcement, unpublish does not delete lineage |
| Isolation | internal build endpoints reject a missing/wrong worker secret, artifact paths outside the allow-list are rejected |
| Storage | blob dedup, reference counting, GC never removes referenced blobs, usage accounting |
| Moderation | report creation, duplicate report rejected, admin queue, resolution writes an audit event |

### End-to-end (`apps/web/e2e`, Playwright)

Browser tests against a running stack cover what integration tests cannot: the feed actually
scrolling, a game loading inside the iframe and becoming playable, pause on scroll-away, restart
without duplicated instances, save state surviving a reload, the remix flow, and the creator
studio's build → preview → publish path.

## What is deliberately not tested (and why)

| Gap | Reason |
| --- | --- |
| Cryptographic verification of scores | Scores are explicitly unverified client input; there is no server-side verifier to test |
| Multi-node rate limiting | Rate limits are in-process; a shared limiter is future work |
| Real S3/MinIO behaviour | The `fs` driver implements the same interface; CI can point `STORAGE_DRIVER=s3` at a MinIO container for a production-parity run |
| Docker-enforced build limits | `BUILD_USE_DOCKER=1` is a deployment mode; the child-process path is what CI exercises |

## Conventions

- Integration tests create their own temporary directory and database, and clean up after
  themselves. No test touches a developer's `var/` data.
- Time is injected where it matters (`now` in `ApiDeps`) so time-dependent behaviour is
  deterministic.
- Tests assert on public API shapes and error codes, not on internal implementation details.

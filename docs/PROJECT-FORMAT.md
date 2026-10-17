# Project format

A Moydan project is a small directory tree. It is the unit of creation, editing, versioning,
remixing and publication. There is no package manager inside a project, no build script the
platform executes, and no external repository requirement.

## Layout

```
my-game/
├── game.json          # manifest (required)
├── LICENSE            # licence text (required; or license.file in the manifest)
├── README.md          # optional
├── src/               # TypeScript/JavaScript sources; one declared entry point
│   ├── main.ts
│   └── game.ts
├── assets/            # images, audio, fonts, data files (each needs a licence entry)
└── tests/             # optional; not part of the published artifact
```

Rules enforced by `packages/core/src/paths.ts`:

- Paths are relative, forward-slash separated, at most 160 characters, with no `.`/`..`/empty
  segments, no leading `/`, no Windows drive letters, no control characters, no reserved Windows
  device names, no `.git`, `node_modules`, `__MACOSX` or dotfile entries.
- Extensions are allow-listed **by directory**: `src/` accepts code and text formats, `assets/`
  and `public/` accept media/data formats, the root accepts documents plus `LICENSE`.
- Anything else is rejected with a specific reason (`traversal`, `absolute`, `reserved`, …). The
  same function validates uploads, archive entries, remix copies and build output.

## `game.json`

`manifestVersion: 1`. Validation is schema-first, then cross-checked against the actual file tree,
the platform engine allow-list and the runtime API version. Unknown keys are rejected.

```jsonc
{
  "manifestVersion": 1,
  "slug": "bounce-dodge",
  "title": "Bounce Dodge",
  "description": "Move to dodge falling blocks. Survive as long as you can.",
  "engine": { "name": "canvas2d", "version": "1.0.0" },   // or phaser 4.2.1 (pinned, vendored)
  "runtime": { "apiVersion": "1", "minApiVersion": "1" },
  "entry": "src/main.ts",
  "orientation": "portrait",
  "viewport": { "width": 720, "height": 1280, "scale": "fit" },
  "input": ["pointer", "touch", "keyboard"],
  "capabilities": ["storage", "score", "audio"],
  "license": {
    "spdx": "MIT",
    "file": "LICENSE",
    "attributionText": "© 2026 Example Author",
    "assets": [
      { "path": "assets/*.svg", "license": "CC0-1.0", "source": "drawn by the author" }
    ]
  },
  "remix": {
    "allowed": true,
    "modes": ["parameters", "source"],
    "parameters": [
      { "key": "speed", "label": "Fall speed", "type": "number", "min": 0.5, "max": 3, "step": 0.1, "default": 1 },
      { "key": "lives", "label": "Lives", "type": "number", "min": 1, "max": 5, "default": 3 },
      { "key": "accent", "label": "Accent colour", "type": "color", "default": "#7c5cff" },
      { "key": "sound", "label": "Sound", "type": "boolean", "default": true }
    ]
  },
  "presentation": { "thumbnail": "assets/thumb.svg", "accentColor": "#7c5cff", "tags": ["reflex"] },
  "authors": [{ "name": "Example Author" }],
  "budgets": { "firstPlayableBytes": 1500000 }
}
```

### Field notes

| Field | Rules |
| --- | --- |
| `slug` | 3–40 chars, lowercase/digits/single hyphens, at least one letter, unique per creator |
| `title` / `description` | 1–60 / 1–280 chars |
| `engine.version` | Exact pinned version. `canvas2d` `1.0.0` (platform helpers) or `phaser` `4.2.1` (vendored; no network at build time) |
| `runtime.apiVersion` | Must be a supported bridge version (`1`). `minApiVersion` must not exceed the platform's |
| `entry` | Must exist in the project, live under `src/`, have an allowed extension. Phaser entries must be `.ts`/`.js`/`.mjs` |
| `capabilities` | Subset of `storage, score, audio, vibration, fullscreen, link-out`. The host grants the **intersection** of this list and its own policy; a Phaser project must declare `audio` |
| `license.spdx` | Must be a licence the platform understands and that applies to code |
| `license.assets` | Every file under `assets/`/`public/` must be covered by an entry (a single `*` matches within one path segment) |
| `remix` | `allowed: false` requires an empty `modes` array; `parameters` mode requires at least one parameter; parameter keys are unique lowercase identifiers; `default` must be inside the declared range/options |
| `repository` | Optional and informational (`provider` + `https` `url`). Never required for publication, never fetched by the platform |

## Validation rules you will hit

- Missing `game.json` → `required`.
- Entry file missing or not under `src/` → `not_allowed` / `bad_format`.
- Licence file declared but absent → rejected; an asset with no licence entry → rejected.
- Active content in SVG (script, `foreignObject`, animation, external references) → rejected.
- A `.png` whose bytes are not a PNG → rejected by magic-byte sniffing, regardless of the
  declared MIME type.
- Unsupported engine version or runtime API → rejected before anything is stored.
- Every issue is returned with its JSON path (`license.assets[0].license`) so the studio can point
  at the exact place.

## Drafts, versions and releases

```
game_drafts + draft_files     mutable working copy (revision counter)
        │  publish / remix snapshot
        ▼
source_versions + version_files   immutable snapshot (tree_hash, manifest_hash, licence, notices)
        │  build
        ▼
releases + release_files          immutable artifact (artifact_hash, immutable URLs)
```

- Editing the draft never touches a version or a release.
- A snapshot is a set of `version_files` rows pointing at `blobs.sha256` — no bytes are copied.
  `tree_hash` is derived from the sorted `(path, sha256, size)` triples, so identical trees always
  produce identical identifiers.
- A release is written once at `finishBuild`, verified against the database rows (not the worker's
  claims), then either previewed or published. It is never mutated; withdrawing changes status and
  records a moderation event.
- `releases.sequence` increases per game. Historical remix relations keep pointing at the exact
  version they were created from.

## Blobs and deduplication

Every file body is hashed with SHA-256 before it is stored. Identical bytes are stored once per
storage namespace (`blobs` is keyed by the digest). Two projects that share a template file share
the blob; editing one file creates a new blob and re-points a single row.

Deduplication is a storage optimisation, never an authorisation mechanism: draft files, preview
grants and private releases are only ever read after an ownership/visibility check in the API, and
published artifacts are served from immutable public URLs while drafts are not.

Garbage collection (`npm run gc`) removes only blobs with zero references across
`draft_files`, `version_files`, `release_files` and in-flight builds, older than a configurable
retention window. See [OPERATIONS.md](OPERATIONS.md).

## Artifact layout

A build produces a flat, browser-ready directory:

```
index.html        host document: viewport meta, error box, two module scripts, no inline script
game.js           the bundled entry (+ engine if Phaser)
assets/…          copied verbatim after content-type verification
```

The manifest written into object storage records every file with its size, content type,
encodings and digest, plus `totalBytes` and `firstPlayableBytes` (`index.html` + `game.js`).
Source maps and TypeScript sources are never published.

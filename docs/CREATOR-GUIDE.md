# Creator guide

From an empty directory to a published, playable, remixable game.

## 1. Scaffold

```bash
npx moydan init canvas2d --dir my-game     # zero-dependency Canvas game
npx moydan init phaser   --dir my-phaser   # Phaser 4 timing game
```

Or copy a complete reference project:

```bash
cp -r examples/pattern-grid my-game
```

The three bundled templates are ordinary projects — same manifest schema, same licence rules,
same build pipeline as anything a creator uploads:

| Template | Mechanic | Engine |
| --- | --- | --- |
| `bounce-dodge` | movement / dodging | canvas2d |
| `pulse-tap` | timing / rhythm | phaser 4.2.1 |
| `pattern-grid` | puzzle / memory | canvas2d |

## 2. Write the game

A game is a module that talks to the host through `@moydan/sdk`. There is no framework
requirement, no build script and no `package.json`: the platform compiles your `entry` with a
pinned esbuild and ships the bundle.

```ts
// src/main.ts
import { defineGame, setupCanvas } from '@moydan/sdk';

defineGame({
  create(api) {
    const { ctx, width, height, dispose } = setupCanvas(api);
    const speed = Number(api.params.speed ?? 1);   // validated against game.json
    let x = width / 2;
    let score = 0;

    const pointer = (event: PointerEvent) => {
      const box = api.root.getBoundingClientRect();
      x = ((event.clientX - box.left) / box.width) * width;
    };
    api.root.addEventListener('pointermove', pointer);

    // A pause-aware rAF loop: it stops when the host pauses and cleans up on dispose.
    const loop = api.createLoop((deltaMs) => {
      score += deltaMs * speed * 0.01;
      ctx.clearRect(0, 0, width, height);
      ctx.fillRect(x - 16, height - 48, 32, 32);
      if (score > 100) {
        api.score(Math.floor(score));     // unverified: it is the client's own number
        api.ended({ reason: 'game-over', score: Math.floor(score) });
      }
    });

    return {
      start() { /* assets, audio, first frame */ },
      dispose() {
        loop.stop();
        api.root.removeEventListener('pointermove', pointer);
        dispose();
      },
    };
  },
});
```

Full API: [SDK.md](SDK.md). Rules that are enforced, not advised:

- Only the SDK is available. The game cannot reach the parent DOM, cookies, tokens or the API.
- Everything the game sends is validated. Unknown message types and extra fields are dropped.
- Pause when the host says pause; release timers, listeners and audio when disposed.
- Client-reported scores are **unverified**. Do not present them as cheat-proof.

## 3. Validate locally

```bash
npx moydan validate          # manifest + licence + asset declarations
npx moydan test              # lifecycle/static checks, no browser needed
npx moydan build             # bundles to dist/ and prints the first-playable budget
npx moydan dev               # local preview with production CSP headers
```

`moydan validate` prints every issue with its path, e.g.

```
game.json: engine.version must be exactly "4.2.1" (got "3.90.0")
game.json: license.assets asset "assets/logo.png" has no licence declaration
```

## 4. Publish

**In the studio (recommended).** Sign in → **Create** → pick a template (or import a `.zip` from
`moydan pack`) → edit files → **Validate** → **Build** → **Preview** → **Publish**.

**What the platform does for you**

1. Snapshots your draft into an immutable source version.
2. Queues a build job (idempotent per tree hash + toolchain).
3. A worker claims it, compiles in isolation (no network, no credentials, memory and time
   limits), uploads each artifact file, and the API re-validates the set against the database.
4. The release becomes `ready_for_review`; you get a preview URL with a signed, expiring grant.
5. **Publish** makes that release the game's public release.

**What you must get right**

- A licence the platform accepts, and a licence entry for every asset (see
  [LICENSING.md](LICENSING.md)).
- A `LICENSE` file that matches the declared SPDX identifier.
- A manifest that validates with zero errors.
- Assets that are yours to redistribute.

## 5. Update a published game

Editing the draft changes nothing for players. To ship an update: **Build** again → **Preview** →
**Publish**. Each publication is a new immutable release; the previous one stays downloadable for
historical remixes, and `entryUrl`s of old versions keep working (they are content-addressed by
release id).

## 6. Get remixed (or remix others)

Declare remix support in `game.json`:

```jsonc
"remix": {
  "allowed": true,
  "modes": ["parameters", "source"],
  "parameters": [ /* schema-validated, no arbitrary code */ ]
}
```

- **Parameter remixes** let anyone change declared values only. The platform validates against
  your schema, stores a small configuration record, and reuses the parent's bundle.
- **Source remixes** copy your project as a new draft that references your blobs. The remixer's
  edits create new blobs; your version never changes.

You keep the credit and the licence conditions: attribution and required notices travel with every
descendant, and share-alike licences constrain what a derivative may declare. Details in
[REMIX.md](REMIX.md).

## 7. Deploy your own instance

See [DEPLOYMENT.md](DEPLOYMENT.md). For local development everything runs with defaults from
`.env.example`. Before exposing a deployment publicly, `assertConfigSafety()` will refuse to start
unless you have real secrets, a distinct game origin, S3-compatible storage and container-isolated
builds.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `manifest has no game.json` | Missing manifest at the project root | Add it; `moydan validate` reports the path |
| `entry point "src/main.ts" is not part of the project` | Entry mismatch | Match the manifest to the file tree exactly |
| `asset "assets/x.png" has no licence declaration` | Undeclared asset | Add a `license.assets` entry covering it |
| `runtime API version "2" is not supported` | Future SDK | Stay on `1`, or ask for a platform release that implements it |
| `The build failed` with `out of memory` | Bundle too large | Split the project; check `MAX_ARTIFACT_BYTES` |
| Game works locally, not in the feed | CSP / external request | Only self-hosted resources; no remote fetches |

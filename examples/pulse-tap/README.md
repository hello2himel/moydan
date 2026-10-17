# Pulse Tap

A timing/rhythm game built with **Phaser 4** on the Moydan platform: a ring breathes in and out,
and you tap when it crosses the target band. Hit dead centre for a perfect, build a combo, and
keep three lives.

It is a complete, ordinary Moydan project — the same manifest, the same build pipeline and the
same licensing rules as anything a creator uploads. Nothing about it is special-cased.

## Play it

```bash
moydan validate .     # manifest, licence and asset declarations
moydan test .         # lifecycle/static checks (no browser needed)
moydan build .        # bundles to dist/ with Phaser resolved from the vendored toolchain
moydan dev .          # local preview with the production CSP headers
```

Or start it from a Moydan deployment: **Create → Pulse Tap**, then change the declared parameters
(tempo, target band, lives, accent colour, perfect bonus, sound) and publish a parameter remix.

## What it demonstrates

| Feature | Where |
| --- | --- |
| A pinned, vendored engine (`phaser@4.2.1`) resolved without a network fetch | `game.json` → `engine` |
| Host lifecycle: `pause` / `resume` / `mute` / `dispose` | `src/main.ts` → returned instance |
| Parameter remixes validated against the manifest | `params` in `src/main.ts` |
| Namespaced, host-mediated storage for the personal best | `api.storage` |
| Score submission (client-reported, unverified) | `api.score` / `api.ended` |
| A declarative asset licence | `game.json` → `license.assets` |

## Remixing it

`game.json` declares six parameters, so a quick remix only changes values — the platform
validates each one against the declared range and never executes anything from the editor.
For a deeper fork, take a **source remix**: the new draft starts as references to these very
blobs, and only the files you edit produce new ones.

## Licence

MIT — see [LICENSE](LICENSE). The artwork in `assets/ui/` was drawn for this example and is
declared in the manifest. Engine: Phaser 4 (MIT), supplied by the platform toolchain.

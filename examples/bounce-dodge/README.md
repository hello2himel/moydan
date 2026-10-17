# Bounce Dodge

A portrait reflex game for the Moydan canvas runtime. Drag anywhere to move your
bar, dodge the blocks that bounce down the screen, and survive as long as you can.

- **Score** is survival time in milliseconds, submitted live while you play and
  once more when the run ends.
- **Lives** come from the `lives` remix parameter; a hit clears the field so you
  always get a clean restart of the fall.
- **Best time** is kept in host-mediated storage (`bounce-dodge.best`).
- **Sound** is synthesised with Web Audio — there is no audio asset to download.
  The host's mute button always wins.

## Run it

From the platform checkout:

```sh
moydan validate examples/bounce-dodge   # manifest, licences and asset declarations
moydan dev examples/bounce-dodge        # watch + preview at http://localhost:5175
moydan build examples/bounce-dodge      # bundle to examples/bounce-dodge/dist
moydan test examples/bounce-dodge       # lifecycle and sandbox smoke checks
moydan pack examples/bounce-dodge       # deterministic zip for the web studio
```

The preview harness embeds the game in an iframe with the same `sandbox`
attributes and Content-Security-Policy the platform uses, and speaks the bridge
protocol, so pause, restart, mute and storage all behave like a real session.

## Layout

```
game.json            manifest: engine, viewport, capabilities, remix parameters
LICENSE              MIT, referenced by game.json -> license.file
assets/ui/mark.svg   shield mark, used for the HUD and the thumbnail
src/main.ts          the whole game (entry point declared in game.json)
src/audio.ts         tiny Web Audio helper: gestures, mute, dispose
```

## Making it yours

The remix parameters in `game.json` are the knobs the studio exposes:

| key       | what it changes                                        |
| --------- | ------------------------------------------------------ |
| `speed`   | how fast blocks fall (0.6 – 2.5)                       |
| `lives`   | hits you can take (1 – 5)                              |
| `accent`  | the colour of the bar, the blocks and the life pips    |
| `shake`   | screen shake on a hit                                  |
| `sound`   | the Web Audio blips                                    |

To change something the parameters do not cover, edit `src/main.ts`:

- **Pacing** — `FIRST_SURGE_MS` / `SURGE_INTERVAL_MS` control the five-block rows
  that arrive with a single gap every ten seconds or so.
- **Difficulty curve** — `difficulty` (one line in the loop) scales spawn rate and
  fall speed with survival time.
- **Art** — `draw()` paints in design coordinates (`720x1280`); `setupCanvas`
  keeps that mapping on any screen size, so no coordinate maths needs changing.

Two rules the example follows, worth keeping in your own games:

1. **Tear everything down in `dispose()`** — listeners, the loop handle, the audio
   context and the HUD. The host disposes an instance for good; leaking a
   `requestAnimationFrame` is what makes rematches stutter.
2. **Never touch `requestAnimationFrame` yourself** — `api.createLoop()` is tied
   to the host lifecycle and is suspended automatically when the tab is hidden.

## Licence

MIT — see [LICENSE](LICENSE). The SVG mark is original artwork for this example
and is declared in `game.json` → `license.assets`.

# Pattern Grid

A pattern-recognition puzzle for the Moydan canvas runtime. The grid lights up a
sequence, you repeat it, and every round is one cell longer. Three wrong presses
and the run is over.

- **Score** grows while you play (10 points per cell, a bonus for every fourth
  consecutive hit, and a round bonus) and is submitted on every correct press.
- **Lives** come from the `lives` remix parameter; a wrong press costs one and
  replays the same sequence from the start.
- **Input** is pointer/touch on the grid, or the number keys `1`–`9` in reading
  order — both go through the same `press()` function.
- **Best score** is kept in host-mediated storage (`pattern-grid.best`).
- **Sound** is synthesised per cell (a rising scale), so there is no audio asset
  to download. The host's mute button always wins.

## Run it

From the platform checkout:

```sh
moydan validate examples/pattern-grid   # manifest, licences and asset declarations
moydan dev examples/pattern-grid        # watch + preview at http://localhost:5175
moydan build examples/pattern-grid      # bundle to examples/pattern-grid/dist
moydan test examples/pattern-grid       # lifecycle and sandbox smoke checks
moydan pack examples/pattern-grid       # deterministic zip for the web studio
```

Use the harness (the page at `http://localhost:5175`) to try pause, restart,
mute and hidden-tab behaviour without leaving the preview.

## Layout

```
game.json                 manifest: engine, viewport, capabilities, remix parameters
LICENSE                   MIT, referenced by game.json -> license.file
assets/ui/grid-mark.svg   3x3 grid glyph, used for the HUD and the thumbnail
src/main.ts               the whole game (entry point declared in game.json)
src/audio.ts              tiny Web Audio helper: gestures, mute, dispose
```

## Making it yours

| key           | what it changes                                       |
| ------------- | ----------------------------------------------------- |
| `lives`       | wrong presses you can afford (1 – 5)                   |
| `flashMs`     | how long a cell stays lit during the reveal (200-900) |
| `startLength` | length of the very first sequence (2 – 9)              |
| `accent`      | colour of a lit cell and its glow                      |
| `sound`       | the per-cell Web Audio notes                           |

Things worth copying from this example:

1. **A phase machine instead of timers.** `reveal -> pause -> input -> pause ->
   reveal` is driven from the loop, so `pause()` and a hidden tab cannot strand
   the game half way through a reveal.
2. **One input path.** Pointer and keyboard both call `press(index)`, so a fix
   to the rules can never be applied to only one of them.
3. **Pointer mapping.** `toDesign()` inverts the canvas transform, so a tap on a
   400 px-wide phone selects the same cell as a click on a 1200 px desktop.

## Licence

MIT — see [LICENSE](LICENSE). The SVG mark is original artwork for this example
and is declared in `game.json` → `license.assets`.

/**
 * Project scaffolding for `moydan init`.
 *
 * Why strings and not files on disk: the CLI ships as one bundle, so a template
 * that lives in a separate directory would break a global install. Each
 * template produces exactly the files the project format allows — `game.json`,
 * `LICENSE`, `README.md`, `src/main.ts`, `tsconfig.json` — and every one of
 * them passes the real platform validator, so a fresh project is upload-ready
 * instead of "fix the manifest first".
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { slugShape } from '@moydan/core';
import { CliError } from './ui.ts';

export interface TemplateDescriptor {
  id: string;
  label: string;
  description: string;
  engine: string;
  mechanic: string;
}

export const TEMPLATES: TemplateDescriptor[] = [
  {
    id: 'canvas2d',
    label: 'Canvas 2D minimal (one-button survival)',
    description: 'Platform canvas helpers, no engine. Tap-and-hold to thrust a drifting orb; survive as long as you can.',
    engine: 'canvas2d',
    mechanic: 'one-button survival',
  },
  {
    id: 'phaser',
    label: 'Phaser 4 minimal (tap to reverse)',
    description: 'Phaser 4.2.1, vendored by the platform. Tap to reverse a spinning wedge and chain colour combos.',
    engine: 'phaser',
    mechanic: 'tap timing',
  },
  {
    id: 'empty',
    label: 'Empty (wiring only)',
    description: 'No gameplay: a correctly wired project that draws, reacts to input and reports a score.',
    engine: 'canvas2d',
    mechanic: 'starter',
  },
];

export function findTemplate(id: string): TemplateDescriptor {
  const template = TEMPLATES.find((entry) => entry.id === id || entry.id === `${id}-minimal`);
  if (!template) {
    throw new CliError(
      `unknown template "${id}". Available: ${TEMPLATES.map((entry) => entry.id).join(', ')}`,
      2,
    );
  }
  return template;
}

export interface ScaffoldOptions {
  template: TemplateDescriptor;
  dir: string;
  slug: string;
  title: string;
  author: string;
  year: number;
}

export interface ScaffoldResult {
  root: string;
  files: string[];
}

/** Turn a directory name or free-form phrase into a manifest-legal slug. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!slugShape.validate(slug).ok) {
    throw new CliError(`"${value}" cannot be turned into a valid slug (lowercase letters, digits and single hyphens, at least one letter).`, 2);
  }
  return slug;
}

export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length > 0 ? part[0]?.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function manifestFor(template: TemplateDescriptor, options: ScaffoldOptions): string {
  const phaser = template.engine === 'phaser';
  const manifest = {
    manifestVersion: 1,
    slug: options.slug,
    title: options.title,
    description: template.description,
    engine: { name: template.engine, version: phaser ? '4.2.1' : '1.0.0' },
    runtime: { apiVersion: '1' },
    entry: 'src/main.ts',
    orientation: 'portrait',
    viewport: { width: 720, height: 1280, scale: 'fit' },
    input: ['pointer', 'touch'],
    capabilities: phaser ? ['score', 'storage', 'audio'] : ['score', 'storage'],
    license: {
      spdx: 'MIT',
      attributionText: `${options.title} by ${options.author}, MIT licensed.`,
      assets: [],
    },
    remix: {
      allowed: true,
      modes: ['parameters'],
      parameters: [
        {
          key: 'accent',
          label: 'Accent colour',
          description: 'Colour of the player and its trail.',
          group: 'Look',
          type: 'color',
          default: '#7c5cff',
        },
        ...(phaser
          ? [
              {
                key: 'spin',
                label: 'Spin speed',
                description: 'Revolutions per second of the wedge.',
                group: 'Feel',
                type: 'number',
                min: 0.5,
                max: 4,
                step: 0.1,
                default: 1.2,
              },
            ]
          : [
              {
                key: 'gravity',
                label: 'Gravity',
                description: 'Downward pull in design pixels per second squared.',
                group: 'Feel',
                type: 'number',
                min: 600,
                max: 2600,
                step: 50,
                default: 1500,
              },
              {
                key: 'thrust',
                label: 'Thrust',
                description: 'Upward impulse while the pointer is held.',
                group: 'Feel',
                type: 'number',
                min: 200,
                max: 1200,
                step: 20,
                default: 620,
              },
            ]),
      ],
    },
    presentation: {
      accentColor: '#7c5cff',
      tags: [template.engine, template.mechanic.replace(/[^a-z0-9]+/g, '-')],
    },
    budgets: { firstPlayableBytes: 131_072 },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function licenseFor(options: ScaffoldOptions): string {
  return `MIT License

Copyright (c) ${options.year} ${options.author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function readmeFor(template: TemplateDescriptor, options: ScaffoldOptions): string {
  const run = [
    '```sh',
    'moydan validate   # check game.json, licences and asset declarations',
    'moydan dev        # watch + preview at http://localhost:5175 with the real CSP',
    'moydan build      # bundle to dist/ and print the first-playable budget',
    'moydan test       # lifecycle smoke checks, no browser required',
    'moydan pack       # deterministic zip for the web studio',
    '```',
  ].join('\n');
  const files = [
    '```',
    'game.json        manifest: entry point, viewport, capabilities, remix parameters',
    'LICENSE          MIT licence text referenced by game.json',
    'src/main.ts      the whole game: entry module named by game.json',
    'tsconfig.json    type checking only; the platform builds with esbuild',
    '```',
  ].join('\n');
  const extend = phaserExtendNotes(template);
  return `# ${options.title}

${template.description}

## Run it

From the platform checkout (or after \`npm install\` in a Moydan workspace):

${run}

## Project layout

${files}

${extend}

## Licence

MIT — see [LICENSE](LICENSE). The licence is also declared in \`game.json\`
(\`license.spdx\`). Every file you add under \`assets/\` must get its own entry in
\`license.assets\`; \`moydan validate\` fails until it does.

\`moydan push\` is not part of this alpha. Build and validate locally, then use
\`moydan pack\` and upload the archive from the web studio.
`;
}

function phaserExtendNotes(template: TemplateDescriptor): string {
  if (template.engine !== 'phaser') {
    return [
      '## Making it yours',
      '',
      '- Change `accent`, `gravity` and `thrust` in `game.json` → `remix.parameters` to make new variants.',
      '- `defineGame` gives you `api.params`, `api.score`, `api.ended`, `api.storage` and a pause-aware `api.createLoop`.',
      '- `setupCanvas(api)` gives a device-pixel-ratio aware canvas that keeps the manifest viewport and resizes with the page.',
      '- Tear everything down in `dispose()` (listeners, timers, loops): the host disposes an instance for good.',
    ].join('\n');
  }
  return [
    '## Making it yours',
    '',
    '- Change `accent` and `spin` in `game.json` → `remix.parameters` to make new variants.',
    '- Phaser is pinned to 4.2.1 and is *not* bundled into your artifact: the game origin serves it from `/vendor/phaser.min.js`.',
    '- `moydan dev` serves the same pinned bundle, so what you test is what players get.',
    '- Declare every capability you use in `game.json`; Phaser projects must keep the `audio` capability.',
  ].join('\n');
}

const CANVAS_SOURCE = `/**
 * One-button survival on the platform canvas runtime.
 *
 * Hold the pointer (or the space bar) to thrust the orb upwards and let it fall
 * again. Score is the number of seconds survived, so a session lasts as long as
 * the player can keep the orb off the ceiling.
 */

import { defineGame, setupCanvas, type GameApi } from '@moydan/sdk';

interface Params {
  accent: string;
  gravity: number;
  thrust: number;
}

function numberParam(api: GameApi, key: keyof Params, fallback: number): number {
  const value = api.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

defineGame({
  create(api) {
    const canvas = setupCanvas(api);
    const { ctx, width, height } = canvas;
    const accent = typeof api.params.accent === 'string' ? api.params.accent : '#7c5cff';
    const gravity = numberParam(api, 'gravity', 1500);
    const thrust = numberParam(api, 'thrust', 620);
    const radius = Math.round(width * 0.07);
    const bestKey = 'canvas2d.best';

    let loop = api.createLoop(() => undefined);
    let orb = { x: width / 2, y: height * 0.7, vx: 0, vy: 0 };
    let holding = false;
    let elapsed = 0;
    let best = 0;
    let alive = true;

    const pointerDown = (event: PointerEvent): void => {
      holding = true;
      canvas.canvas.setPointerCapture?.(event.pointerId);
    };
    const pointerUp = (): void => {
      holding = false;
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space' || event.code === 'ArrowUp') {
        holding = true;
        event.preventDefault();
      }
    };
    const keyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space' || event.code === 'ArrowUp') holding = false;
    };

    canvas.canvas.addEventListener('pointerdown', pointerDown);
    canvas.canvas.addEventListener('pointerup', pointerUp);
    canvas.canvas.addEventListener('pointercancel', pointerUp);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);

    const reset = (): void => {
      orb = { x: width / 2, y: height * 0.7, vx: 0, vy: 0 };
      elapsed = 0;
      alive = true;
    };

    const die = (): void => {
      if (!alive) return;
      alive = false;
      const seconds = Math.floor(elapsed * 100) / 100;
      if (seconds > best) {
        best = seconds;
        void api.storage.set(bestKey, best);
      }
      api.score(seconds, { unit: 'seconds', durationMs: Math.round(elapsed * 1000) });
      api.ended({ reason: 'game-over', score: seconds, durationMs: Math.round(elapsed * 1000) });
    };

    loop = api.createLoop((deltaMs) => {
      const dt = Math.min(0.05, deltaMs / 1000);
      if (alive) {
        elapsed += dt;
        orb.vy += gravity * dt;
        if (holding) orb.vy -= thrust * dt;
        orb.vx += (width / 2 - orb.x) * 0.6 * dt;
        orb.vx *= 0.98;
        orb.x += orb.vx * dt;
        orb.y += orb.vy * dt;
        if (orb.x < radius || orb.x > width - radius) orb.vx = -orb.vx * 0.6;
        if (orb.y < radius || orb.y > height - radius) die();
        if (elapsed > 0.5) api.score(Math.floor(elapsed * 100) / 100, { unit: 'seconds' });
      }
      draw();
    });

    const draw = (): void => {
      ctx.fillStyle = '#07070d';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#1c1c30';
      ctx.lineWidth = 2;
      for (let y = 0; y < height; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e9e9f5';
      ctx.font = '600 40px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(alive ? \`\${elapsed.toFixed(2)} s\` : 'game over', width / 2, 96);
      ctx.fillStyle = '#6d6d92';
      ctx.font = '400 26px system-ui, sans-serif';
      ctx.fillText(alive ? 'hold to thrust' : \`best \${best.toFixed(2)} s\`, width / 2, 140);
    };

    void api.storage.get<number>(bestKey).then((value) => {
      if (typeof value === 'number') best = value;
    });

    draw();
    return {
      start() {
        reset();
      },
      pause() {
        holding = false;
      },
      resume() {},
      visibility(visible) {
        if (!visible) holding = false;
      },
      dispose() {
        loop.stop();
        canvas.canvas.removeEventListener('pointerdown', pointerDown);
        canvas.canvas.removeEventListener('pointerup', pointerUp);
        canvas.canvas.removeEventListener('pointercancel', pointerUp);
        window.removeEventListener('keydown', keyDown);
        window.removeEventListener('keyup', keyUp);
      },
    };
  },
});
`;

const PHASER_SOURCE = `/**
 * Tap to reverse: a wedge orbits the centre and every tap flips its spin.
 *
 * Each tap also swaps the wedge colour, so a fast player keeps a rainbow trail
 * while a hesitant one settles into a single colour. Score is the number of
 * taps; the combo counter rewards alternating hands.
 */

import Phaser from 'phaser';
import { defineGame, type GameApi } from '@moydan/sdk';

const PALETTE = ['#7c5cff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8'];

class OrbitScene extends Phaser.Scene {
  private api!: GameApi;
  private wedge!: Phaser.GameObjects.Graphics;
  private glow!: Phaser.GameObjects.Arc;
  private label!: Phaser.GameObjects.Text;
  private combo!: Phaser.GameObjects.Text;
  private angle = 0;
  private spin = 1;
  private taps = 0;
  private streak = 0;
  private accent = PALETTE[0] ?? '#7c5cff';

  constructor() {
    super({ key: 'orbit' });
  }

  init(data: { api: GameApi; spin: number; accent: string }): void {
    this.api = data.api;
    this.spin = data.spin;
    this.accent = data.accent;
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#07070d');
    this.glow = this.add.circle(width / 2, height / 2, Math.min(width, height) * 0.3, 0x7c5cff, 0.12);
    this.wedge = this.add.graphics();
    this.label = this.add
      .text(width / 2, height * 0.82, '0 taps', { fontFamily: 'system-ui, sans-serif', fontSize: '48px', color: '#e9e9f5' })
      .setOrigin(0.5);
    this.combo = this.add
      .text(width / 2, height * 0.86, '', { fontFamily: 'system-ui, sans-serif', fontSize: '28px', color: '#8a8ab0' })
      .setOrigin(0.5);
    this.input.on('pointerdown', () => this.tap());
    this.input.keyboard?.on('keydown-SPACE', () => this.tap());
    this.drawWedge();
  }

  private tap(): void {
    this.taps += 1;
    this.streak = this.streak === 0 ? 1 : this.streak + 1;
    this.spin = -this.spin;
    const next = PALETTE[this.taps % PALETTE.length] ?? this.accent;
    this.accent = next;
    this.glow.setFillStyle(Number.parseInt(next.slice(1), 16), 0.12);
    this.tweens.add({ targets: this.glow, scale: 1.25, duration: 120, yoyo: true });
    this.label.setText(this.taps + (this.taps === 1 ? ' tap' : ' taps'));
    this.combo.setText(this.streak > 2 ? 'combo x' + this.streak : ' ');
    this.api.score(this.taps, { unit: 'taps' });
  }

  private drawWedge(): void {
    const { width, height } = this.scale;
    const radius = Math.min(width, height) * 0.24;
    const cx = width / 2;
    const cy = height / 2;
    this.wedge.clear();
    this.wedge.fillStyle(Number.parseInt(this.accent.slice(1), 16), 1);
    this.wedge.beginPath();
    this.wedge.moveTo(cx + Math.cos(this.angle) * radius, cy + Math.sin(this.angle) * radius);
    this.wedge.lineTo(cx + Math.cos(this.angle + 2.2) * radius, cy + Math.sin(this.angle + 2.2) * radius);
    this.wedge.lineTo(cx, cy);
    this.wedge.closePath();
    this.wedge.fillPath();
    this.wedge.lineStyle(2, 0x2a2a44, 1);
    this.wedge.strokeCircle(cx, cy, radius);
  }

  override update(_time: number, delta: number): void {
    const { width, height } = this.scale;
    this.angle += this.spin * delta * 0.001;
    this.drawWedge();
    this.glow.setPosition(width / 2, height / 2);
  }
}

defineGame({
  create(api) {
    const { width, height } = api.viewport;
    const spinValue = typeof api.params.spin === 'number' ? api.params.spin : 1.2;
    const accent = typeof api.params.accent === 'string' ? api.params.accent : '#7c5cff';
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: api.root,
      width,
      height,
      backgroundColor: '#07070d',
      banner: false,
      audio: { noAudio: api.muted },
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [new OrbitScene()],
      callbacks: {
        preBoot: (boot) => boot.scene.start('orbit', { api, spin: spinValue, accent }),
      },
    });

    return {
      start() {
        game.loop.wake();
      },
      pause() {
        game.loop.sleep();
      },
      resume() {
        game.loop.wake();
      },
      visibility(visible) {
        if (visible) game.loop.wake();
        else game.loop.sleep();
      },
      dispose() {
        game.destroy(true);
      },
    };
  },
});
`;

const EMPTY_SOURCE = `/**
 * Starter wiring with no gameplay.
 *
 * Use it to see the whole contract in one file: a canvas that keeps the manifest
 * viewport, a pause-aware loop, pointer input, a score submission and a clean
 * dispose. Delete the drawing code and write yours.
 */

import { defineGame, setupCanvas } from '@moydan/sdk';

defineGame({
  create(api) {
    const canvas = setupCanvas(api, { className: 'starter' });
    const { ctx, width, height } = canvas;
    const accent = typeof api.params.accent === 'string' ? api.params.accent : '#7c5cff';
    let taps = 0;
    let loop = api.createLoop(() => undefined);

    const onTap = (): void => {
      taps += 1;
      api.score(taps, { unit: 'taps' });
    };
    canvas.canvas.addEventListener('pointerdown', onTap);

    loop = api.createLoop((deltaMs) => {
      const seconds = deltaMs / 1000;
      ctx.fillStyle = '#07070d';
      ctx.fillRect(0, 0, width, height);
      const radius = Math.min(width, height) * (0.18 + 0.02 * Math.sin(seconds * 2));
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e9e9f5';
      ctx.font = '600 36px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(taps) + ' taps', width / 2, height * 0.86);
    });

    return {
      start() {},
      pause() {},
      resume() {},
      dispose() {
        loop.stop();
        canvas.canvas.removeEventListener('pointerdown', onTap);
        canvas.dispose();
      },
    };
  },
});
`;

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  },
  null,
  2,
)}\n`;

function templateSource(template: TemplateDescriptor): string {
  switch (template.id) {
    case 'phaser':
      return PHASER_SOURCE;
    case 'empty':
      return EMPTY_SOURCE;
    default:
      return CANVAS_SOURCE;
  }
}

export function scaffoldProject(options: ScaffoldOptions): ScaffoldResult {
  const root = resolve(options.dir);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new CliError(`${root} is not empty; choose another --dir or remove it first.`);
  }
  const files: Array<{ path: string; content: string }> = [
    { path: 'game.json', content: manifestFor(options.template, options) },
    { path: 'LICENSE', content: licenseFor(options) },
    { path: 'README.md', content: readmeFor(options.template, options) },
    { path: 'src/main.ts', content: templateSource(options.template) },
    { path: 'tsconfig.json', content: TSCONFIG },
  ];
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return { root, files: files.map((file) => file.path) };
}

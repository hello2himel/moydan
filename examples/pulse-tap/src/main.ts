/**
 * Pulse Tap — a timing/rhythm game built on Phaser 4.
 *
 * Design notes:
 *   - one verb (tap) and one visual rule: a ring breathes in and out, and a target
 *     band sits at a fixed radius. Tap when the breathing ring crosses the band.
 *     That is readable at a glance on a phone and on a desktop;
 *   - scoring rewards the *centre* of the band, so a combo is about accuracy, not
 *     mashing, and a miss costs a life instead of resetting the run instantly;
 *   - Phaser is used for the scene graph, the input plumbing and the particle
 *     bursts; the game logic stays a few dozen lines of plain numbers, which keeps
 *     the file readable as a starting point for a remix;
 *   - everything the host controls is honoured: pause freezes the scene, mute silences
 *     the audio helper, visibility shows an overlay, dispose destroys the game.
 *
 * Phaser is vendored and pinned by the platform build (no network at build time),
 * so `import Phaser from 'phaser'` resolves to the exact engine version declared in
 * game.json.
 */

import Phaser from 'phaser';
import { defineGame, type GameApi, type GameInstance } from '@moydan/sdk';
import { Sfx } from './audio.ts';

const STORAGE_KEY = 'pulse-tap.best';
const RING_MIN = 40;
const RING_MAX = 250;
const PERFECT_FRACTION = 0.34;

interface Params {
  tempo: number;
  band: number;
  lives: number;
  accent: string;
  perfect_bonus: boolean;
  sound: boolean;
}

function numberParam(api: GameApi, key: keyof Params, fallback: number): number {
  const value = api.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function hexToNumber(hex: string, fallback: number): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return Number.parseInt(hex.slice(1), 7);
}

class PulseScene extends Phaser.Scene {
  private api: GameApi;
  private params: Params;
  private accent: number;
  private sfx: Sfx;

  private ringRadius = RING_MIN;
  private direction: 1 | -1 = 1;
  private tempoMs = 1800;
  private bandHalf = 18;
  private bandRadius = (RING_MIN + RING_MAX) / 2;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private lives = 3;
  private phase: 'ready' | 'running' | 'over' = 'ready';
  private feedbackUntil = 0;
  private feedback: 'perfect' | 'good' | 'miss' | null = null;
  private lastJudgement = '';
  private best = 0;

  private graphics!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Text;

  constructor(api: GameApi, params: Params, accent: number, sfx: Sfx, best: number) {
    super({ key: 'pulse' });
    this.api = api;
    this.params = params;
    this.accent = accent;
    this.sfx = sfx;
    this.best = best;
    this.tempoMs = Math.max(400, params.tempo);
    this.bandHalf = Math.max(2, params.band);
  }

  create(): void {
    const { width, height } = this.scale;
    const centerX = width / 2;

    this.graphics = this.add.graphics();
    this.overlay = this.add
      .text(centerX, height * 0.78, '', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: '38px',
        color: '#e9e9f5',
        align: 'center',
      })
      .setOrigin(0.5);

    // One control: tap anywhere, or press space. Both routes call the same judge.
    this.input.on('pointerdown', () => this.judge());
    this.input.keyboard?.on('keydown-SPACE', () => this.judge());

    this.api.storage.get(STORAGE_KEY).then((value) => {
      if (typeof value === 'number' && Number.isFinite(value) && value > this.best) this.best = value;
    });

    this.scale.on('resize', () => this.draw());
    this.draw();
  }

  override update(_time: number, delta: number): void {
    if (this.phase !== 'running') {
      this.draw();
      return;
    }
    // Radius moves linearly in time rather than per frame, so the tempo means the
    // same thing on a 60 Hz phone and a 144 Hz desktop.
    const step = (RING_MAX - RING_MIN) / (this.tempoMs / 2);
    this.ringRadius += step * this.direction * (delta / 1000) * this.tempoMs;
    if (this.ringRadius >= RING_MAX) {
      this.ringRadius = RING_MAX;
      this.direction = -1;
    } else if (this.ringRadius <= RING_MIN) {
      this.ringRadius = RING_MIN;
      this.direction = 1;
    }
    this.draw();
  }

  private judge(): void {
    if (this.phase === 'over') {
      this.restart();
      return;
    }
    if (this.phase === 'ready') {
      this.phase = 'running';
      this.sfx.unlock();
      this.sfx.tone({ frequency: 520, durationMs: 90, type: 'triangle', gain: 0.16 });
      return;
    }

    const distance = Math.abs(this.ringRadius - this.bandRadius);
    if (distance > this.bandHalf) {
      this.miss('Too early or too late');
      return;
    }
    const perfect = this.params.perfect_bonus && distance <= this.bandHalf * PERFECT_FRACTION;
    this.combo += 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const points = (perfect ? 250 : 120) + Math.min(400, this.combo * 12);
    this.score += points;
    this.lastJudgement = perfect ? `PERFECT +${points}` : `GOOD +${points}`;
    this.feedback = perfect ? 'perfect' : 'good';
    this.feedbackUntil = this.time.now + 420;
    this.sfx.tone({
      frequency: 420 + Math.min(480, this.combo * 26),
      durationMs: 110,
      type: perfect ? 'square' : 'triangle',
      gain: 0.18,
    });
    this.burst(perfect ? 18 : 10);
    this.draw();
  }

  private miss(reason: string): void {
    this.combo = 0;
    this.lives -= 1;
    this.lastJudgement = reason;
    this.feedback = 'miss';
    this.feedbackUntil = this.time.now + 500;
    this.sfx.tone({ frequency: 150, durationMs: 180, type: 'sawtooth', gain: 0.16, slideTo: 90 });
    if (this.lives <= 0) this.end();
    this.draw();
  }

  private burst(count: number): void {
    const { width, height } = this.scale;
    const centerX = width / 2;
    const centerY = height * 0.46;
    const emitter = this.add.particles(centerX, centerY, undefined, {
      lifespan: 420,
      speed: { min: 60, max: 260 },
      scale: { start: 0.12, end: 0 },
      alpha: { start: 0.9, end: 0 },
      quantity: 1,
      blendMode: 'ADD',
      tint: this.accent,
    });
    emitter.setDepth(2);
    emitter.explode(count);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  private end(): void {
    this.phase = 'over';
    if (this.score > this.best) {
      this.best = this.score;
      void this.api.storage.set(STORAGE_KEY, this.best);
    }
    this.api.score(this.score, { unit: 'points', difficulty: `${this.params.tempo}ms` });
    this.api.ended({ reason: 'game-over', score: this.score, durationMs: 0 });
    this.draw();
  }

  private restart(): void {
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.lives = Math.max(1, Math.round(this.params.lives));
    this.phase = 'ready';
    this.ringRadius = RING_MIN;
    this.direction = 1;
    this.feedback = null;
    this.draw();
  }

  /** Called by the host lifecycle: freeze the scene, keep the frame on screen. */
  setRunning(running: boolean): void {
    if (running) this.scene.resume();
    else this.scene.pause();
  }

  private draw(): void {
    const g = this.graphics;
    const { width, height } = this.scale;
    const centerX = width / 2;
    const centerY = height * 0.46;
    const feedbackActive = this.time.now < this.feedbackUntil;

    g.clear();
    g.fillStyle(0x0b0b12, 1);
    g.fillRect(0, 0, width, height);

    // Concentric guides so the target radius is legible before the first tap.
    g.lineStyle(1, 0x1c1c28, 1);
    for (let radius = RING_MIN; radius <= RING_MAX; radius += 35) g.strokeCircle(centerX, centerY, radius);

    // Target band.
    const bandColor = this.feedback === 'miss' && feedbackActive ? 0xff5c7a : this.accent;
    g.fillStyle(bandColor, 0.18);
    g.fillCircle(centerX, centerY, this.bandRadius + this.bandHalf);
    g.fillCircle(centerX, centerY, Math.max(1, this.bandRadius - this.bandHalf));
    g.lineStyle(3, bandColor, 0.9);
    g.strokeCircle(centerX, centerY, this.bandRadius + this.bandHalf);
    g.strokeCircle(centerX, centerY, Math.max(1, this.bandRadius - this.bandHalf));

    // The breathing ring.
    const ringColor = this.feedback === 'perfect' && feedbackActive ? 0xffffff : this.accent;
    g.lineStyle(10, ringColor, 0.95);
    g.strokeCircle(centerX, centerY, this.ringRadius);
    g.lineStyle(2, 0xffffff, 0.35);
    g.strokeCircle(centerX, centerY, this.ringRadius);

    g.fillStyle(0xe9e9f5, 0.9);
    g.fillCircle(centerX, centerY, 5);

    // HUD.
    this.overlay.setText([
      this.phase === 'ready' ? 'Tap to start' : this.phase === 'over' ? 'Tap to play again' : this.lastJudgement || 'Tap on the band',
      `Score ${this.score}`,
      `Combo x${this.combo}   Best combo ${this.bestCombo}`,
      `${'•'.repeat(Math.max(0, this.lives))}${'·'.repeat(Math.max(0, Math.round(this.params.lives) - this.lives))}`,
      this.best > 0 ? `Personal best ${this.best}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n'));
  }
}

defineGame({
  create(api: GameApi): GameInstance {
    const sfx = new Sfx({
      muted: api.muted,
      enabled: api.params.sound !== false,
    });

    const params: Params = {
      tempo: Math.max(400, numberParam(api, 'tempo', 1800)),
      band: Math.max(2, numberParam(api, 'band', 18)),
      lives: Math.max(1, Math.round(numberParam(api, 'lives', 3))),
      accent: typeof api.params.accent === 'string' ? api.params.accent : '#40e0d0',
      perfect_bonus: api.params.perfect_bonus !== false,
      sound: api.params.sound !== false,
    };
    const accent = hexToNumber(params.accent, 0x40e0d0);

    const scene = new PulseScene(api, params, accent, sfx, 0);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: api.root,
      width: api.viewport.width,
      height: api.viewport.height,
      backgroundColor: '#0b0b12',
      transparent: false,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      // Audio is owned by the helper: the platform mutes games itself and the
      // helper respects `api.muted`, so Phaser stays silent by default.
      audio: { noAudio: true },
      banner: false,
      scene: [scene],
    });

    // The host starts games from a lifecycle command, never from a load event, so
    // audio can be unlocked from a real user gesture.
    sfx.unlock();

    return {
      start() {
        /* the scene is already live; the first tap arms it */
      },
      pause() {
        scene.setRunning(false);
        sfx.setMuted(true);
      },
      resume() {
        scene.setRunning(true);
        sfx.setMuted(api.muted);
      },
      mute(muted: boolean) {
        sfx.setMuted(muted);
      },
      dispose() {
        game.destroy(true);
      },
    };
  },
});

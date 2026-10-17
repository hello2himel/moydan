/**
 * Pattern Grid — repeat what you saw, one step longer every round.
 *
 * The classic memory mechanic, built so it survives a 20 second play session:
 * a few seconds of watching, the same again under your fingers, and a round
 * that grows by one cell. Difficulty comes from the remix parameters (flash
 * length, starting length, lives), never from hidden rules.
 *
 * Two input paths on purpose: pointer for phones, number keys 1-9 for a desktop
 * keyboard, both feeding the same `press()` so neither can drift.
 *
 * The reveal is driven by the pause-aware loop instead of timers, so pausing
 * the game (or hiding the tab) never leaves a half-finished reveal behind.
 */

import { defineGame, setupCanvas, type GameApi } from '@moydan/sdk';
import { Sfx } from './audio.ts';

interface Params {
  lives: number;
  flash_ms: number;
  accent: string;
  start_length: number;
  sound: boolean;
}

const GRID = 3;
const CELLS = GRID * GRID;
const CELL = 190;
const GAP = 22;
const STEP_SCORE = 10;
const ROUND_BONUS = 20;
const WRONG_FLASH_MS = 420;
const STORAGE_KEY = 'pattern-grid.best';

type Phase = 'reveal' | 'input' | 'pause' | 'over';
type Pending = 'input' | 'replay' | 'grow';

function numberParam(api: GameApi, key: keyof Params, fallback: number): number {
  const value = api.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

defineGame({
  create(api) {
    const canvas = setupCanvas(api);
    const { ctx, width, height } = canvas;
    const accent = typeof api.params.accent === 'string' ? api.params.accent : '#4ade80';
    const maxLives = Math.round(Math.max(1, numberParam(api, 'lives', 3)));
    const flashMs = Math.max(180, Math.min(900, numberParam(api, 'flash_ms', 420)));
    const startLength = Math.round(Math.max(2, Math.min(CELLS, numberParam(api, 'start_length', 3))));
    const sfx = new Sfx({ muted: api.muted, enabled: api.params.sound !== false });

    const gridSpan = GRID * CELL + (GRID - 1) * GAP;
    const originX = (width - gridSpan) / 2;
    const originY = (height - gridSpan) / 2 + 40;
    const cellOrigin = (index: number): { x: number; y: number } => ({
      x: originX + (index % GRID) * (CELL + GAP),
      y: originY + Math.floor(index / GRID) * (CELL + GAP),
    });

    const hud = document.createElement('div');
    hud.style.cssText =
      'position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between;padding:28px;font:600 30px system-ui,sans-serif;color:#e9e9f5;';
    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:center;gap:12px;text-shadow:0 2px 8px #0008;';
    const mark = document.createElement('img');
    // Relative to the entry document: the same path works in a release artifact
    // and in the local preview, and it stays inside the game's own CSP origin.
    mark.src = 'assets/ui/grid-mark.svg';
    mark.alt = 'Pattern Grid';
    mark.width = 44;
    mark.height = 44;
    const title = document.createElement('div');
    title.textContent = 'Pattern Grid';
    heading.append(mark, title);
    const status = document.createElement('div');
    status.style.cssText = 'text-align:center;line-height:1.5;text-shadow:0 2px 8px #0008;font-variant-numeric:tabular-nums;';
    const hint = document.createElement('div');
    hint.style.cssText = 'text-align:center;color:#8a8ab0;font-weight:400;font-size:24px;text-shadow:0 2px 8px #0008;';
    hud.append(heading, status, hint);
    api.root.appendChild(hud);

    const watermark = new Image();
    let watermarkReady = false;
    watermark.src = 'assets/ui/grid-mark.svg';
    watermark.onload = () => {
      watermarkReady = true;
    };

    let loop = api.createLoop(() => undefined);
    let sequence: number[] = [];
    let phase: Phase = 'reveal';
    let pending: Pending = 'input';
    let phaseClock = 0;
    let stepIndex = 0;
    let clockMs = 0;
    let livesLeft = maxLives;
    let points = 0;
    let combo = 0;
    let best = 0;
    let lit = -1;
    let litLevel = 0;
    let wrong = -1;
    let wrongUntil = 0;

    /** Invert the canvas transform so a pointer lands in design coordinates. */
    const toDesign = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvas.canvas.getBoundingClientRect();
      const fit = Math.min(rect.width / width, rect.height / height);
      const scale = api.viewport.scale === 'cover' ? Math.max(fit, rect.width / width, rect.height / height) : fit;
      const offsetX = (rect.width - width * scale) / 2;
      const offsetY = (rect.height - height * scale) / 2;
      return { x: (clientX - rect.left - offsetX) / scale, y: (clientY - rect.top - offsetY) / scale };
    };

    const cellAt = (clientX: number, clientY: number): number => {
      const point = toDesign(clientX, clientY);
      for (let index = 0; index < CELLS; index += 1) {
        const origin = cellOrigin(index);
        if (point.x >= origin.x && point.x <= origin.x + CELL && point.y >= origin.y && point.y <= origin.y + CELL) return index;
      }
      return -1;
    };

    const toneFor = (index: number): number => 330 * Math.pow(2, index / 12);

    const growSequence = (): void => {
      sequence.push(Math.floor(Math.random() * CELLS));
    };

    const startRound = (): void => {
      stepIndex = 0;
      phase = 'reveal';
      phaseClock = 560;
      hint.textContent = 'watch';
    };

    const gameOver = (): void => {
      phase = 'over';
      if (points > best) {
        best = points;
        void api.storage.set(STORAGE_KEY, best);
      }
      sfx.tone({ frequency: 200, slideTo: 60, durationMs: 800, type: 'triangle', gain: 0.22 });
      api.score(points, { unit: 'points' });
      api.ended({ reason: 'game-over', score: points });
    };

    const press = (index: number): void => {
      if (phase !== 'input') return;
      if (index === sequence[stepIndex]) {
        combo += 1;
        points += STEP_SCORE * Math.max(1, Math.floor(combo / 4));
        stepIndex += 1;
        lit = index;
        litLevel = 1;
        sfx.tone({ frequency: toneFor(index), durationMs: 220, type: 'sine', gain: 0.18 });
        api.score(points, { unit: 'points' });
        if (stepIndex >= sequence.length) {
          // Every round is exactly one step longer, so the sequence length is
          // the round number — no second counter to keep in sync.
          points += ROUND_BONUS * sequence.length;
          sfx.tone({ frequency: 660, slideTo: 990, durationMs: 320, type: 'sine', gain: 0.16 });
          pending = 'grow';
          phase = 'pause';
          phaseClock = 520;
        }
        return;
      }
      combo = 0;
      livesLeft -= 1;
      wrong = index;
      wrongUntil = clockMs + WRONG_FLASH_MS;
      sfx.tone({ frequency: 150, slideTo: 90, durationMs: 420, type: 'sawtooth', gain: 0.2 });
      if (typeof navigator.vibrate === 'function') navigator.vibrate(45);
      pending = 'replay';
      phase = 'pause';
      phaseClock = 780;
      if (livesLeft <= 0) {
        livesLeft = 0;
        gameOver();
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      sfx.unlock();
      const index = cellAt(event.clientX, event.clientY);
      if (index >= 0) press(index);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const digit = Number.parseInt(event.key, 10);
      // 1-9 map to the grid in reading order, which is what the hint promises.
      if (!Number.isInteger(digit) || digit < 1 || digit > CELLS) return;
      event.preventDefault();
      press(digit - 1);
    };

    canvas.canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    const revealStep = (): void => {
      const cell = sequence[stepIndex];
      if (cell !== undefined) {
        lit = cell;
        litLevel = 1;
        sfx.tone({ frequency: toneFor(cell), durationMs: flashMs * 0.55, type: 'sine', gain: 0.16 });
      }
      stepIndex += 1;
      if (stepIndex >= sequence.length) {
        pending = 'input';
        phase = 'pause';
        phaseClock = 280;
      }
    };

    const draw = (): void => {
      // Oversized background so the letterbox of a "fit" viewport is covered
      // without touching the device-pixel transform `setupCanvas` installed.
      ctx.fillStyle = '#07070d';
      ctx.fillRect(-width, -height, width * 3, height * 3);

      if (watermarkReady) {
        ctx.globalAlpha = 0.12;
        ctx.drawImage(watermark, width / 2 - 180, originY - 236, 360, 360);
        ctx.globalAlpha = 1;
      }

      for (let index = 0; index < CELLS; index += 1) {
        const origin = cellOrigin(index);
        const isLit = lit === index && litLevel > 0;
        const isWrong = wrong === index && clockMs < wrongUntil;
        ctx.save();
        if (isLit) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = 46;
        }
        ctx.fillStyle = isWrong ? '#7f1d3a' : isLit ? accent : `hsl(${(index * 40 + 150) % 360} 30% 15%)`;
        roundedRect(ctx, origin.x, origin.y, CELL, CELL, 34);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = isLit ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 3;
        roundedRect(ctx, origin.x + 6, origin.y + 6, CELL - 12, CELL - 12, 28);
        ctx.stroke();
        ctx.fillStyle = isLit ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.22)';
        ctx.font = '600 30px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(index + 1), origin.x + CELL / 2, origin.y + CELL / 2);
      }
      ctx.textBaseline = 'alphabetic';

      status.textContent = `${points} pts · round ${sequence.length} · ${'●'.repeat(livesLeft)}${'·'.repeat(maxLives - livesLeft)}`;
      if (phase === 'over') hint.textContent = `game over · best ${best} pts`;
    };

    loop = api.createLoop((deltaMs) => {
      clockMs += deltaMs;
      phaseClock -= deltaMs;
      if (litLevel > 0) {
        litLevel = Math.max(0, litLevel - deltaMs / (flashMs * 0.7));
        if (litLevel === 0) lit = -1;
      }

      if (phase === 'reveal' && phaseClock <= 0) revealStep();
      if (phase === 'pause' && phaseClock <= 0) {
        if (pending === 'grow') {
          growSequence();
          startRound();
        } else if (pending === 'replay') {
          startRound();
        } else {
          stepIndex = 0;
          phase = 'input';
          hint.textContent = 'repeat it';
        }
      }
      draw();
    });

    void api.storage.get<number>(STORAGE_KEY).then((value) => {
      if (typeof value === 'number') best = value;
      draw();
    });

    return {
      start() {
        sequence = [];
        for (let index = 0; index < startLength; index += 1) growSequence();
        stepIndex = 0;
        phase = 'reveal';
        pending = 'input';
        phaseClock = 700;
        livesLeft = maxLives;
        points = 0;
        combo = 0;
        lit = -1;
        litLevel = 0;
        wrong = -1;
        wrongUntil = 0;
        hint.textContent = 'watch';
        draw();
      },
      pause() {},
      resume() {},
      mute(muted) {
        sfx.setMuted(muted);
      },
      visibility() {},
      dispose() {
        loop.stop();
        canvas.canvas.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('keydown', onKeyDown);
        canvas.dispose();
        sfx.dispose();
        watermark.onload = null;
        watermark.src = '';
        hud.remove();
      },
    };
  },
});

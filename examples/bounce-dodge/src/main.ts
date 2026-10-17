/**
 * Bounce Dodge — a portrait reflex game on the platform canvas runtime.
 *
 * Design notes:
 *   - one control only (drag anywhere to move the bar), so it works with a thumb
 *     on a phone and with a mouse on a desktop without a mode switch;
 *   - the score is survival time in milliseconds, which means every second of
 *     tension is rewarded and nothing has to be balanced around a point table;
 *   - a hit clears the field instead of dropping a new block on the player, which
 *     is the difference between "hard" and "unfair";
 *   - one accent colour drives the bar, the blocks and the HUD pips, so a remix
 *     variant is a parameter edit rather than a fork.
 *
 * Drawing happens in design coordinates: `setupCanvas` owns the device-pixel
 * transform, and the background is an oversized rectangle so the letterbox of a
 * "fit" viewport is covered without touching that transform.
 *
 * Everything is torn down in `dispose()`: listeners, the pause-aware loop, the
 * audio context and the HUD. The host disposes an instance for good.
 */

import { defineGame, setupCanvas, type GameApi } from '@moydan/sdk';
import { Sfx } from './audio.ts';

interface Params {
  speed: number;
  lives: number;
  accent: string;
  shake: boolean;
  sound: boolean;
}

interface Block {
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const BAR_HALF_WIDTH = 96;
const BAR_HEIGHT = 22;
const INVULNERABLE_MS = 1200;
const COUNTDOWN_MS = 1400;
const FIRST_SURGE_MS = 10_000;
const SURGE_INTERVAL_MS = 12_000;
const SCORE_INTERVAL_MS = 250;
const STORAGE_KEY = 'bounce-dodge.best';

function numberParam(api: GameApi, key: keyof Params, fallback: number): number {
  const value = api.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '7c5cff';
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
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
    const accent = typeof api.params.accent === 'string' ? api.params.accent : '#7c5cff';
    const rgb = hexToRgb(accent);
    const speed = Math.max(0.3, numberParam(api, 'speed', 1));
    const maxLives = Math.round(Math.max(1, numberParam(api, 'lives', 3)));
    const shakeEnabled = api.params.shake !== false;
    const soundEnabled = api.params.sound !== false;
    const sfx = new Sfx({ muted: api.muted, enabled: soundEnabled });

    // HUD lives in the DOM so text stays crisp and reachable by assistive tech;
    // the canvas keeps the design resolution and draws the game.
    const hud = document.createElement('div');
    hud.style.cssText =
      'position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between;padding:24px;font:600 28px system-ui,sans-serif;color:#e9e9f5;';
    const mark = document.createElement('img');
    // Relative to the entry document, so it resolves the same way in the release
    // artifact (/r/<release>/index.html) and in the local preview.
    mark.src = 'assets/ui/mark.svg';
    mark.alt = 'Bounce Dodge';
    mark.width = 44;
    mark.height = 44;
    const title = document.createElement('div');
    title.textContent = 'Bounce Dodge';
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;gap:12px;text-shadow:0 2px 8px #0008;';
    topRow.append(mark, title);

    const scoreLabel = document.createElement('div');
    scoreLabel.style.cssText = 'text-align:center;font-variant-numeric:tabular-nums;';
    const pips = document.createElement('div');
    pips.style.cssText = 'display:flex;justify-content:center;gap:10px;margin-top:12px;';
    const pipElements: HTMLElement[] = [];
    for (let index = 0; index < maxLives; index += 1) {
      const pip = document.createElement('span');
      pip.style.cssText = 'width:16px;height:16px;border-radius:50%;display:inline-block;background:#2b2b45;';
      pipElements.push(pip);
      pips.appendChild(pip);
    }
    const center = document.createElement('div');
    center.style.cssText = 'text-align:center;text-shadow:0 2px 8px #0008;';
    center.append(scoreLabel, pips);

    const hint = document.createElement('div');
    hint.style.cssText = 'text-align:center;color:#8a8ab0;font-weight:400;font-size:24px;text-shadow:0 2px 8px #0008;';
    hint.textContent = 'drag to move';
    hud.append(topRow, center, hint);
    api.root.appendChild(hud);

    const logo = new Image();
    let logoReady = false;
    logo.src = 'assets/ui/mark.svg';
    logo.onload = () => {
      logoReady = true;
    };

    const bar = { x: width / 2, y: height - 150, target: width / 2 };
    const blocks: Block[] = [];
    const sparks: Spark[] = [];
    let loop = api.createLoop(() => undefined);
    let dragging = false;
    let elapsedMs = 0;
    let spawnClock = 0;
    let lastScoreAt = 0;
    let invulnerableUntil = 0;
    let countdownUntil = 0;
    let nextSurgeAt = FIRST_SURGE_MS;
    let livesLeft = maxLives;
    let bestMs = 0;
    let shakeUntil = 0;
    let over = false;

    /** Invert the canvas transform so a pointer lands in design coordinates. */
    const toDesignX = (clientX: number): number => {
      const rect = canvas.canvas.getBoundingClientRect();
      const fit = Math.min(rect.width / width, rect.height / height);
      const scale = api.viewport.scale === 'cover' ? Math.max(fit, rect.width / width, rect.height / height) : fit;
      const offsetX = (rect.width - width * scale) / 2;
      return (clientX - rect.left - offsetX) / scale;
    };

    const moveTo = (event: PointerEvent): void => {
      bar.target = Math.max(0, Math.min(width, toDesignX(event.clientX)));
    };
    const onPointerDown = (event: PointerEvent): void => {
      dragging = true;
      sfx.unlock();
      canvas.canvas.setPointerCapture?.(event.pointerId);
      moveTo(event);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (dragging) moveTo(event);
    };
    const onPointerUp = (event: PointerEvent): void => {
      dragging = false;
      canvas.canvas.releasePointerCapture?.(event.pointerId);
    };

    canvas.canvas.addEventListener('pointerdown', onPointerDown);
    canvas.canvas.addEventListener('pointermove', onPointerMove);
    canvas.canvas.addEventListener('pointerup', onPointerUp);
    canvas.canvas.addEventListener('pointercancel', onPointerUp);
    canvas.canvas.addEventListener('pointerleave', onPointerUp);

    const spawnBlock = (x: number, flat: boolean): void => {
      const blockWidth = flat ? 150 : 62 + Math.random() * 74;
      blocks.push({
        x,
        y: -blockWidth,
        width: blockWidth,
        height: flat ? 26 : 48 + Math.random() * 30,
        vx: (Math.random() - 0.5) * 90,
        vy: (110 + Math.random() * 60) * speed,
        spin: (Math.random() - 0.5) * 2.4,
        angle: Math.random() * Math.PI,
      });
    };

    const burst = (x: number, y: number): void => {
      for (let index = 0; index < 18; index += 1) {
        const angle = (index / 18) * Math.PI * 2;
        const force = 140 + Math.random() * 220;
        sparks.push({ x, y, vx: Math.cos(angle) * force, vy: Math.sin(angle) * force, life: 420 + Math.random() * 260 });
      }
    };

    const loseLife = (): void => {
      livesLeft -= 1;
      burst(bar.x, bar.y);
      invulnerableUntil = elapsedMs + INVULNERABLE_MS;
      shakeUntil = shakeEnabled ? elapsedMs + 320 : 0;
      sfx.tone({ frequency: 220, slideTo: 70, durationMs: 320, type: 'sawtooth', gain: 0.22 });
      if (typeof navigator.vibrate === 'function') navigator.vibrate(60);
      blocks.length = 0;
      if (livesLeft <= 0) {
        over = true;
        const record = Math.floor(elapsedMs);
        if (record > bestMs) {
          bestMs = record;
          void api.storage.set(STORAGE_KEY, bestMs);
        }
        sfx.tone({ frequency: 180, slideTo: 55, durationMs: 700, type: 'triangle', gain: 0.2 });
        api.score(record, { unit: 'ms', durationMs: record });
        api.ended({ reason: 'game-over', score: record, durationMs: record });
      }
    };

    const drawHud = (): void => {
      const seconds = (elapsedMs / 1000).toFixed(2);
      scoreLabel.textContent = over ? 'game over' : `${seconds} s`;
      for (let index = 0; index < pipElements.length; index += 1) {
        const pip = pipElements[index];
        if (!pip) continue;
        pip.style.background = index < livesLeft ? `rgb(${rgb.r},${rgb.g},${rgb.b})` : '#2b2b45';
      }
      hint.textContent = over
        ? `survived ${seconds} s · best ${(bestMs / 1000).toFixed(2)} s`
        : dragging
          ? 'release to stop'
          : 'drag to move';
    };

    const draw = (): void => {
      const shaking = shakeUntil > elapsedMs;
      ctx.save();
      if (shaking) {
        const amount = 10 * ((shakeUntil - elapsedMs) / 320);
        ctx.translate((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount);
      }
      // Oversized background: covers the letterbox of a "fit" viewport without
      // resetting the device-pixel transform `setupCanvas` installed.
      ctx.fillStyle = '#07070d';
      ctx.fillRect(-width, -height, width * 3, height * 3);

      ctx.strokeStyle = 'rgba(122,122,170,0.22)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 14]);
      ctx.beginPath();
      ctx.moveTo(0, bar.y);
      ctx.lineTo(width, bar.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (logoReady) {
        ctx.globalAlpha = 0.16;
        ctx.drawImage(logo, width - 176, height - 320, 150, 150);
        ctx.globalAlpha = 1;
      }

      const flash = invulnerableUntil > elapsedMs && Math.floor(elapsedMs / 90) % 2 === 0;
      ctx.fillStyle = flash ? '#ffffff' : accent;
      roundedRect(ctx, bar.x - BAR_HALF_WIDTH, bar.y - BAR_HEIGHT / 2, BAR_HALF_WIDTH * 2, BAR_HEIGHT, 11);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      roundedRect(ctx, bar.x - BAR_HALF_WIDTH + 12, bar.y - 3, BAR_HALF_WIDTH * 2 - 24, 5, 3);
      ctx.fill();

      for (const block of blocks) {
        ctx.save();
        ctx.translate(block.x, block.y);
        ctx.rotate(block.angle);
        ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.85)`;
        roundedRect(ctx, -block.width / 2, -block.height / 2, block.width, block.height, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      for (const spark of sparks) {
        ctx.globalAlpha = Math.max(0, Math.min(1, spark.life / 600));
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (countdownUntil > elapsedMs) {
        const remaining = (countdownUntil - elapsedMs) / 1000;
        ctx.fillStyle = '#e9e9f5';
        ctx.font = '700 96px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(remaining > 0.5 ? String(Math.ceil(remaining - 0.5)) : 'go', width / 2, height / 2);
        ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
      drawHud();
    };

    loop = api.createLoop((deltaMs) => {
      const dt = Math.min(0.05, deltaMs / 1000);
      if (!over) elapsedMs += deltaMs;
      bar.x += (bar.target - bar.x) * Math.min(1, dt * 16);

      const difficulty = 1 + elapsedMs / 22_000;
      const running = !over && countdownUntil <= elapsedMs;
      if (running) {
        const surge = elapsedMs >= nextSurgeAt;
        spawnClock += dt;
        const interval = Math.max(0.34, 1.6 / (speed * difficulty));
        if (surge || spawnClock >= interval) {
          spawnClock = 0;
          if (surge) {
            nextSurgeAt += SURGE_INTERVAL_MS;
            const gap = 1 + Math.floor(Math.random() * 4);
            for (let index = 0; index < 5; index += 1) {
              if (index !== gap) spawnBlock(80 + index * 140, false);
            }
            sfx.tone({ frequency: 240, slideTo: 520, durationMs: 260, type: 'triangle', gain: 0.1 });
          } else {
            spawnBlock(80 + Math.random() * (width - 160), Math.random() < 0.18);
            sfx.tone({ frequency: 320 + Math.random() * 120, durationMs: 90, type: 'square', gain: 0.05 });
          }
        }
      }

      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (!block) continue;
        block.vy = Math.min(block.vy + 130 * dt, 400 * speed * difficulty);
        block.x += block.vx * dt;
        block.y += block.vy * dt;
        block.angle += block.spin * dt;
        if (block.x - block.width / 2 < 0 || block.x + block.width / 2 > width) {
          block.x = Math.max(block.width / 2, Math.min(width - block.width / 2, block.x));
          block.vx = -block.vx;
        }
        const overlapsBar =
          Math.abs(block.x - bar.x) < BAR_HALF_WIDTH + block.width / 2 - 6 &&
          Math.abs(block.y - bar.y) < BAR_HEIGHT / 2 + block.height / 2;
        if (running && overlapsBar && invulnerableUntil <= elapsedMs) {
          loseLife();
          continue;
        }
        if (block.y - block.height > height) blocks.splice(index, 1);
      }

      for (let index = sparks.length - 1; index >= 0; index -= 1) {
        const spark = sparks[index];
        if (!spark) continue;
        spark.life -= deltaMs;
        spark.vy += 520 * dt;
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        if (spark.life <= 0) sparks.splice(index, 1);
      }

      if (running && elapsedMs - lastScoreAt >= SCORE_INTERVAL_MS) {
        lastScoreAt = elapsedMs;
        api.score(Math.floor(elapsedMs), { unit: 'ms', durationMs: Math.floor(elapsedMs) });
      }
      draw();
    });

    void api.storage.get<number>(STORAGE_KEY).then((value) => {
      if (typeof value === 'number') bestMs = value;
      draw();
    });

    return {
      start() {
        blocks.length = 0;
        sparks.length = 0;
        elapsedMs = 0;
        spawnClock = 0;
        lastScoreAt = 0;
        invulnerableUntil = 0;
        countdownUntil = COUNTDOWN_MS;
        nextSurgeAt = FIRST_SURGE_MS;
        livesLeft = maxLives;
        over = false;
        bar.x = width / 2;
        bar.target = width / 2;
        shakeUntil = 0;
        sfx.tone({ frequency: 520, durationMs: 120, type: 'triangle', gain: 0.12 });
        draw();
      },
      pause() {
        dragging = false;
      },
      resume() {},
      mute(muted) {
        sfx.setMuted(muted);
      },
      visibility(visible) {
        if (!visible) dragging = false;
      },
      dispose() {
        loop.stop();
        canvas.canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.canvas.removeEventListener('pointermove', onPointerMove);
        canvas.canvas.removeEventListener('pointerup', onPointerUp);
        canvas.canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.canvas.removeEventListener('pointerleave', onPointerUp);
        canvas.dispose();
        sfx.dispose();
        logo.onload = null;
        logo.src = '';
        hud.remove();
      },
    };
  },
});

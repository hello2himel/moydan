/**
 * Tiny Web Audio feedback helper.
 *
 * Why hand-rolled: the platform mediates no audio assets and none are needed for
 * a wordless reflex game. Two requirements make a helper better than ad-hoc
 * oscillators in the game loop: the context must be created (and resumed) from a
 * user gesture or mobile browsers keep it suspended, and it must be closed in
 * `dispose()` or the page keeps an audio device open after a rematch.
 */

export interface ToneOptions {
  frequency: number;
  durationMs: number;
  type?: OscillatorType;
  gain?: number;
  /** Optional glide target, in Hz. */
  slideTo?: number;
}

export class Sfx {
  private context: AudioContext | null = null;
  private muted: boolean;
  private enabled: boolean;

  constructor(options: { muted?: boolean; enabled?: boolean } = {}) {
    this.muted = options.muted ?? false;
    this.enabled = options.enabled ?? true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Call from a user gesture (the host's `mo:start` is not enough on iOS). */
  unlock(): void {
    if (!this.enabled || this.muted) return;
    const context = this.ensure();
    if (!context) return;
    if (context.state === 'suspended') void context.resume();
  }

  tone(options: ToneOptions): void {
    if (!this.enabled || this.muted) return;
    const context = this.ensure();
    if (!context || context.state === 'suspended') return;
    const now = context.currentTime;
    const duration = Math.max(0.02, options.durationMs / 1000);
    const oscillator = context.createOscillator();
    const amplifier = context.createGain();
    oscillator.type = options.type ?? 'triangle';
    oscillator.frequency.setValueAtTime(options.frequency, now);
    if (options.slideTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.slideTo), now + duration);
    }
    const peak = options.gain ?? 0.18;
    amplifier.gain.setValueAtTime(0.0001, now);
    amplifier.gain.exponentialRampToValueAtTime(peak, now + 0.01);
    amplifier.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(amplifier).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  dispose(): void {
    if (!this.context) return;
    const context = this.context;
    this.context = null;
    void context.close().catch(() => {
      // Closing an already-closed context is not an error worth surfacing.
    });
  }

  private ensure(): AudioContext | null {
    if (!this.enabled || this.muted) return null;
    if (!this.context) {
      const Ctor = typeof AudioContext === 'function' ? AudioContext : null;
      if (!Ctor) return null;
      this.context = new Ctor();
    }
    return this.context;
  }
}

import type { AudioEngine } from './engine';

/** 효과음 — OscillatorNode + GainNode로 직접 합성. */
export class Sfx {
  private noise: AudioBuffer | null = null;
  constructor(private readonly eng: AudioEngine) {}

  private noiseBuf(): AudioBuffer {
    if (!this.noise) {
      const ctx = this.eng.ctx;
      const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = b;
    }
    return this.noise;
  }

  private tone(when: number, freq: number, dur: number, amp: number, type: OscillatorType, dest: AudioNode, freqEnd?: number) {
    const ctx = this.eng.ctx;
    const t = Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** 타격음. when = ctx 시각 (생략 시 즉시). scheduled면 취소 가능한 버스로. */
  hit(when?: number, scheduled = false): void {
    const ctx = this.eng.ctx;
    const t = when ?? ctx.currentTime;
    const dest = scheduled ? this.eng.scheduledBus : this.eng.sfxGain;
    this.tone(t, 1760, 0.06, 0.35, 'triangle', dest, 880);
    this.tone(t, 440, 0.08, 0.25, 'sine', dest, 220);
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const g = ctx.createGain();
    const s = Math.max(t, ctx.currentTime);
    g.gain.setValueAtTime(0.18, s);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.04);
    n.connect(hp).connect(g).connect(dest);
    n.start(s);
    n.stop(s + 0.05);
  }

  /** 카운트다운 틱. */
  tick(when?: number, accent = false, scheduled = true): void {
    const t = when ?? this.eng.ctx.currentTime;
    const dest = scheduled ? this.eng.scheduledBus : this.eng.sfxGain;
    this.tone(t, accent ? 1320 : 990, 0.07, 0.3, 'square', dest);
  }

  /** 실패음. */
  fail(): void {
    const t = this.eng.ctx.currentTime;
    this.tone(t, 220, 0.5, 0.35, 'sawtooth', this.eng.sfxGain, 55);
    this.tone(t + 0.02, 150, 0.6, 0.25, 'square', this.eng.sfxGain, 40);
  }

  /** 클리어 효과음. */
  clear(): void {
    const t = this.eng.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(t + i * 0.09, f, 0.35, 0.22, 'triangle', this.eng.sfxGain));
  }

  /** UI 클릭음. */
  ui(): void {
    this.tone(this.eng.ctx.currentTime, 880, 0.04, 0.12, 'sine', this.eng.sfxGain);
  }
}

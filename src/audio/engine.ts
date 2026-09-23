import { SmoothClock } from '../core/clock';

/**
 * AudioContext 하나로 음악·효과음 모두 처리. 마스터 클럭 제공.
 *
 * songTime = (ctxTime − startCtxTime) × pitch − outputLatency × pitch
 * 입력 판정 시각 = songTime(event.timeStamp) − inputOffset × pitch
 * 렌더 시각 = songTime + visualOffset × pitch
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly musicGain: GainNode;
  readonly sfxGain: GainNode;
  /** 예약된 효과음 버스 — 정지 시 끊어 취소. */
  private schedBus: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private sourceGain: GainNode | null = null;
  private startCtxTime = 0;
  private pitch = 1;
  private playing = false;
  private clock = new SmoothClock();
  /** 곡이 정지된 뒤에도 유지되는 곡 시각 (정지 시점). */
  private frozenSong: number | null = null;

  constructor() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.schedBus = this.ctx.createGain();
    this.schedBus.connect(this.sfxGain);
  }

  /** 모바일: 첫 사용자 입력에서 호출. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* 무시 */
      }
    }
  }

  get outputLatency(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return c.outputLatency ?? c.baseLatency ?? 0;
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  setMusicVolume(v: number): void {
    this.musicGain.gain.value = v;
  }
  setSfxVolume(v: number): void {
    this.sfxGain.gain.value = v;
  }

  /** 예약 효과음이 연결될 노드. */
  get scheduledBus(): GainNode {
    return this.schedBus;
  }

  /** 예약된 효과음 모두 취소. */
  cancelScheduled(): void {
    try {
      this.schedBus.disconnect();
    } catch {
      /* 무시 */
    }
    this.schedBus = this.ctx.createGain();
    this.schedBus.connect(this.sfxGain);
  }

  /**
   * songStart(곡 기준 초, 음수 가능)부터 재생. lead 초 뒤에 songStart 지점이 들린다.
   */
  play(buffer: AudioBuffer | null, songStart: number, pitch = 1, volume = 1, lead = 0.1): void {
    this.stop();
    this.pitch = pitch;
    const now = this.ctx.currentTime;
    this.startCtxTime = now + lead - songStart / pitch;
    this.frozenSong = null;
    this.playing = true;
    this.clock.reset();
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.musicGain);
    const when = Math.max(now + lead, this.startCtxTime);
    const offset = Math.max(0, songStart);
    if (offset < buffer.duration) src.start(when, offset);
    this.source = src;
    this.sourceGain = g;
  }

  /** 음악 정지 (피치 다운 효과 옵션). 클럭은 정지 시점에서 멈춘다. */
  stop(pitchDown = false): void {
    if (this.playing) this.frozenSong = this.songTime();
    this.playing = false;
    const src = this.source;
    const g = this.sourceGain;
    this.source = null;
    this.sourceGain = null;
    if (!src) return;
    const t = this.ctx.currentTime;
    try {
      if (pitchDown && g) {
        src.playbackRate.cancelScheduledValues(t);
        src.playbackRate.setValueAtTime(src.playbackRate.value, t);
        src.playbackRate.exponentialRampToValueAtTime(0.25, t + 0.45);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.5);
        src.stop(t + 0.55);
      } else src.stop();
    } catch {
      /* 이미 정지 */
    }
  }

  /** 곡 기준 ctx 시각 → 곡 시각 변환에 쓰는 원시 ctx 시각 (보간). */
  private smoothCtxTime(perfMs: number): number {
    return this.clock.sample(this.ctx.currentTime, perfMs, this.running);
  }

  /** 현재 들리는 곡 시각 (초). */
  songTime(perfMs = performance.now()): number {
    if (!this.playing) return this.frozenSong ?? 0;
    const ct = this.smoothCtxTime(perfMs);
    return (ct - this.startCtxTime) * this.pitch - this.outputLatency * this.pitch;
  }

  /** 과거 perf 시각(이벤트 timeStamp)의 곡 시각. */
  songTimeAtPerf(perfMs: number): number {
    const now = performance.now();
    const cur = this.songTime(now);
    if (!this.playing) return cur;
    return cur - ((now - perfMs) / 1000) * this.pitch;
  }

  /** 곡 시각 → ctx 시각 (효과음 예약용). 출력 지연을 반영해 들리는 시점이 곡 시각과 맞도록. */
  ctxTimeForSong(song: number): number {
    return this.startCtxTime + song / this.pitch;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentPitch(): number {
    return this.pitch;
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return await this.ctx.decodeAudioData(data.slice(0));
  }

  bufferFromSamples(samples: Float32Array, sampleRate: number): AudioBuffer {
    const b = this.ctx.createBuffer(1, samples.length, sampleRate);
    b.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return b;
  }
}

let engine: AudioEngine | null = null;
export function audio(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}

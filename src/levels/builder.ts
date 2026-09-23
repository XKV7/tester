import { flipDir, normDeg } from '../core/math';
import type { Action, Dir, EaseName, LevelData, LevelMeta, LevelSettings } from '../core/types';
import { defaultMeta, defaultSettings } from '../core/level';

/**
 * 리듬 → 길 빌더. 박 수를 주면 현재 회전 방향에서 그 박 수가 되는 각도를 계산해 타일을 붙인다.
 * 1박 = 직진, 0.5박 = 회전 방향 쪽으로 90°, 1.5박 = 반대쪽 90°, 2박 = U턴.
 * 곡의 리듬을 그대로 옮겨 적으면 길 모양이 자동으로 나온다.
 */
export class LevelBuilder {
  readonly path: number[] = [];
  readonly actions: Action[] = [];
  private heading = 0;
  private dir: Dir;
  private bpm: number;

  constructor(
    private readonly settings: LevelSettings,
    private readonly meta: LevelMeta,
  ) {
    this.dir = settings.startDirection;
    this.bpm = settings.bpm;
  }

  static create(meta: Partial<LevelMeta>, settings: Partial<LevelSettings>): LevelBuilder {
    return new LevelBuilder({ ...defaultSettings(), ...settings }, { ...defaultMeta(), ...meta });
  }

  /** 현재 타일 번호 (다음 이벤트가 붙을 곳). */
  get floor(): number {
    return this.path.length;
  }

  private angleFor(beats: number): number {
    const start = this.path.length === 0 ? 180 : this.heading + 180;
    const theta = beats * 180;
    return normDeg(this.dir === 'CW' ? start - theta : start + theta);
  }

  /** 각 박 수마다 타일 하나. (0 < 박 ≤ 2) */
  beats(...bs: number[]): this {
    for (const b of bs) {
      if (!(b > 0 && b <= 2)) throw new Error(`박 수는 0 초과 2 이하여야 합니다: ${b}`);
      const a = this.angleFor(b);
      this.path.push(a);
      this.heading = a;
    }
    return this;
  }

  /** 1박 직진 n개. */
  straight(n: number): this {
    return this.beats(...Array.from({ length: n }, () => 1));
  }

  /** 패턴을 n번 반복. */
  repeat(n: number, f: (b: this, i: number) => void): this {
    for (let i = 0; i < n; i++) f(this, i);
    return this;
  }

  /** 현재 타일에서 회전 방향 반전. */
  twirl(): this {
    this.dir = flipDir(this.dir);
    this.actions.push({ floor: this.floor, type: 'Twirl' });
    return this;
  }

  /** 현재 타일을 0박 미드스핀으로 (되돌아가는 방향). 다음 박은 이전 타일 위치에서 시작. */
  midspin(): this {
    const f = this.floor;
    if (f === 0) throw new Error('첫 타일에는 Midspin을 둘 수 없습니다');
    const a = normDeg(this.heading + 180);
    this.path.push(a);
    this.heading = a;
    this.actions.push({ floor: f, type: 'Midspin' });
    return this;
  }

  /** 다음 박 전에 n박 더 공전. */
  pause(n: number, beats = 1): this {
    this.actions.push({ floor: this.floor, type: 'Pause', beats: n });
    return this.beats(beats);
  }

  /** n박 누른 채 유지 후 떼고, 이어서 beats박. */
  hold(n: number, beats = 1): this {
    this.actions.push({ floor: this.floor, type: 'Hold', beats: n });
    return this.beats(beats);
  }

  checkpoint(): this {
    this.actions.push({ floor: this.floor, type: 'Checkpoint' });
    return this;
  }

  text(text: string): this {
    this.actions.push({ floor: this.floor, type: 'Text', text });
    return this;
  }

  speed(bpm: number): this {
    this.actions.push({ floor: this.floor, type: 'SetSpeed', bpm });
    this.bpm = bpm;
    return this;
  }

  get currentBpm(): number {
    return this.bpm;
  }

  camera(opts: { zoom?: number; rotation?: number; offset?: [number, number]; duration?: number; ease?: EaseName }): this {
    this.actions.push({ floor: this.floor, type: 'Camera', ...opts });
    return this;
  }

  flash(color = '#ffffff', opacity = 0.4, duration = 1): this {
    this.actions.push({ floor: this.floor, type: 'Flash', color, opacity, duration });
    return this;
  }

  recolor(color: string, length: number, duration = 1): this {
    this.actions.push({ floor: this.floor, type: 'RecolorTrack', from: this.floor, to: this.floor + length, color, duration });
    return this;
  }

  background(color: string): this {
    this.actions.push({ floor: this.floor, type: 'Background', color });
    return this;
  }

  build(): LevelData {
    const last = this.path.length;
    const actions = this.actions.map((a) =>
      a.type === 'RecolorTrack' || a.type === 'MoveTrack' ? { ...a, to: Math.min(a.to, last) } : a,
    );
    return { version: 1, meta: this.meta, settings: this.settings, path: [...this.path], actions };
  }
}

/**
 * 자주 쓰는 리듬 조각 (박 수 배열). 회전 방향에 따라 좌/우 모양이 정해진다.
 */
export const RHYTHMS = {
  /** 반박 + 한박반: 계단 */
  stairs: [0.5, 1.5],
  /** 한박반 + 반박: 반대 계단 */
  stairsDown: [1.5, 0.5],
  /** 스윙: 0.75 + 1.25 (대각선) */
  swing: [0.75, 1.25],
  swingBack: [1.25, 0.75],
  /** 셋잇단: 1/3 박 ×3 = 1박 */
  triplet: [1 / 3, 1 / 3, 1 / 3],
  /** 3박자 느낌: 2/3 + 1/3 (셔플) */
  shuffle: [2 / 3, 1 / 3],
  /** 싱코페이션: 0.5 1 0.5 */
  synco: [0.5, 1, 0.5],
  /** 8분음 네 개 = 2박 */
  eighths: [0.5, 0.5, 0.5, 0.5],
  /** 점 4분 + 8분 */
  dotted: [1.5, 0.5],
} as const;

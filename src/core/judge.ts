export type Judgment = 'perfect' | 'earlyPerfect' | 'latePerfect' | 'early' | 'late' | 'tooEarly' | 'miss';
export type HitJudgment = Exclude<Judgment, 'tooEarly' | 'miss'>;
export type JudgeDifficulty = 'lenient' | 'normal' | 'strict';

export const DIFFICULTY_MULT: Record<JudgeDifficulty, number> = {
  lenient: 1.4,
  normal: 1.0,
  strict: 0.7,
};

export const BASE_WINDOWS = { perfect: 35, near: 70, far: 110 } as const;

export interface Windows {
  perfect: number;
  near: number;
  far: number;
}

/**
 * 판정 창 (ms). window(x) = min(x × 배율, cap), cap = max(beatMs × 0.25, minCapMs).
 * minCapMs: 앞뒤 음표 간격의 절반 — 속도를 올린 구간(보이는 박이 짧음)에서도 창이 지나치게 좁아지지 않게.
 */
export function judgeWindows(beatMs: number, mult = 1, minCapMs = 0): Windows {
  const cap = Math.max(beatMs * 0.25, minCapMs);
  return {
    perfect: Math.min(BASE_WINDOWS.perfect * mult, cap),
    near: Math.min(BASE_WINDOWS.near * mult, cap),
    far: Math.min(BASE_WINDOWS.far * mult, cap),
  };
}

/**
 * 입력 오차 e (ms, 음수 = 빠름) 판정.
 * tooEarlyLimitMs: 이보다 더 이른 입력은 무시 (null).
 */
export function judgeError(e: number, w: Windows, tooEarlyLimitMs: number): Judgment | null {
  const a = Math.abs(e);
  if (a <= w.perfect) return 'perfect';
  if (a <= w.near) return e < 0 ? 'earlyPerfect' : 'latePerfect';
  if (a <= w.far) return e < 0 ? 'early' : 'late';
  if (e > 0) return 'miss';
  if (-e <= tooEarlyLimitMs) return 'tooEarly';
  return null;
}

/** 진행하는 판정인가 (너무 빠름·놓침 제외). */
export function advances(j: Judgment): j is HitJudgment {
  return j !== 'tooEarly' && j !== 'miss';
}

export const JUDGE_LABEL: Record<Judgment, string> = {
  perfect: '완벽',
  earlyPerfect: '약간 빠름',
  latePerfect: '약간 느림',
  early: '빠름',
  late: '느림',
  tooEarly: '너무 빠름',
  miss: '놓침',
};

export const JUDGE_COLOR: Record<Judgment, number> = {
  perfect: 0x5cf07a,
  earlyPerfect: 0xc6f25a,
  latePerfect: 0xf2e45a,
  early: 0xff9d3c,
  late: 0xff9d3c,
  tooEarly: 0xff4a4a,
  miss: 0xff4a4a,
};

/** 정확도 가중치. */
export const JUDGE_WEIGHT: Record<Judgment, number> = {
  perfect: 1,
  earlyPerfect: 0.75,
  latePerfect: 0.75,
  early: 0.4,
  late: 0.4,
  tooEarly: 0,
  miss: 0,
};

/** 과부하: windowSec 안에 limit회 이상 너무 빠름. */
export class OverloadTracker {
  private stamps: number[] = [];
  constructor(
    private readonly limit = 4,
    private readonly windowSec = 0.5,
  ) {}
  /** 너무 빠름 발생 시각(실제 초) 기록. 과부하면 true. */
  push(t: number): boolean {
    this.stamps.push(t);
    this.stamps = this.stamps.filter((s) => t - s < this.windowSec);
    return this.stamps.length >= this.limit;
  }
  reset(): void {
    this.stamps = [];
  }
}

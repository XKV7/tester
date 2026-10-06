import { describe, expect, it } from 'vitest';
import type { Judgment } from '../src/core/judge';
import { PlayStats } from '../src/core/stats';

function fill(s: PlayStats, counts: Partial<Record<Judgment, number>>, checkpoints: number) {
  let f = 1;
  for (const [j, n] of Object.entries(counts) as [Judgment, number][]) {
    for (let i = 0; i < n; i++) {
      if (j === 'tooEarly') s.recordTooEarly(f);
      else s.recordHit(f++, j);
    }
  }
  s.checkpointUses = checkpoints;
}

describe('절대정확도 (원작 X-Accuracy)', () => {
  it('원작 결과 화면과 같은 값', () => {
    // 원작 R 클리어: 빠름 55 · 정확 504 · 느림 16 · 너무 빠름 53 · 빠름! 135 · 느림! 19 · 체크포인트 40 → 48.67%
    const a = new PlayStats();
    fill(a, { perfect: 504, earlyPerfect: 55, latePerfect: 16, early: 135, late: 19, tooEarly: 53 }, 40);
    expect(a.xAccuracy()).toBeCloseTo(48.67, 1);
    // 두 번째 판: 59 · 498 · 27 · 37 · 121 · 21 · 체크포인트 59 → 39.10%
    const b = new PlayStats();
    fill(b, { perfect: 498, earlyPerfect: 59, latePerfect: 27, early: 121, late: 21, tooEarly: 37 }, 59);
    expect(b.xAccuracy()).toBeCloseTo(39.1, 1);
  });

  it('모두 완벽이면 100, 놓침은 0점', () => {
    const s = new PlayStats();
    fill(s, { perfect: 10 }, 0);
    expect(s.xAccuracy()).toBe(100);
    const m = new PlayStats();
    fill(m, { perfect: 10, miss: 10 }, 0);
    expect(m.xAccuracy()).toBeCloseTo(50);
  });
});

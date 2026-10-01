import { describe, expect, it } from 'vitest';
import { analyzeOffsets, worthSuggesting } from '../src/core/offset';

describe('오프셋 추천', () => {
  it('늦게 치는 경향 → 양수, 실수(크게 벗어난 값)는 무시', () => {
    const errs = [...Array(30)].map((_, i) => 20 + ((i * 7) % 11) - 5);
    errs.push(-150, 140, 200);
    const h = analyzeOffsets(errs)!;
    expect(h.median).toBeGreaterThanOrEqual(18);
    expect(h.median).toBeLessThanOrEqual(22);
    expect(worthSuggesting(h)).toBe(true);
  });
  it('적거나 치우침이 작으면 추천 안 함', () => {
    expect(analyzeOffsets([10, 12])).toBeNull();
    const h = analyzeOffsets([...Array(20)].map((_, i) => (i % 2 ? 3 : -3)));
    expect(worthSuggesting(h)).toBe(false);
  });
});

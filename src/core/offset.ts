/**
 * 친 타이밍 오차로 오프셋 추천. 오차(ms): +면 늦게 침.
 * 빠른 연타는 손이 먼저 나가기 쉬워, 크게 벗어난 값을 빼고 중앙값을 쓴다.
 */
export interface OffsetHint {
  /** 오차 중앙값 (ms, +면 늦게 침) */
  median: number;
  /** 흩어짐 (중앙값 절대 편차, ms) */
  spread: number;
  /** 쓴 타격 수 */
  count: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 오차 목록 → 추천 (충분하지 않으면 null). */
export function analyzeOffsets(errors: number[], minCount = 16): OffsetHint | null {
  if (errors.length < minCount) return null;
  const m0 = median(errors);
  const mad0 = median(errors.map((e) => Math.abs(e - m0)));
  // 중앙값에서 크게 벗어난 타격(실수)은 뺀다
  const lim = Math.max(25, mad0 * 3);
  const kept = errors.filter((e) => Math.abs(e - m0) <= lim);
  if (kept.length < minCount * 0.75) return null;
  const m = median(kept);
  return { median: Math.round(m), spread: Math.round(median(kept.map((e) => Math.abs(e - m)))), count: kept.length };
}

/** 추천을 보여줄 만한지: 지금 값과 충분히 다르고, 너무 들쭉날쭉하지 않을 때. */
export function worthSuggesting(h: OffsetHint | null, current = 0): h is OffsetHint {
  return !!h && Math.abs(h.median - current) >= 8 && h.spread <= 40;
}

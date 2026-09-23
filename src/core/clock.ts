/**
 * 불규칙하게 갱신되는 오디오 시계(audioCtx.currentTime)를 performance.now()로
 * 선형 보간해 부드러운 시계를 만든다. 순수 로직 (DOM 의존 없음).
 *
 * - 보간 값과 원시 값 차이가 snapSec 이상이면 원시 값으로 스냅.
 * - 그 외에는 원시 값 쪽으로 천천히 수렴시키되 단조 증가를 유지.
 */
export class SmoothClock {
  private est: number | null = null;
  private lastPerf = 0;
  private lastRaw = NaN;

  constructor(
    private readonly snapSec = 0.02,
    private readonly gain = 0.08,
  ) {}

  reset(): void {
    this.est = null;
    this.lastRaw = NaN;
  }

  /** rawSec: 오디오 시계 값, perfMs: performance.now(). running=false면 원시 값 사용. */
  sample(rawSec: number, perfMs: number, running = true): number {
    if (!running || this.est === null) {
      this.est = rawSec;
      this.lastPerf = perfMs;
      this.lastRaw = rawSec;
      return rawSec;
    }
    const predicted = this.est + (perfMs - this.lastPerf) / 1000;
    let next: number;
    const diff = rawSec - predicted;
    if (Math.abs(diff) >= this.snapSec) next = rawSec;
    else if (rawSec !== this.lastRaw) next = predicted + diff * this.gain;
    else next = predicted;
    if (next < this.est && Math.abs(diff) < this.snapSec) next = this.est;
    this.est = next;
    this.lastPerf = perfMs;
    this.lastRaw = rawSec;
    return next;
  }

  /** 마지막 샘플 기준으로 과거/미래 perf 시각의 값 추정. */
  at(perfMs: number): number {
    if (this.est === null) return 0;
    return this.est + (perfMs - this.lastPerf) / 1000;
  }
}

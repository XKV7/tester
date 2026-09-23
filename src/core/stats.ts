import { JUDGE_WEIGHT, type Judgment } from './judge';

export type JudgeCounts = Record<Judgment, number>;

export function emptyCounts(): JudgeCounts {
  return { perfect: 0, earlyPerfect: 0, latePerfect: 0, early: 0, late: 0, tooEarly: 0, miss: 0 };
}

/**
 * 플레이 통계. 타일별로 기록해 체크포인트 재개 시 이후 기록을 지울 수 있다.
 */
export class PlayStats {
  /** floor → 진행 판정 */
  private hits = new Map<number, Judgment>();
  /** floor → 너무 빠름 횟수 */
  private tooEarly = new Map<number, number>();
  /** 홀드 떼기 판정 */
  private releases = new Map<number, Judgment>();
  checkpointUses = 0;
  fails = 0;
  private streak = 0;
  maxStreak = 0;

  recordHit(floor: number, j: Judgment): void {
    this.hits.set(floor, j);
    this.bumpStreak(j);
  }
  recordRelease(floor: number, j: Judgment): void {
    this.releases.set(floor, j);
    this.bumpStreak(j);
  }
  recordTooEarly(floor: number): void {
    this.tooEarly.set(floor, (this.tooEarly.get(floor) ?? 0) + 1);
    this.streak = 0;
  }
  private bumpStreak(j: Judgment): void {
    if (j === 'perfect') {
      this.streak++;
      if (this.streak > this.maxStreak) this.maxStreak = this.streak;
    } else this.streak = 0;
  }

  /** floor 이후(초과) 기록 삭제 — 체크포인트 재개. */
  truncateAfter(floor: number): void {
    for (const m of [this.hits, this.tooEarly, this.releases] as Map<number, unknown>[])
      for (const k of [...m.keys()]) if (k > floor) m.delete(k);
    this.streak = 0;
  }

  reset(): void {
    this.hits.clear();
    this.tooEarly.clear();
    this.releases.clear();
    this.checkpointUses = 0;
    this.fails = 0;
    this.streak = 0;
    this.maxStreak = 0;
  }

  counts(): JudgeCounts {
    const c = emptyCounts();
    for (const j of this.hits.values()) c[j]++;
    for (const j of this.releases.values()) c[j]++;
    for (const n of this.tooEarly.values()) c.tooEarly += n;
    return c;
  }

  /** 정확도 (0~100). 기록이 없으면 100. */
  accuracy(): number {
    const c = this.counts();
    let total = 0;
    let sum = 0;
    for (const k of Object.keys(c) as Judgment[]) {
      total += c[k];
      sum += c[k] * JUDGE_WEIGHT[k];
    }
    return total === 0 ? 100 : (sum / total) * 100;
  }

  /** 완벽 클리어: 모든 판정이 완벽. */
  isAllPerfect(): boolean {
    const c = this.counts();
    return c.perfect > 0 && c.perfect === Object.values(c).reduce((a, b) => a + b, 0);
  }

  /** 무결점 클리어: 실패·체크포인트 사용·너무 빠름 없이 한 번에 클리어. */
  isFlawless(): boolean {
    return this.fails === 0 && this.checkpointUses === 0 && this.counts().tooEarly === 0;
  }
}

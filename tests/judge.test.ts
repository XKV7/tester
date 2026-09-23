import { describe, expect, it } from 'vitest';
import { DIFFICULTY_MULT, judgeError, judgeWindows, OverloadTracker } from '../src/core/judge';
import { PlayStats } from '../src/core/stats';

const w = judgeWindows(500); // 120bpm: 상한 125ms → 기본 창 그대로
const J = (e: number) => judgeError(e, w, 250);

describe('판정 경계값', () => {
  it('완벽 ±35ms', () => {
    expect(J(0)).toBe('perfect');
    expect(J(35)).toBe('perfect');
    expect(J(-35)).toBe('perfect');
    expect(J(35.01)).toBe('latePerfect');
    expect(J(-35.01)).toBe('earlyPerfect');
  });
  it('약간 ±70ms', () => {
    expect(J(70)).toBe('latePerfect');
    expect(J(-70)).toBe('earlyPerfect');
    expect(J(70.01)).toBe('late');
    expect(J(-70.01)).toBe('early');
  });
  it('빠름·느림 ±110ms', () => {
    expect(J(110)).toBe('late');
    expect(J(-110)).toBe('early');
    expect(J(110.01)).toBe('miss');
    expect(J(-110.01)).toBe('tooEarly');
  });
  it('너무 빠름 하한 이전 입력은 무시', () => {
    expect(J(-250)).toBe('tooEarly');
    expect(J(-250.01)).toBeNull();
  });
  it('창 상한 beatMs × 0.25', () => {
    const fast = judgeWindows(200); // 300bpm → 상한 50ms
    expect(fast.perfect).toBe(35);
    expect(fast.near).toBe(50);
    expect(fast.far).toBe(50);
    expect(judgeError(50, fast, 100)).toBe('latePerfect');
    expect(judgeError(50.01, fast, 100)).toBe('miss');
    expect(judgeError(-50.01, fast, 100)).toBe('tooEarly');
  });
  it('앞뒤 음표 간격 기반 하한 (속도 올린 구간)', () => {
    // 보이는 박 83ms(720BPM)라도 실제 음표 간격 83ms면 창 상한 ≈ 41.7ms
    const w2 = judgeWindows(83.3, 1, 83.3 / 2);
    expect(w2.perfect).toBe(35);
    expect(w2.far).toBeCloseTo(41.65, 1);
    // 일반 타일은 그대로
    expect(judgeWindows(500, 1, 250)).toEqual(judgeWindows(500));
  });

  it('난이도 배율', () => {
    const lenient = judgeWindows(1000, DIFFICULTY_MULT.lenient);
    expect(lenient.perfect).toBeCloseTo(49);
    expect(lenient.far).toBeCloseTo(154);
    const strict = judgeWindows(1000, DIFFICULTY_MULT.strict);
    expect(strict.perfect).toBeCloseTo(24.5);
    expect(strict.near).toBeCloseTo(49);
    // 배율 적용 후에도 상한 유지
    expect(judgeWindows(400, 1.4).far).toBe(100);
  });
});

describe('과부하 실패', () => {
  it('0.5초 안에 4회면 실패', () => {
    const o = new OverloadTracker();
    expect(o.push(0)).toBe(false);
    expect(o.push(0.1)).toBe(false);
    expect(o.push(0.2)).toBe(false);
    expect(o.push(0.49)).toBe(true);
  });
  it('0.5초를 넘기면 누적 초기화', () => {
    const o = new OverloadTracker();
    o.push(0);
    o.push(0.1);
    o.push(0.2);
    expect(o.push(0.5)).toBe(false); // 0은 창 밖
    expect(o.push(0.55)).toBe(true); // 0.1, 0.2, 0.5, 0.55
  });
  it('reset', () => {
    const o = new OverloadTracker();
    o.push(0);
    o.push(0);
    o.push(0);
    o.reset();
    expect(o.push(0)).toBe(false);
  });
});

describe('통계', () => {
  it('정확도와 체크포인트 재개', () => {
    const s = new PlayStats();
    s.recordHit(1, 'perfect');
    s.recordHit(2, 'perfect');
    s.recordHit(3, 'early');
    expect(s.accuracy()).toBeCloseTo((2 + 0.4) / 3 * 100);
    expect(s.maxStreak).toBe(2);
    s.truncateAfter(2);
    expect(s.accuracy()).toBe(100);
    expect(s.isAllPerfect()).toBe(true);
    s.recordTooEarly(3);
    expect(s.isAllPerfect()).toBe(false);
    expect(s.isFlawless()).toBe(false);
  });
});

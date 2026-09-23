import { describe, expect, it } from 'vitest';
import { autoChart, layoutBeats } from '../src/core/autochart';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { TILE_LEN } from '../src/core/math';

const SR = 8000;

/** 지정한 박 위치에만 킥이 있는 곡. */
function kickSong(bpm: number, first: number, beatsAt: number[], lengthSec: number): Float32Array {
  const out = new Float32Array(Math.ceil(lengthSec * SR));
  const beat = 60 / bpm;
  for (const b of beatsAt) {
    const s0 = Math.floor((first + b * beat) * SR);
    let ph = 0;
    for (let i = 0; i < 0.15 * SR; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (50 + 120 * Math.exp(-t * 30))) / SR;
      if (s0 + i < out.length) out[s0 + i] += Math.sin(ph) * Math.exp(-t * 12) * 0.8;
    }
  }
  return out;
}

function overlaps(path: number[]): number {
  const lv = { version: 1 as const, meta: {} as never, settings: { bpm: 100, offset: 0, startDirection: 'CW' } as never, path, actions: [] };
  const c = compileChart(lv as never);
  let bad = 0;
  for (let i = 0; i < c.tiles.length; i++)
    for (let j = i + 3; j < c.tiles.length; j++)
      if (Math.hypot(c.tiles[i].x - c.tiles[j].x, c.tiles[i].y - c.tiles[j].y) < TILE_LEN * 0.6) bad++;
  return bad;
}

describe('자동 레벨 생성', () => {
  // 매 박 킥 + 가끔 반박 (8박 주기 리듬)
  const bar = [0, 1, 2, 2.5, 3, 4, 5, 5.5, 6, 7];
  const beats: number[] = [];
  for (let k = 0; k < 24; k++) for (const b of bar) beats.push(k * 8 + b);
  const bpm = 110;
  const first = 1.2;
  const song = kickSong(bpm, first, beats, first + (24 * 8 * 60) / bpm + 2);

  it('보통: 실제 킥 위치에 타일이 생긴다', () => {
    const r = autoChart(song, SR, { difficulty: 'normal', title: '테스트' });
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - bpm)).toBeLessThan(0.3);
    expect(validateLevel(r!.level).ok).toBe(true);
    const chart = compileChart(r!.level);
    const hitTimes = chart.times.slice(1, -1);
    const truth = beats.map((b) => first + (b * 60) / bpm);
    const near = (t: number, xs: number[]) => xs.some((x) => Math.abs(x - t) < 0.03);
    const precision = hitTimes.filter((t) => near(t, truth)).length / hitTimes.length;
    const inRange = truth.filter((t) => t > chart.times[0] + 0.1 && t < chart.lastTime - 0.1);
    const recall = inRange.filter((t) => near(t, hitTimes)).length / inRange.length;
    expect(precision).toBeGreaterThan(0.9);
    expect(recall).toBeGreaterThan(0.85);
    // 반박 리듬이 실제로 들어갔는지
    expect(chart.tiles.some((t) => Math.abs(t.beats - 0.5) < 1e-6)).toBe(true);
  });

  it('난이도가 올라갈수록 반박이 많다', () => {
    const halfRatio = (d: 'easy' | 'normal' | 'hard') => {
      const c = compileChart(autoChart(song, SR, { difficulty: d })!.level);
      const ts = c.tiles.slice(0, -1);
      return ts.filter((t) => Math.abs(t.beats - 0.5) < 1e-6).length / ts.length;
    };
    const [e, n, h] = [halfRatio('easy'), halfRatio('normal'), halfRatio('hard')];
    expect(e).toBeLessThanOrEqual(n);
    expect(n).toBeLessThanOrEqual(h);
    expect(e).toBeLessThan(0.3);
  });

  it('입력 간격 200ms 이상, 트랙 겹침 최소', () => {
    for (const d of ['easy', 'normal', 'hard'] as const) {
      const r = autoChart(song, SR, { difficulty: d })!;
      const c = compileChart(r.level);
      const fastest = Math.min(...c.tiles.slice(0, -1).map((t) => t.duration));
      expect(fastest).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(overlaps(r.level.path)).toBeLessThanOrEqual(Math.ceil(c.tiles.length * 0.02));
    }
  });

  it('BPM·offset 지정', () => {
    const r = autoChart(song, SR, { difficulty: 'normal', bpm: 110, offset: first })!;
    expect(r.bpm).toBe(110);
    expect(r.offset).toBeCloseTo(first, 3);
  });

  it('무음은 null', () => {
    expect(autoChart(new Float32Array(SR * 20), SR)).toBeNull();
  });

  it('레이아웃: 반박 연속도 고리로 겹치지 않게 Twirl', () => {
    const lay = layoutBeats(Array.from({ length: 40 }, () => 0.5));
    expect(lay.twirls.length).toBeGreaterThan(0);
    expect(overlaps(lay.path)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { synthBeatTrack } from '../src/audio/beatTrack';
import { compileChart } from '../src/core/chart';
import { emptyLevel } from '../src/core/level';
import { estimateTempo, tapTempo } from '../src/core/tempo';

function track(bpm: number, offset: number, tiles = 48) {
  const lv = emptyLevel();
  lv.settings.bpm = bpm;
  lv.settings.offset = offset;
  lv.path = Array.from({ length: tiles }, () => 0);
  return synthBeatTrack(compileChart(lv), 8000);
}

describe('BPM·offset 추정', () => {
  for (const [bpm, offset] of [
    [120, 1.0],
    [97, 0.37],
    [140, 2.21],
    [84, 0.5],
  ] as const) {
    it(`${bpm}BPM, offset ${offset}`, () => {
      const r = estimateTempo(track(bpm, offset), 8000);
      expect(r).not.toBeNull();
      expect(Math.abs(r!.bpm - bpm)).toBeLessThan(0.3);
      const period = 60 / bpm;
      const d = Math.abs(((r!.offset - offset) % period + period * 1.5) % period - period / 2);
      expect(d * 1000).toBeLessThan(12);
    });
  }
  it('무음·짧은 입력은 null', () => {
    expect(estimateTempo(new Float32Array(8000 * 10), 8000)).toBeNull();
    expect(estimateTempo(new Float32Array(8000), 8000)).toBeNull();
  });
});

describe('탭 템포', () => {
  it('평균 간격', () => {
    expect(tapTempo([0, 0.5, 1.0, 1.5, 2.0])).toBe(120);
    expect(Math.abs(tapTempo([0, 0.5, 1.02, 1.5, 2.0, 2.49])! - 120)).toBeLessThan(1.5);
    expect(tapTempo([0, 1])).toBeNull();
  });
});

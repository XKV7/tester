import { describe, expect, it } from 'vitest';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { TILE_LEN } from '../src/core/math';
import { LevelBuilder } from '../src/levels/builder';
import { demoLevels } from '../src/levels/demos';

describe('리듬 빌더', () => {
  it('주어진 박 수가 그대로 나온다 (CW/CCW, Twirl)', () => {
    const b = LevelBuilder.create({}, { bpm: 120, offset: 0 });
    b.beats(1, 0.5, 1.5, 0.75, 1.25, 2 / 3, 4 / 3).twirl().beats(0.5, 1.5, 1);
    const c = compileChart(b.build());
    const beats = c.tiles.slice(0, -1).map((t) => t.beats);
    [1, 0.5, 1.5, 0.75, 1.25, 2 / 3, 4 / 3, 0.5, 1.5, 1].forEach((v, i) => expect(beats[i]).toBeCloseTo(v, 9));
  });
  it('midspin/pause/hold', () => {
    const b = LevelBuilder.create({}, { bpm: 120, offset: 0 });
    b.straight(2).beats(0.5).midspin().beats(0.5).pause(2).hold(2, 1).straight(1);
    const lv = b.build();
    expect(validateLevel(lv).ok).toBe(true);
    const c = compileChart(lv);
    expect(c.tiles[2].beats).toBe(0.5);
    expect(c.tiles[3].beats).toBe(0);
    expect(c.tiles[3].midspin).toBe(true);
    expect(c.tiles[4].beats).toBe(0.5);
    expect(c.tiles[5].beats).toBe(3);
    expect(c.tiles[6].beats).toBe(3);
  });
});

describe('데모 레벨', () => {
  for (const d of demoLevels()) {
    it(`${d.id}: 유효하고 트랙이 겹치지 않는다`, () => {
      const r = validateLevel(d.level);
      expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
      const c = compileChart(d.level);
      const mid = new Set(c.tiles.filter((t) => t.midspin).map((t) => t.floor));
      // Midspin 전후는 설계상 같은 자리에 겹친다
      const skip = (i: number, j: number) =>
        Math.abs(i - j) <= 1 || [...mid].some((m) => (i === m - 1 && j === m + 1) || (j === m - 1 && i === m + 1)) ||
        [...mid].some((m) => Math.abs(i - m) <= 2 && Math.abs(j - m) <= 2);
      const bad: string[] = [];
      for (let i = 0; i < c.tiles.length; i++)
        for (let j = i + 1; j < c.tiles.length; j++) {
          if (skip(i, j)) continue;
          const d2 = Math.hypot(c.tiles[i].x - c.tiles[j].x, c.tiles[i].y - c.tiles[j].y);
          if (d2 < TILE_LEN * 0.6) bad.push(`${i}-${j}`);
        }
      expect(bad).toEqual([]);
    });
  }
  it('BPM은 적당히 느리다', () => {
    for (const d of demoLevels()) {
      const c = compileChart(d.level);
      const fastest = Math.min(...c.tiles.filter((t) => t.duration > 0).map((t) => t.duration));
      expect(fastest, d.id).toBeGreaterThanOrEqual(0.2); // 입력 간격 200ms 이상
    }
  });
});

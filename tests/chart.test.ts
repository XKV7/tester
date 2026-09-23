import { describe, expect, it } from 'vitest';
import { beatPhaseAt, compileChart, orbiterAngle, resumeTime } from '../src/core/chart';
import { emptyLevel } from '../src/core/level';
import { normDeg } from '../src/core/math';
import type { Action, LevelData } from '../src/core/types';

function level(path: number[], actions: Action[] = [], bpm = 120, offset = 0): LevelData {
  const lv = emptyLevel();
  lv.path = path;
  lv.actions = actions;
  lv.settings.bpm = bpm;
  lv.settings.offset = offset;
  return lv;
}

describe('hitTime 계산', () => {
  it('직진 120BPM → 0.5초 간격', () => {
    const c = compileChart(level([0, 0, 0], [], 120, 0.45));
    expect(c.times).toHaveLength(4);
    expect(c.times[0]).toBeCloseTo(0.45);
    expect(c.times[1]).toBeCloseTo(0.95);
    expect(c.times[3]).toBeCloseTo(1.95);
  });
  it('꺾기 박 수 반영', () => {
    const c = compileChart(level([0, 90, 0, 270, 0]));
    expect(c.tiles.map((t) => t.beats)).toEqual([1, 0.5, 1.5, 1.5, 0.5, 0]);
  });
  it('SetSpeed(bpm, multiplier) 적용 후 누적', () => {
    const c = compileChart(
      level([0, 0, 0, 0, 0], [
        { floor: 2, type: 'SetSpeed', multiplier: 2 },
        { floor: 4, type: 'SetSpeed', bpm: 60 },
      ]),
    );
    // 120bpm: 0.5s, 0.5s | 240bpm: 0.25, 0.25 | 60bpm: 1
    expect(c.times).toEqual([0, 0.5, 1.0, 1.25, 1.5, 2.5]);
    expect(c.tiles[2].bpm).toBe(240);
    expect(c.tiles[2].speed).toBe('up');
    expect(c.tiles[4].speed).toBe('down');
  });
  it('Twirl 연속 적용', () => {
    const c = compileChart(
      level([0, 90, 90, 180, 180], [
        { floor: 1, type: 'Twirl' },
        { floor: 2, type: 'Twirl' },
        { floor: 3, type: 'Twirl' },
      ]),
    );
    expect(c.tiles.map((t) => t.dir)).toEqual(['CW', 'CCW', 'CW', 'CCW', 'CCW', 'CCW']);
    // tile1: start 180 → 90 CCW = 270 → 1.5 / tile2 CW 직진 1 / tile3: start 270 → 180 CCW = 270 → 1.5
    expect(c.tiles[1].beats).toBe(1.5);
    expect(c.tiles[2].beats).toBe(1);
    expect(c.tiles[3].beats).toBe(1.5);
  });
  it('같은 타일 Twirl 두 번은 상쇄', () => {
    const c = compileChart(level([0, 90], [
      { floor: 1, type: 'Twirl' },
      { floor: 1, type: 'Twirl' },
    ]));
    expect(c.tiles[1].dir).toBe('CW');
  });
  it('Midspin = 0박', () => {
    const c = compileChart(level([0, 90, 270, 0], [{ floor: 2, type: 'Midspin' }]));
    expect(c.tiles[2].beats).toBe(0);
    expect(c.times[3]).toBe(c.times[2]);
    // 다음 타일은 이전 타일 위치에 겹친다
    expect(c.tiles[3].x).toBeCloseTo(c.tiles[1].x);
    expect(c.tiles[3].y).toBeCloseTo(c.tiles[1].y);
    expect(c.tiles[3].start).toBe(90);
  });
  it('Pause는 박을 추가하고 목표 각도에 정확히 도착', () => {
    const c = compileChart(level([0, 0], [{ floor: 1, type: 'Pause', beats: 2 }]));
    const t = c.tiles[1];
    expect(t.beats).toBe(3);
    expect(t.sweep).toBe(540);
    const end = orbiterAngle(t, t.time + t.duration);
    expect(normDeg(end)).toBeCloseTo(t.target);
  });
  it('공전 각도: CW는 감소', () => {
    const c = compileChart(level([0, 0]));
    const t = c.tiles[0];
    expect(orbiterAngle(t, t.time)).toBe(180);
    expect(normDeg(orbiterAngle(t, t.time + t.duration / 2))).toBeCloseTo(90);
    expect(normDeg(orbiterAngle(t, t.time + t.duration))).toBeCloseTo(0);
  });
  it('박 위상과 재개 시각', () => {
    const c = compileChart(level([0, 90, 0], [], 120, 1));
    expect(beatPhaseAt(c, 1)).toBe(0);
    expect(beatPhaseAt(c, 1.5)).toBeCloseTo(1);
    expect(beatPhaseAt(c, 0.5)).toBeCloseTo(-1);
    expect(resumeTime(c, 2)).toBeCloseTo(c.times[2] - 1);
  });
});

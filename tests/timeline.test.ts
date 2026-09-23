import { describe, expect, it } from 'vitest';
import { compileChart } from '../src/core/chart';
import { SmoothClock } from '../src/core/clock';
import { emptyLevel } from '../src/core/level';
import { VisualTimeline } from '../src/core/timeline';
import { insertTileAfter, deleteTile, recordToAngles, fillStraight } from '../src/core/editorOps';
import { compileChart as cc } from '../src/core/chart';

function chart() {
  const lv = emptyLevel();
  lv.settings.bpm = 60;
  lv.settings.offset = 0;
  lv.path = [0, 0, 0, 0, 0, 0];
  lv.actions = [
    { floor: 1, type: 'Camera', zoom: 2, duration: 2 },
    { floor: 2, type: 'RecolorTrack', from: 3, to: 4, color: '#ff0000', duration: 0 },
    { floor: 3, type: 'MoveTrack', from: 5, to: 6, offset: [10, 0], opacity: 0, duration: 1 },
    { floor: 4, type: 'Background', color: '#112233' },
  ];
  return compileChart(lv);
}

describe('연출 타임라인', () => {
  it('카메라 보간', () => {
    const tl = new VisualTimeline(chart());
    tl.update(0.5);
    expect(tl.camera.zoom).toBe(1);
    tl.update(2);
    expect(tl.camera.zoom).toBeCloseTo(1.5);
    tl.update(3);
    expect(tl.camera.zoom).toBeCloseTo(2);
  });
  it('색·이동·배경', () => {
    const tl = new VisualTimeline(chart());
    tl.update(3.5);
    expect(tl.tileColor[3]).toBe(0xff0000);
    expect(tl.tileColor[2]).toBe(0x3a3f55);
    expect(tl.tileOffX[5]).toBeCloseTo(5);
    expect(tl.tileAlpha[6]).toBeCloseTo(0.5);
    tl.update(4.1);
    expect(tl.bgColor).toBe(0x112233);
  });
  it('시간 역행 시 재계산', () => {
    const tl = new VisualTimeline(chart());
    tl.update(10);
    expect(tl.camera.zoom).toBeCloseTo(2);
    tl.update(0.1);
    expect(tl.camera.zoom).toBe(1);
    expect(tl.tileColor[3]).toBe(0x3a3f55);
  });
});

describe('부드러운 시계', () => {
  it('보간 후 20ms 이상 벌어지면 스냅', () => {
    const c = new SmoothClock();
    expect(c.sample(1, 0)).toBe(1);
    // 오디오 시계가 갱신되지 않아도 perf 기준으로 진행
    expect(c.sample(1, 10)).toBeCloseTo(1.01);
    // 큰 차이 → 스냅
    expect(c.sample(1.5, 20)).toBe(1.5);
  });
  it('단조 증가', () => {
    const c = new SmoothClock();
    c.sample(1, 0);
    const a = c.sample(1.0, 16);
    const b = c.sample(1.005, 17);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('에디터 조작', () => {
  it('타일 삽입/삭제 시 이벤트 floor 이동', () => {
    const lv = emptyLevel();
    lv.path = [0, 0, 0];
    lv.actions = [{ floor: 2, type: 'Twirl' }];
    const r = insertTileAfter(lv, 1, 90);
    expect(r.level.path).toEqual([0, 90, 0, 0]);
    expect(r.sel).toBe(2);
    expect(r.level.actions[0].floor).toBe(3);
    const d = deleteTile(r.level, 2);
    expect(d.level.path).toEqual([0, 0, 0]);
    expect(d.level.actions[0].floor).toBe(2);
  });
  it('녹화: 간격 → 각도', () => {
    // 120bpm: 0.5s=1박=직진, 0.25s=0.5박, 0.75s=1.5박
    const r = recordToAngles([0.5, 0.25, 0.75], 120, 180, 'CW', 'oneway');
    expect(r.angles).toEqual([0, 90, 0]);
    const lv = emptyLevel();
    lv.settings.bpm = 120;
    lv.settings.offset = 0;
    lv.path = r.angles;
    const c = cc(lv);
    expect(c.tiles.slice(0, 3).map((t) => t.beats)).toEqual([1, 0.5, 1.5]);
  });
  it('녹화 지그재그는 Twirl로 좌우 번갈아', () => {
    const r = recordToAngles([0.25, 0.25, 0.25], 120, 180, 'CW', 'zigzag');
    expect(r.twirls).toEqual([1, 2]);
    expect(r.angles[0]).toBe(90);
  });
  it('직진 채우기', () => {
    const lv = emptyLevel();
    lv.path = [90];
    const r = fillStraight(lv, 1, 3, 150);
    expect(r.level.path).toEqual([90, 90, 90, 90]);
    expect(r.sel).toBe(4);
    const c = cc(r.level);
    expect(c.tiles[1].bpm).toBe(150);
    expect(c.tiles[1].beats).toBe(1);
  });
});

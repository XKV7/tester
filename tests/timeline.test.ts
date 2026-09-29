import { describe, expect, it } from 'vitest';
import { compileChart } from '../src/core/chart';
import { SmoothClock } from '../src/core/clock';
import { emptyLevel } from '../src/core/level';
import { VisualTimeline } from '../src/core/timeline';
import { insertTileAfter, deleteTile, recordToAngles, fillStraight, truncateAfter } from '../src/core/editorOps';
import { validateLevel } from '../src/core/level';
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
  it('덮어쓰기용 잘라내기', () => {
    const lv = emptyLevel();
    lv.path = [0, 0, 90, 0, 0, 0];
    lv.actions = [
      { floor: 1, type: 'Twirl' },
      { floor: 4, type: 'Checkpoint' },
      { floor: 3, type: 'Pause', beats: 2 },
      { floor: 1, type: 'RecolorTrack', from: 1, to: 6, color: '#ff0000' },
    ];
    const t = truncateAfter(lv, 3);
    expect(t.path).toEqual([0, 0, 90]);
    expect(t.actions.map((a) => a.type)).toEqual(['Twirl', 'RecolorTrack']);
    expect((t.actions[1] as { to: number }).to).toBe(3);
    expect(validateLevel(t).ok).toBe(true);
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

describe('원작 연출 타임라인', () => {
  // 60BPM, 1박 = 1초, 타일 i 시각 = i초 (곧은 길)
  function lv(actions: import('../src/core/types').Action[], decorations?: import('../src/core/types').Decoration[]) {
    const l = emptyLevel();
    l.settings.bpm = 60;
    l.settings.offset = 0;
    l.path = Array(12).fill(0);
    l.actions = actions;
    if (decorations) l.decorations = decorations;
    const v = validateLevel(l);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
    return new VisualTimeline(compileChart(l));
  }
  const player = { x: 500, y: 0 };

  it('카메라 기준: 타일로 옮겨 가며 섞고, 끝나면 그 타일 + 오프셋', async () => {
    const { cameraCenter } = await import('../src/core/timeline');
    const tl = lv([{ floor: 2, type: 'Camera', relativeTo: 'tile', tile: 8, offset: [0, 50], duration: 2 }]);
    tl.update(1);
    expect(cameraCenter(tl.camera, player)).toEqual({ x: 500, y: 0 });
    tl.update(3); // 절반
    const mid = cameraCenter(tl.camera, player);
    expect(mid.x).toBeCloseTo(650); // 500 → 800
    tl.update(10);
    expect(cameraCenter(tl.camera, player)).toEqual({ x: 800, y: 50 });
  });

  it('직전 위치 기준: 지금 카메라 자리에 고정하고 오프셋만 더함', async () => {
    const { cameraCenter } = await import('../src/core/timeline');
    const tl = lv([{ floor: 2, type: 'Camera', relativeTo: 'last', offset: [100, 0], duration: 0 }]);
    tl.resolveCenter = () => ({ x: 300, y: 40 });
    tl.update(5);
    expect(cameraCenter(tl.camera, player)).toEqual({ x: 400, y: 40 });
  });

  it('delay: 타일을 친 뒤 늦게 시작', () => {
    const tl = lv([{ floor: 2, type: 'Flash', color: '#ffffff', opacity: 1, duration: 1, delay: 0.5 }]);
    tl.update(2.25);
    expect(tl.flashAlpha).toBe(0);
    tl.update(2.5);
    expect(tl.flashAlpha).toBeCloseTo(1);
  });

  it('필터: 세기 보간, 끄면 사라짐, exclusive는 다른 필터 끔', () => {
    const tl = lv([
      { floor: 1, type: 'Filter', filter: 'Grayscale', enabled: true, intensity: 1, duration: 2 },
      { floor: 2, type: 'Filter', filter: 'Sepia', enabled: true, intensity: 0.5 },
      { floor: 5, type: 'Filter', filter: 'Grayscale', enabled: false },
      { floor: 7, type: 'Filter', filter: 'Invert', enabled: true, exclusive: true },
    ]);
    tl.update(2);
    expect(tl.filters.get('Grayscale')!.intensity).toBeCloseTo(0.5);
    expect(tl.filters.get('Sepia')!.intensity).toBeCloseTo(0.5);
    tl.update(6);
    expect(tl.filters.has('Grayscale')).toBe(false);
    tl.update(8);
    expect([...tl.filters.keys()]).toEqual(['Invert']);
  });

  it('흔들림: 기간 동안만, 되감아도 같은 값', () => {
    const tl = lv([{ floor: 2, type: 'Shake', duration: 2, strength: 1, fadeOut: true }]);
    tl.update(1);
    expect(tl.shakeX).toBe(0);
    tl.update(2.37);
    const a = [tl.shakeX, tl.shakeY];
    expect(Math.hypot(a[0], a[1])).toBeGreaterThan(0);
    tl.update(5);
    expect(tl.shakeX).toBe(0);
    tl.update(2.37);
    expect([tl.shakeX, tl.shakeY]).toEqual(a);
  });

  it('타일 등장·퇴장: 3박 전 페이드 인, 4박 뒤 사라짐', () => {
    const tl = lv([{ floor: 0, type: 'TrackAnim', appear: 'fade', beatsAhead: 3, disappear: 'shrink', beatsBehind: 4 }]);
    // 타일 8 (8초): 5초 전에는 안 보임, 5.2초에는 나타나는 중, 6초에는 다 보임, 12.5초 이후 사라짐
    expect(tl.tileAnimAt(8, 4.9)!.alpha).toBe(0);
    const a = tl.tileAnimAt(8, 5.15)!.alpha;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(tl.tileAnimAt(8, 6)!.alpha).toBe(1);
    expect(tl.tileAnimAt(8, 12.1)!.scale).toBeLessThan(1);
    expect(tl.tileAnimAt(8, 13)!.alpha).toBe(0);
  });

  it('장식 움직이기: 태그가 맞는 장식만, 원래 값에서 보간', () => {
    const tl = lv(
      [{ floor: 2, type: 'MoveDecorations', tag: 'a', offset: [100, 0], opacity: 0, duration: 2 }],
      [
        { image: 'x.png', tag: 'a b', floor: 1 },
        { image: 'y.png', tag: 'c', floor: 1, opacity: 0.5 },
      ],
    );
    tl.update(3);
    expect(tl.decos[0].ox).toBeCloseTo(50);
    expect(tl.decos[0].opacity).toBeCloseTo(0.5);
    expect(tl.decos[1].ox).toBe(0);
    expect(tl.decos[1].opacity).toBe(0.5);
  });
});

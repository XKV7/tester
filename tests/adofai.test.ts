import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { synthBeatTrack } from '../src/audio/beatTrack';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { TILE_LEN } from '../src/core/math';
import { adofaiColor, convertAdofai, parseLenientJson } from '../src/levels/adofai';
import { packageFromFiles } from '../src/levels/package';
import { VisualTimeline } from '../src/core/timeline';

function level(obj: Record<string, unknown>) {
  const text = JSON.stringify({ ...obj, settings: { bpm: 100, offset: 500, song: 'Song', artist: 'Artist', author: 'Maker', songFilename: 'song.ogg', ...((obj.settings as object) ?? {}) } });
  const r = convertAdofai(text);
  const v = validateLevel(r.level);
  expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
  return r;
}

describe('.adofai 변환', () => {
  it('느슨한 JSON: BOM, 끝 쉼표, 문자열 안 줄바꿈', () => {
    const t = '﻿{ "a": [1, 2, ], "b": { "c": "x\ny", }, "d": "끝, ]" , }';
    expect(parseLenientJson(t)).toEqual({ a: [1, 2], b: { c: 'x\ny' }, d: '끝, ]' });
  });

  it('색: 알파 제거, 잘못된 값은 null', () => {
    expect(adofaiColor('DEBB7B')).toBe('#debb7b');
    expect(adofaiColor('#ff000080')).toBe('#ff0000');
    expect(adofaiColor('nope')).toBeNull();
  });

  it('pathData 각도·박: 곧은 길 1박, 왼쪽 꺾기 ½박, 오른쪽 꺾기 1½박 (시계 방향)', () => {
    const r = level({ pathData: 'RRUR' });
    expect(r.level.path).toEqual([0, 0, 90, 0]);
    // 원작 offset(500ms) = 타일 1을 누르는 순간 → 타일 0은 한 박(0.6초) 앞
    expect(r.level.settings.offset).toBeCloseTo(0.5 - 0.6);
    const c = compileChart(r.level);
    expect(c.tiles.slice(0, 4).map((t) => t.beats)).toEqual([1, 1, 0.5, 1.5]);
    expect(c.times[1]).toBeCloseTo(0.5);
    expect(r.level.meta).toMatchObject({ title: 'Song', artist: 'Artist', author: '원작 맵: Maker' });
    expect(r.songFile).toBe('song.ogg');
  });

  it('상대 회전 글자(5): 이전 방향 + 72°', () => {
    const r = level({ pathData: 'R55' });
    expect(r.level.path).toEqual([0, 72, 144]);
  });

  it('미드스핀(999): 반대 방향 + Midspin, 같은 순간에 두 타일', () => {
    const r = level({ angleData: [0, 0, 999, 180, 180] });
    expect(r.level.path).toEqual([0, 0, 180, 180, 180]);
    expect(r.level.actions).toContainEqual({ floor: 2, type: 'Midspin' });
    const c = compileChart(r.level);
    expect(c.times[3]).toBeCloseTo(c.times[2]);
    // 미드스핀 뒤: 진입이 앞쪽(0°)이 되어 180°로 가는 데 1박
    expect(c.tiles[3].beats).toBeCloseTo(1);
  });

  it('이벤트: 속도·회전 반전·일시 공전·홀드·체크포인트·색·카메라', () => {
    const r = level({
      angleData: [0, 0, 0, 0, 0, 0, 0, 0],
      actions: [
        { floor: 1, eventType: 'SetSpeed', speedType: 'Bpm', beatsPerMinute: 200, bpmMultiplier: 1, angleOffset: 0 },
        { floor: 2, eventType: 'SetSpeed', speedType: 'Multiplier', beatsPerMinute: 100, bpmMultiplier: 0.5 },
        { floor: 3, eventType: 'Twirl' },
        { floor: 4, eventType: 'Pause', duration: 2, countdownTicks: 0 },
        { floor: 5, eventType: 'Hold', duration: 1, distanceMultiplier: 100 },
        { floor: 5, eventType: 'Checkpoint' },
        { floor: 6, eventType: 'RecolorTrack', startTile: [0, 'ThisTile'], endTile: [2, 'ThisTile'], trackColor: 'ff0000ff', duration: 1 },
        { floor: 2, eventType: 'MoveCamera', duration: 2, relativeTo: 'Player', position: [1, 2], rotation: 30, zoom: 200, ease: 'InOutCubic' },
        { floor: 3, eventType: 'EditorComment', comment: 'x' },
        { floor: 3, eventType: 'SetFilter' },
        { floor: 1, eventType: 'Twirl', active: false },
      ],
    });
    const byType = (t: string) => r.level.actions.filter((a) => a.type === t);
    expect(byType('SetSpeed')).toEqual([
      { floor: 1, type: 'SetSpeed', bpm: 200 },
      { floor: 2, type: 'SetSpeed', multiplier: 0.5 },
    ]);
    expect(byType('Twirl')).toEqual([{ floor: 3, type: 'Twirl' }]);
    expect(byType('Pause')).toEqual([{ floor: 4, type: 'Pause', beats: 2 }]);
    expect(byType('Hold')).toEqual([{ floor: 5, type: 'Hold', beats: 2 }]);
    expect(byType('Checkpoint')).toHaveLength(1);
    expect(byType('RecolorTrack').filter((a) => a.floor === 6)).toEqual([{ floor: 6, type: 'RecolorTrack', from: 6, to: 8, color: '#ff0000', duration: 1 }]);
    expect(byType('Camera')[0]).toMatchObject({ zoom: 0.5, rotation: 30, offset: [TILE_LEN, 2 * TILE_LEN], ease: 'inOutQuad', duration: 2 });
    expect(r.warnings.join(' ')).not.toContain('EditorComment'); // 편집기 전용 이벤트는 조용히 넘김
    const c = compileChart(r.level);
    expect(c.tiles[1].bpm).toBe(200);
    expect(c.tiles[2].bpm).toBe(100);
    expect(c.tiles[3].dir).toBe('CCW');
    expect(c.tiles[4].beats).toBeCloseTo(1 + 2);
  });

  it('PositionTrack: 해당 타일부터 뒤로 누적 이동', () => {
    const r = level({
      angleData: [0, 0, 0, 0, 0],
      actions: [
        { floor: 2, eventType: 'PositionTrack', positionOffset: [0, 1] },
        { floor: 4, eventType: 'PositionTrack', positionOffset: [1, 0] },
        { floor: 3, eventType: 'PositionTrack', positionOffset: [5, 5], editorOnly: 'Enabled' },
      ],
    });
    const mv = r.level.actions.filter((a) => a.type === 'MoveTrack');
    expect(mv).toEqual([
      { floor: 0, type: 'MoveTrack', from: 2, to: 3, offset: [0, TILE_LEN], duration: 0 },
      { floor: 0, type: 'MoveTrack', from: 4, to: 5, offset: [TILE_LEN, TILE_LEN], duration: 0 },
    ]);
  });

  it('배경: 색과 이미지 파일', () => {
    const r = level({ angleData: [0, 0], actions: [{ floor: 1, eventType: 'CustomBackground', color: '000000', bgImage: 'BG1.jpg' }] });
    expect(r.level.actions).toContainEqual({ floor: 1, type: 'Background', color: '#000000', image: 'BG1.jpg', fit: 'cover', opacity: 1 });
  });

  it('행성 3개처럼 박이 달라지는 이벤트는 경고', () => {
    const r = level({ angleData: [0, 0, 0], actions: [{ floor: 1, eventType: 'MultiPlanet', planets: 'ThreePlanets' }] });
    expect(r.warnings.join(' ')).toContain('행성 3개');
  });

  it('zip 패키지: .adofai + 음원 → 변환·음원 연결·가져옴 표시', () => {
    const files = new Map<string, Uint8Array>([
      ['map/backup_1.adofai', strToU8('{"angleData":[0],"settings":{"bpm":50}}')],
      ['map/main.adofai', strToU8(JSON.stringify({ angleData: [0, 0, 90], settings: { bpm: 150, songFilename: 'song.ogg', song: 'X' } }) + '\n')],
      ['map/song.ogg', new Uint8Array([1, 2, 3])],
    ]);
    const pkg = packageFromFiles(files, 'test');
    expect(pkg.imported).toBe('adofai');
    expect(pkg.level.settings.bpm).toBe(150);
    expect(pkg.level.path).toEqual([0, 0, 90]);
    expect(pkg.files.get('song.ogg')).toBeTruthy();
    expect(pkg.warnings.some((w) => w.includes('합성 비트'))).toBe(false);
  });

  it('zip 안에 .adofai가 여러 개면 가장 큰 본 레벨을 연다', () => {
    const files = new Map<string, Uint8Array>([
      ['a.adofai', strToU8('{"angleData":[0],"settings":{"bpm":2026}}')],
      ['Hello BPM 2026.adofai', strToU8(JSON.stringify({ angleData: Array(300).fill(0), settings: { bpm: 2026 } }))],
      ['backup_big.adofai', strToU8(JSON.stringify({ angleData: Array(900).fill(0), settings: { bpm: 1 } }))],
    ]);
    const pkg = packageFromFiles(files, 't');
    expect(pkg.level.path.length).toBe(300);
    expect(pkg.warnings.join(' ')).toContain('3개');
  });

  it('아주 긴 연출(1000박 넘게)도 그대로, 잘못된 값은 그 이벤트만 빼고 경고', () => {
    const r = level({
      angleData: Array(10).fill(0),
      actions: [
        { floor: 2, eventType: 'MoveCamera', duration: 5000, zoom: 100 },
        { floor: 2, eventType: 'Flash', duration: 2400, startColor: 'ffffff' },
        { floor: 3, eventType: 'RecolorTrack', startTile: [0, 'Start'], endTile: [0, 'End'], trackColor: 'ff00ff', duration: 1e12 },
      ],
    });
    expect(r.level.actions.find((a) => a.type === 'Camera')).toMatchObject({ duration: 5000 });
    expect(r.level.actions.find((a) => a.type === 'Flash')).toMatchObject({ duration: 2400 });
    expect(r.level.actions.find((a) => a.type === 'RecolorTrack' && a.floor === 3)).toMatchObject({ duration: 10_000_000 });
  });

  it('깨진 파일은 알아볼 수 있는 오류', () => {
    expect(() => convertAdofai('{ not json')).toThrow('.adofai');
    expect(() => convertAdofai('{"settings":{}}')).toThrow('타일');
  });
});

describe('원작 연출 옮기기', () => {
  const conv = (actions: unknown[], extra: Record<string, unknown> = {}) => {
    const r = convertAdofai(JSON.stringify({ angleData: Array(20).fill(0), settings: { bpm: 120, offset: 0 }, actions, ...extra }));
    const v = validateLevel(r.level);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
    return r;
  };

  it('카메라 기준(Tile·Global·LastPosition)과 angleOffset → delay', () => {
    const r = conv([
      { floor: 3, eventType: 'MoveCamera', relativeTo: 'Tile', position: [1, 0], duration: 1, angleOffset: 90 },
      { floor: 4, eventType: 'MoveCamera', relativeTo: 'Global', duration: 0 },
      { floor: 5, eventType: 'MoveCamera', relativeTo: 'LastPosition', position: [0, 2], duration: 1 },
    ]);
    const cams = r.level.actions.filter((a) => a.type === 'Camera');
    expect(cams[0]).toMatchObject({ relativeTo: 'tile', tile: 3, offset: [TILE_LEN, 0], delay: 0.5 });
    expect(cams[1]).toMatchObject({ relativeTo: 'global' });
    expect(cams[2]).toMatchObject({ relativeTo: 'last', offset: [0, 2 * TILE_LEN] });
    // delay는 시각에 반영 (120BPM, 0.5박 = 0.25초)
    const c = compileChart(r.level);
    const ev = c.visual.find((v) => v.action === cams[0])!;
    expect(ev.time).toBeCloseTo(c.tiles[3].time + 0.25);
  });

  it('필터·빛 번짐·흔들림·타일 등장', () => {
    const r = conv([
      { floor: 1, eventType: 'SetFilter', filter: 'Aberration', enabled: 'Enabled', intensity: 50, disableOthers: 'Disabled' },
      { floor: 2, eventType: 'SetFilter', filter: 'Weird3D', enabled: 'Enabled', intensity: 100 },
      { floor: 1, eventType: 'Bloom', enabled: 'Enabled', threshold: 20, intensity: 120, color: '85dbfc' },
      { floor: 3, eventType: 'ShakeScreen', duration: 4, strength: 110, intensity: 100, fadeOut: 'Enabled' },
      { floor: 1, eventType: 'AnimateTrack', trackAnimation: 'Fade', beatsAhead: 3, trackDisappearAnimation: 'Scatter_Far', beatsBehind: 4 },
    ]);
    const by = (t: string) => r.level.actions.filter((a) => a.type === t);
    expect(by('Filter')[0]).toMatchObject({ filter: 'Aberration', enabled: true, intensity: 0.5 });
    expect(by('Bloom')[0]).toMatchObject({ enabled: true, intensity: 1.2, threshold: 0.2, color: '#85dbfc' });
    expect(by('Shake')[0]).toMatchObject({ duration: 4, strength: 1.1, fadeOut: true });
    expect(by('TrackAnim')[0]).toMatchObject({ appear: 'fade', beatsAhead: 3, disappear: 'scatter', beatsBehind: 4 });
    expect(r.warnings.join(' ')).toContain('필터 Weird3D');
  });

  it('장식과 장식 움직이기', () => {
    const r = conv(
      [{ floor: 4, eventType: 'MoveDecorations', tag: 'M1', positionOffset: [0, 20], rotationOffset: 45, scale: [200, 50], opacity: 50, duration: 2 }],
      {
        decorations: [
          { floor: 2, eventType: 'AddDecoration', decorationImage: 'star.png', position: [1, 2], relativeTo: 'Tile', scale: [50, 50], depth: 5, parallax: [100, 100], tag: 'M1 other', opacity: 80 },
          { floor: 0, eventType: 'AddText', decText: '안녕', position: [0, 0], relativeTo: 'Camera' },
        ],
      },
    );
    expect(r.level.decorations).toEqual([
      { relativeTo: 'tile', floor: 2, position: [TILE_LEN, 2 * TILE_LEN], image: 'star.png', tag: 'M1 other', scale: [0.5, 0.5], opacity: 0.8, depth: 5, parallax: [1, 1] },
      { relativeTo: 'camera', floor: 0, position: [0, 0], text: '안녕', fontSize: 40, depth: -1 },
    ]);
    expect(r.level.actions.find((a) => a.type === 'MoveDecorations')).toMatchObject({ tag: 'M1', offset: [0, 20 * TILE_LEN], rotation: 45, scale: [2, 0.5], opacity: 0.5, duration: 2 });
  });
});

describe('원작 설정의 시작 상태와 트랙 모양', () => {
  it('설정의 시작 카메라·트랙 모양·배경·타일 애니메이션, ColorTrack은 구간별로 처음부터', () => {
    const r = convertAdofai(
      JSON.stringify({
        angleData: Array(30).fill(0),
        settings: {
          bpm: 120, offset: 0, trackColor: '85dbfc', secondaryTrackColor: '3467a8', trackColorType: 'Glow', trackColorAnimDuration: 2,
          trackColorPulse: 'Forward', trackPulseLength: 10, trackStyle: 'Neon', trackAnimation: 'None', beatsAhead: 3,
          trackDisappearAnimation: 'Fade', beatsBehind: 1, bgImage: 'BG1.jpg', bgImageColor: 'ffffff', bgDisplayMode: 'FitToScreen',
          relativeTo: 'Tile', position: [-1, 2.5], rotation: 0, zoom: 130,
        },
        actions: [{ floor: 11, eventType: 'ColorTrack', trackColor: 'ff0000', trackStyle: 'Standard', trackColorType: 'Single' }],
      }),
    );
    const v = validateLevel(r.level);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
    const at0 = r.level.actions.filter((a) => a.floor === 0);
    expect(at0).toContainEqual({ floor: 0, type: 'RecolorTrack', from: 0, to: 10, color: '#85dbfc', style: 'neon', color2: '#3467a8', glowDuration: 2, pulseLength: 10, duration: 0 });
    expect(at0).toContainEqual({ floor: 0, type: 'RecolorTrack', from: 11, to: 30, color: '#ff0000', style: 'standard', duration: 0 });
    expect(at0.find((a) => a.type === 'Camera')).toMatchObject({ relativeTo: 'tile', tile: 0, offset: [-TILE_LEN, 2.5 * TILE_LEN], zoom: 100 / 130, duration: 0 });
    expect(at0.find((a) => a.type === 'TrackAnim')).toMatchObject({ appear: 'none', disappear: 'fade', beatsBehind: 1 });
    expect(at0.find((a) => a.type === 'Background')).toMatchObject({ image: 'BG1.jpg', fit: 'cover', opacity: 1 });
    // 시작 상태는 카운트다운 전부터 (시각 -∞ 취급)
    const c = compileChart(r.level);
    expect(c.visual.filter((v2) => v2.action.floor === 0).every((v2) => v2.time < -1e8)).toBe(true);
  });
});

describe('극단적인 BPM (Hello (BPM) 류)', () => {
  it('BPM 수백만·배율 수천·긴 일시 공전도 그대로 옮기고 검증 통과', () => {
    const r = convertAdofai(
      JSON.stringify({
        angleData: Array(40).fill(0),
        settings: { bpm: 150, offset: 0 },
        actions: [
          { floor: 5, eventType: 'SetSpeed', speedType: 'Bpm', beatsPerMinute: 2_026_000 },
          { floor: 10, eventType: 'SetSpeed', speedType: 'Multiplier', bpmMultiplier: 5000 },
          { floor: 12, eventType: 'Pause', duration: 500 },
        ],
      }),
    );
    const v = validateLevel(r.level);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
    const c = compileChart(r.level);
    expect(c.tiles[5].bpm).toBe(2_026_000);
    expect(c.tiles[10].bpm).toBe(2_026_000 * 5000);
    expect(c.tiles[12].beats).toBeCloseTo(501);
    expect(r.warnings.join(' ')).not.toContain('범위 밖');
    // 음원이 없을 때 합성 비트도 금방 만든다 (소리 간격 60ms 이상으로 솎음)
    const t0 = Date.now();
    const pcm = synthBeatTrack(c, 8000);
    expect(pcm.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('배경 동영상 설정', () => {
    const r = level({ pathData: 'RRRR', settings: { bgVideo: 'movie.mp4', vidOffset: 1500, loopVideo: 'Enabled' } });
    const bg = r.level.actions.find((a) => a.type === 'Background');
    expect(bg).toMatchObject({ video: 'movie.mp4', videoOffset: 1.5, videoLoop: true });
  });
  it('RepeatEvents: 박 간격·타일 간격으로 태그 이벤트 반복', () => {
    const r = level({
      pathData: 'R'.repeat(20),
      actions: [
        { floor: 2, eventType: 'RepeatEvents', repeatType: 'Beat', repetitions: 2, interval: 0.5, tag: 'a' },
        { floor: 2, eventType: 'Flash', duration: 1, startColor: 'ffffff', startOpacity: 100, endOpacity: 0, eventTag: 'a b', angleOffset: 0 },
        { floor: 2, eventType: 'Flash', duration: 1, startColor: 'ff0000', startOpacity: 100, endOpacity: 0, eventTag: 'x' },
        { floor: 3, eventType: 'RepeatEvents', repeatType: 'Floor', repetitions: 3, floorCount: 5, executeOnCurrentFloor: true, tag: 'c' },
        { floor: 3, eventType: 'Flash', duration: 1, startColor: '00ff00', startOpacity: 100, eventTag: 'c' },
      ],
    });
    const fl = r.level.actions.filter((a) => a.type === 'Flash');
    const white = fl.filter((a) => a.type === 'Flash' && a.color === '#ffffff').map((a) => a.delay ?? 0).sort();
    expect(white).toEqual([0, 0.5, 1]);
    expect(fl.filter((a) => a.type === 'Flash' && a.color === '#ff0000')).toHaveLength(1);
    expect(fl.filter((a) => a.type === 'Flash' && a.color === '#00ff00').map((a) => a.floor).sort((x, y) => x - y)).toEqual([3, 8, 13, 18]);
    expect(r.warnings.join()).not.toContain('RepeatEvents');
  });
  it('확장 필터(SetFilterAdvanced)를 비슷한 필터로', () => {
    const r = level({
      pathData: 'RRRRRR',
      actions: [
        { floor: 1, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_TV_WideScreenHorizontal', enabled: true, duration: 0, filterProperties: '"filter_Size": 72, "filter_Smooth": 1' },
        { floor: 1, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_Colors_Brightness', enabled: true, duration: 2, filterProperties: '"filter__Brightness": 80' },
        { floor: 2, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_Glow_Glow_Color', enabled: true, filterProperties: '"filter_Threshold": 25, "filter_Intensity": 50, "filter_GlowColor": "ff3600"' },
        { floor: 2, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_AAA_SuperHexagon', enabled: true, filterProperties: '' },
      ],
    });
    const f = r.level.actions.filter((a) => a.type === 'Filter');
    expect(f.find((a) => a.type === 'Filter' && a.filter === 'LetterboxH')).toMatchObject({ enabled: true, intensity: expect.closeTo(0.28, 5) });
    expect(f.find((a) => a.type === 'Filter' && a.filter === 'Brightness')).toMatchObject({ intensity: 0.8, duration: 2 });
    expect(r.level.actions.find((a) => a.type === 'Bloom')).toMatchObject({ enabled: true, threshold: 0.25, color: '#ff3600' });
    expect(r.warnings.join()).toContain('SuperHexagon');
  });
  it('입자·도형·글자 바꾸기·행성·화면·소리 이벤트', () => {
    const r = level({
      pathData: 'R'.repeat(12),
      settings: { hitsound: 'Hat', hitsoundVolume: 50 },
      actions: [
        { floor: 1, eventType: 'AddParticle', tag: 'p1', decorationImage: 'dot.png', position: [1, 2], relativeTo: 'Tile', emissionRate: [5, 10], particleLifetime: [1, 2], particleSize: [50, 100], velocity: [[0, 1], [1, 2]], scale: [200, 100], shapeType: 'Rectangle', autoPlay: false, playDuration: 2, loop: false, maxParticles: 300, simulationSpeed: 200,
          colorOverLifetime: { mode: 'Gradient', gradient1: { colorKeys: [{ time: 0, color: 'FF0000' }, { time: 1, color: '0000FF' }], alphaKeys: [{ time: 0, alpha: 0 }, { time: 1, alpha: 1 }] } } },
        { floor: 1, eventType: 'AddObject', objectType: 'Planet', tag: 'o1', planetColor: 'ff000080', position: [0, 0], relativeTo: 'Tile', scale: [300, 300] },
        { floor: 1, eventType: 'AddText', tag: 't1', decText: 'hi', position: [0, 0], relativeTo: 'Tile' },
        { floor: 2, eventType: 'SetParticle', tag: 'p1', targetMode: 'Start', duration: 0 },
        { floor: 3, eventType: 'EmitParticle', tag: 'p1', count: 20 },
        { floor: 3, eventType: 'SetObject', tag: 'o1', planetColor: '00ff00ff', duration: 2 },
        { floor: 3, eventType: 'SetText', tag: 't1', decText: 'bye' },
        { floor: 4, eventType: 'ScalePlanets', scale: 50, duration: 1, targetPlanet: 'All' },
        { floor: 4, eventType: 'ScaleRadius', scale: 150 },
        { floor: 5, eventType: 'HallOfMirrors', enabled: true },
        { floor: 5, eventType: 'ScreenTile', tile: [2, -1], duration: 0 },
        { floor: 5, eventType: 'SetFrameRate', enabled: true, frameRate: 8 },
        { floor: 6, eventType: 'SetHitsound', gameSound: 'Hitsound', hitsound: 'Kick', hitsoundVolume: 100 },
        { floor: 6, eventType: 'PlaySound', hitsound: 'Clap', hitsoundVolume: 80, angleOffset: 90 },
        { floor: 7, eventType: 'Bookmark' },
      ],
    });
    const decos = r.level.decorations!;
    const p = decos.find((d) => d.tag === 'p1')!;
    expect(p.particle).toMatchObject({ rate: [5, 10], lifetime: [1, 2], size: [0.5, 1], colors: ['#ff0000', '#0000ff'], duration: 2, max: 300, speed: 2 });
    expect(p.particle!.area![0]).toBeCloseTo(2 * TILE_LEN);
    const o = decos.find((d) => d.tag === 'o1')!;
    expect(o).toMatchObject({ shape: 'planet', color: '#ff0000', scale: [3, 3] });
    expect(o.opacity).toBeCloseTo(128 / 255, 2);
    const acts = r.level.actions;
    const md = acts.filter((a) => a.type === 'MoveDecorations');
    expect(md).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'p1', particle: 'start' }),
        expect.objectContaining({ tag: 'p1', emit: 20 }),
        expect.objectContaining({ tag: 'o1', color: '#00ff00', opacity: 1, duration: 2 }),
        expect.objectContaining({ tag: 't1', text: 'bye' }),
      ]),
    );
    expect(acts.filter((a) => a.type === 'Planets')).toEqual([
      expect.objectContaining({ size: 0.5, duration: 1 }),
      expect.objectContaining({ radius: 1.5 }),
    ]);
    expect(acts.filter((a) => a.type === 'Screen')).toEqual(
      expect.arrayContaining([expect.objectContaining({ mirrors: true }), expect.objectContaining({ tile: [2, -1] }), expect.objectContaining({ fps: 8 })]),
    );
    const snd = acts.filter((a) => a.type === 'Sound');
    expect(snd).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ floor: 0, hitsound: 'Hat', hitVolume: 0.5 }),
        expect.objectContaining({ floor: 6, hitsound: 'Kick', hitVolume: 1 }),
        expect.objectContaining({ floor: 6, play: 'Clap', volume: 0.8, delay: 0.5 }),
      ]),
    );
    expect(r.warnings.join()).not.toMatch(/AddParticle|AddObject|HallOfMirrors|ScreenTile|SetHitsound|PlaySound|Bookmark|ScalePlanets/);
  });
  it('장식: 카메라 따라가기·색 투명도·이어 붙이기·섞기, 이동의 빈 축은 그대로·크기는 절대값', () => {
    const r = level({
      pathData: 'RRRRRR',
      decorations: [
        { floor: 3, eventType: 'AddDecoration', decorationImage: 'a.png', tag: 'd', position: [1, 0], relativeTo: 'Tile', scale: [400, 400], color: 'ff000080', opacity: 0, parallax: [100, 100], parallaxOffset: [0, 10], tile: [10, 1], blendMode: 'LinearDodge', lockRotation: true, lockScale: true },
      ],
      actions: [{ floor: 1, eventType: 'MoveDecorations', tag: 'd', duration: 1, positionOffset: [30, null], parallaxOffset: [null, 5], scale: [200, null], opacity: 100, color: 'ffffff40' }],
    });
    const d = r.level.decorations![0];
    expect(d).toMatchObject({ parallax: [1, 1], parallaxOffset: [0, 10 * TILE_LEN], tile: [10, 1], blend: 'add', lockRotation: true, lockScale: true, scale: [4, 4], opacity: 0 });
    expect(d.alpha).toBeCloseTo(128 / 255, 2);
    const m = r.level.actions.find((a) => a.type === 'MoveDecorations')!;
    expect(m).toMatchObject({ offset: [30 * TILE_LEN, null], parallaxOffset: [null, 5 * TILE_LEN], scale: [2, null], opacity: 1, color: '#ffffff' });
    expect((m as { alpha: number }).alpha).toBeCloseTo(64 / 255, 2);
  });

  it('장식 가리기·섞기·픽셀, gapLength, justThisTile', () => {
    const r = level({
      pathData: 'RRRRRRRRRR',
      actions: [
        { floor: 1, eventType: 'RecolorTrack', startTile: [0, 'ThisTile'], endTile: [6, 'ThisTile'], gapLength: 1, trackColor: 'ff0000' },
        { floor: 1, eventType: 'MoveTrack', startTile: [0, 'ThisTile'], endTile: [4, 'ThisTile'], gapLength: 2, positionOffset: [0, 1], duration: 0 },
        { floor: 3, eventType: 'ColorTrack', trackColor: '00ff00', justThisTile: true },
        { floor: 2, eventType: 'MoveDecorations', tag: 'm', maskingType: 'VisibleOutsideMask', depth: 3, duration: 0 },
      ],
      decorations: [
        { floor: 1, eventType: 'AddDecoration', decorationImage: 'm.png', tag: 'm', maskingType: 'Mask', imageSmoothing: false, blendMode: 'Overlay' },
        { floor: 1, eventType: 'AddDecoration', decorationImage: 'i.png', maskingType: 'VisibleInsideMask', blendMode: 'Difference' },
      ],
    });
    const d = r.level.decorations!;
    expect(d[0]).toMatchObject({ mask: 'mask', smooth: false, blend: 'overlay' });
    expect(d[1]).toMatchObject({ mask: 'inside', blend: 'difference' });
    const rc = r.level.actions.find((a) => a.type === 'RecolorTrack' && a.color === '#ff0000');
    expect(rc).toMatchObject({ from: 1, to: 7, gap: 1 });
    expect(r.level.actions.find((a) => a.type === 'MoveTrack')).toMatchObject({ gap: 2 });
    expect(r.level.actions.find((a) => a.type === 'RecolorTrack' && a.color === '#00ff00')).toMatchObject({ from: 3, to: 3 });
    expect(r.level.actions.find((a) => a.type === 'MoveDecorations')).toMatchObject({ mask: 'outside', depth: 3 });
    // 타임라인: 건너뛰며 적용
    const ch = compileChart(r.level);
    const tl = new VisualTimeline(ch);
    tl.update(0);
    // 처음: 3번 타일만 초록
    expect([2, 3, 4].map((i) => tl.tileColor[i] === 0x00ff00)).toEqual([false, true, false]);
    tl.update(100);
    const red = 0xff0000;
    expect([1, 2, 3, 4, 5, 7].map((i) => tl.tileColor[i] === red)).toEqual([true, false, true, false, true, true]);
    expect(tl.tileOffY[1]).not.toBe(0);
    expect(tl.tileOffY[2]).toBe(0);
    expect(tl.tileOffY[4]).not.toBe(0);
    expect(tl.decos[0].mask).toBe('outside');
    expect(tl.decos[0].depth).toBe(3);
  });

  it('입자 세부: 원·호, 처음 회전, 크기 변화, 칸 나누기, 월드 공간 / 없는 필터 끄기는 조용히', () => {
    const r = level({
      pathData: 'RRRR',
      actions: [
        { floor: 1, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_AAA_SuperComputer', enabled: false },
        { floor: 1, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_Colors_Adjust_FullColors', enabled: true, filterProperties: '"filter_Red_R": 10000, "filter_Green_G": 5000, "filter_Blue_B": 5000' },
        { floor: 2, eventType: 'SetFilterAdvanced', filter: 'CameraFilterPack_Distortion_BlackHole', enabled: true, filterProperties: '"filter_PositionX": 54, "filter_PositionY": 52, "filter_Size": 14, "filter_Distortion": 15922' },
      ],
      decorations: [
        { floor: 1, eventType: 'AddParticle', decorationImage: 'p.png', tag: 'p', shapeType: 'Circle', shapeRadius: 1, arc: 180, startRotation: [0, 360], sizeOverLifetime: [100, 10], randomTextureTiling: [2, 2], simulationSpace: 'World' },
      ],
    });
    expect(r.level.decorations![0].particle).toMatchObject({ circle: true, arc: 180, rot0: [0, 360], sizeLife: [1, 0.1], sheet: [2, 2], world: true });
    expect(r.warnings.join(' ')).not.toContain('SuperComputer');
    const f = (n: string) => r.level.actions.find((a) => a.type === 'Filter' && a.filter === n) as { intensity?: number } | undefined;
    expect(f('ChanG')?.intensity).toBeCloseTo(0.5);
    expect(f('HoleX')?.intensity).toBeCloseTo(0.54);
    expect(f('Hole')?.intensity).toBeGreaterThan(0);
  });
});

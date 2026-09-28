import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { TILE_LEN } from '../src/core/math';
import { adofaiColor, convertAdofai, parseLenientJson } from '../src/levels/adofai';
import { packageFromFiles } from '../src/levels/package';

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
    expect(r.level.settings.offset).toBeCloseTo(0.5);
    const c = compileChart(r.level);
    expect(c.tiles.slice(0, 4).map((t) => t.beats)).toEqual([1, 1, 0.5, 1.5]);
    expect(c.times[1]).toBeCloseTo(0.5 + 0.6);
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
        { floor: 3, eventType: 'AddDecoration' },
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
    expect(byType('RecolorTrack')).toEqual([{ floor: 6, type: 'RecolorTrack', from: 6, to: 8, color: '#ff0000', duration: 1 }]);
    expect(byType('Camera')[0]).toMatchObject({ zoom: 0.5, rotation: 30, offset: [TILE_LEN, 2 * TILE_LEN], ease: 'inOutQuad', duration: 2 });
    expect(r.warnings.join(' ')).toContain('AddDecoration 1개');
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

  it('깨진 파일은 알아볼 수 있는 오류', () => {
    expect(() => convertAdofai('{ not json')).toThrow('.adofai');
    expect(() => convertAdofai('{"settings":{}}')).toThrow('타일');
  });
});

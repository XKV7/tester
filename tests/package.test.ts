import { strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { synthBeatTrack } from '../src/audio/beatTrack';
import { compileChart } from '../src/core/chart';
import { emptyLevel, serializeLevel } from '../src/core/level';
import { exportZip, packageFromFiles, PackageError } from '../src/levels/package';
import { demoLevels } from '../src/levels/demos';

describe('레벨 패키지', () => {
  it('zip 내보내기 → 불러오기 왕복', () => {
    const lv = emptyLevel();
    lv.meta.title = '왕복';
    lv.settings.songFile = 'song.mp3';
    const files = new Map([['song.mp3', new Uint8Array([1, 2, 3])]]);
    const zip = exportZip({ id: 'x', level: lv, files, builtin: false, warnings: [] });
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(['level.orbit.json', 'song.mp3']);
    const pkg = packageFromFiles(new Map(Object.entries(entries)));
    expect(pkg.level.meta.title).toBe('왕복');
    expect(pkg.warnings).toEqual([]);
  });
  it('하위 폴더 안의 레벨도 찾음', () => {
    const pkg = packageFromFiles(new Map([['myLevel/level.orbit.json', strToU8(serializeLevel(emptyLevel()))]]));
    expect(pkg.level.path.length).toBeGreaterThan(0);
  });
  it('음원 누락은 경고', () => {
    const lv = emptyLevel();
    lv.settings.songFile = 'missing.ogg';
    const pkg = packageFromFiles(new Map([['a.orbit.json', strToU8(serializeLevel(lv))]]));
    expect(pkg.warnings.join()).toMatch(/missing.ogg/);
  });
  it('레벨 파일 없음 / 잘못된 레벨은 오류', () => {
    expect(() => packageFromFiles(new Map([['song.mp3', new Uint8Array(1)]]))).toThrow(PackageError);
    expect(() => packageFromFiles(new Map([['level.orbit.json', strToU8('{"path": 3}')]]))).toThrow(PackageError);
  });
});

describe('합성 비트 트랙', () => {
  it('각 hitTime에 킥이 있다', () => {
    const d = demoLevels()[0].level;
    const chart = compileChart(d);
    const sr = 8000;
    const s = synthBeatTrack(chart, sr);
    expect(s.length).toBeGreaterThan(chart.lastTime * sr);
    const energy = (t: number, w = 0.02) => {
      let e = 0;
      for (let i = Math.floor(t * sr); i < Math.floor((t + w) * sr); i++) e += s[i] * s[i];
      return e;
    };
    for (const t of chart.times.slice(0, 10)) expect(energy(t)).toBeGreaterThan(energy(t - 0.05, 0.02) * 0.5);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.96);
  });
});

import { strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { synthBeatTrack } from '../src/audio/beatTrack';
import { compileChart } from '../src/core/chart';
import { emptyLevel, serializeLevel } from '../src/core/level';
import { addLooseFiles, exportZip, findFile, findSong, hasLevelFile, packageFromFiles, PackageError, refreshedAdofai, zipNameCandidates } from '../src/levels/package';
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

describe('파일 이름 찾기', () => {
  // UTF-8 표시 없는 zip의 이름은 fflate가 latin1로 읽는다 → 그 모양을 흉내
  const asLatin1 = (bytes: number[]) => String.fromCharCode(...bytes);

  it('깨진 한국어(EUC-KR)·일본어(Shift_JIS) 이름 복원', () => {
    // '음악' (EUC-KR: C0 BD BE C7)
    expect(zipNameCandidates(asLatin1([0xc0, 0xbd, 0xbe, 0xc7, 0x2e, 0x6f, 0x67, 0x67]))).toContain('음악.ogg');
    // 'テスト' (Shift_JIS: 83 65 83 58 83 67)
    expect(zipNameCandidates(asLatin1([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x2e, 0x70, 0x6e, 0x67]))).toContain('テスト.png');
    expect(zipNameCandidates('plain.ogg')).toEqual(['plain.ogg']);
  });

  it('레벨이 가리키는 이름으로 zip 속 깨진 이름의 파일을 찾는다', () => {
    const song = new Uint8Array([1, 2, 3]);
    const adofai = JSON.stringify({ pathData: 'RRRR', settings: { bpm: 120, offset: 0, songFilename: '음악.ogg' }, actions: [] });
    const files = new Map<string, Uint8Array>([
      ['lv/main.adofai', strToU8(adofai)],
      ['lv/' + asLatin1([0xc0, 0xbd, 0xbe, 0xc7, 0x2e, 0x6f, 0x67, 0x67]), song],
    ]);
    const pkg = packageFromFiles(files);
    expect(findSong(pkg.files, '음악.ogg')).toBe(song);
    expect(pkg.warnings.some((w) => w.includes('합성 비트'))).toBe(false);
  });

  it('맥 NFD 이름·대소문자·경로·확장자 차이, 음원이 하나뿐이면 그것', () => {
    const d = new Uint8Array([9]);
    const files = new Map([['음악.MP3'.normalize('NFD'), d]]);
    expect(findFile(files, 'songs\\음악.mp3')).toBe(d);
    expect(findFile(files, '음악.ogg')).toBe(d);
    expect(findFile(files, '음악.png')).toBeUndefined();
    expect(findSong(files, 'other.ogg')).toBe(d);
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

  it('그림만 고르면 지금 패키지에 더한다 (폴더 경로는 떼고)', () => {
    const pkg = packageFromFiles(new Map([['level.orbit.json', strToU8(serializeLevel(emptyLevel()))]]));
    const imgs = new Map([
      ['Zip/', new Uint8Array()],
      ['Zip/a.png', new Uint8Array([1])],
      ['__MACOSX/Zip/._a.png', new Uint8Array([2])],
    ]);
    expect(hasLevelFile(imgs)).toBe(false);
    expect(hasLevelFile(new Map([['x/main.adofai', new Uint8Array()]]))).toBe(true);
    addLooseFiles(pkg, imgs);
    expect(findFile(pkg.files, 'a.png')).toEqual(new Uint8Array([1]));
    expect([...pkg.files.keys()].some((k) => k.includes('/'))).toBe(false);
  });

  it('예전 변환 레벨 + 원작 파일이 든 zip은 원작으로 다시 변환한다 (고친 레벨은 그대로)', () => {
    const adofai = JSON.stringify({
      pathData: 'RRRR',
      settings: { bpm: 120, songFilename: 's.ogg', offset: 0 },
      actions: [{ floor: 1, eventType: 'AddDecoration', decorationImage: 'a.png', position: [0, 0], relativeTo: 'Tile' }],
    });
    const files = new Map([['main.adofai', strToU8(adofai)]]);
    const fresh = packageFromFiles(new Map(files));
    expect(fresh.level.decorations?.length).toBe(1);
    // 예전 변환: 타일은 같고 장식이 없다
    const old = { ...fresh.level, decorations: [] };
    const zip = new Map([...files, ['level.orbit.json', strToU8(serializeLevel(old))]]);
    const pkg = packageFromFiles(zip);
    expect(pkg.imported).toBe('adofai');
    expect(pkg.level.decorations?.length).toBe(1);
    expect(pkg.warnings[0]).toContain('다시 변환');
    // 사용자가 이벤트를 더한 레벨은 건드리지 않는다
    const edited = { ...fresh.level, actions: [...fresh.level.actions, { floor: 2, type: 'Camera' as const, zoom: 2 }] };
    expect(refreshedAdofai(files, edited, 'x')).toBeNull();
  });
});

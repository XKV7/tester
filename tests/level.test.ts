import { describe, expect, it } from 'vitest';
import { emptyLevel, parseLevelJson, validateLevel } from '../src/core/level';
import { demoLevels } from '../src/levels/demos';

const good = () => JSON.parse(JSON.stringify(emptyLevel()));

describe('레벨 JSON 검증', () => {
  it('정상 레벨 통과', () => {
    const r = validateLevel(good());
    expect(r.ok).toBe(true);
  });
  it('명세 예시 통과', () => {
    const r = validateLevel({
      version: 1,
      meta: { title: '곡 제목', artist: '아티스트', author: '레벨 제작자', difficulty: 5, previewStart: 30.0 },
      settings: {
        songFile: 'song.mp3', bpm: 120, offset: 0.45, pitch: 1.0, volume: 0.8, countdownTicks: 4,
        trackColor: '#3a3f55', bgColor: '#0e0f16', startDirection: 'CW',
      },
      path: [0, 0, 0, 90, 90, 0, -90, 0],
      actions: [
        { floor: 3, type: 'Twirl' },
        { floor: 5, type: 'SetSpeed', multiplier: 2 },
        { floor: 6, type: 'Checkpoint' },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it('데모 레벨은 모두 유효', () => {
    for (const d of demoLevels()) {
      const r = validateLevel(d.level);
      expect(r.ok, d.id + ': ' + (r.ok ? '' : r.errors.join(', '))).toBe(true);
    }
  });
  it('JSON 구문 오류', () => {
    const r = parseLevelJson('{ nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/JSON 구문 오류/);
  });
  it('최상위가 객체가 아님', () => {
    expect(validateLevel([]).ok).toBe(false);
    expect(validateLevel(null).ok).toBe(false);
  });
  it('settings 누락', () => {
    const l = good();
    delete l.settings;
    const r = validateLevel(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/settings/);
  });
  it('bpm 잘못됨', () => {
    const l = good();
    l.settings.bpm = -5;
    const r = validateLevel(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/bpm/);
  });
  it('path 비어 있음 / 숫자 아님', () => {
    const a = good();
    a.path = [];
    expect(validateLevel(a).ok).toBe(false);
    const b = good();
    b.path = [0, 'x', 90];
    const r = validateLevel(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/path\[1\]/);
  });
  it('알 수 없는 이벤트 / floor 범위 밖', () => {
    const a = good();
    a.actions = [{ floor: 1, type: 'Explode' }];
    expect(validateLevel(a).ok).toBe(false);
    const b = good();
    b.actions = [{ floor: 99, type: 'Twirl' }];
    const r = validateLevel(b);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/floor/);
  });
  it('이벤트 파라미터 오류', () => {
    const a = good();
    a.actions = [{ floor: 1, type: 'SetSpeed' }];
    expect(validateLevel(a).ok).toBe(false);
    const b = good();
    b.actions = [{ floor: 1, type: 'Camera', ease: 'bounce' }];
    expect(validateLevel(b).ok).toBe(false);
    const c = good();
    c.actions = [{ floor: 1, type: 'RecolorTrack', from: 3, to: 1, color: '#fff' }];
    expect(validateLevel(c).ok).toBe(false);
    const d = good();
    d.settings.trackColor = 'red';
    expect(validateLevel(d).ok).toBe(false);
  });
  it('Midspin은 반대 방향 path가 필요', () => {
    const a = good();
    a.path = [0, 90, 0, 0];
    a.actions = [{ floor: 2, type: 'Midspin' }];
    expect(validateLevel(a).ok).toBe(false);
    a.path = [0, 90, 270, 0];
    expect(validateLevel(a).ok).toBe(true);
  });
  it('기본값 채우기', () => {
    const r = validateLevel({ settings: { bpm: 100 }, path: [0] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.level.settings.pitch).toBe(1);
      expect(r.level.meta.title).toBeTruthy();
      expect(r.level.actions).toEqual([]);
    }
  });
});

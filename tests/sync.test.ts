import { describe, expect, it } from 'vitest';
import { allBests, applyRemoteSettings, mergeBests, settings, submitBest } from '../src/game/settings';

describe('설정·기록 동기화 병합', () => {
  it('기록은 레벨마다 높은 쪽', () => {
    submitBest('a', 90);
    submitBest('b', 70);
    expect(mergeBests({ a: 80, b: 95, c: 50, bad: Number.NaN })).toBe(true);
    expect(allBests()).toMatchObject({ a: 90, b: 95, c: 50 });
    expect(allBests().bad).toBeUndefined();
    expect(mergeBests({ a: 10 })).toBe(false);
  });

  it('받은 설정은 알려진 키·같은 타입만 적용', () => {
    applyRemoteSettings({ musicVolume: 0.3, difficulty: 'strict', inputOffset: 'x', hacked: true }, 123);
    applyRemoteSettings({ difficulty: 'godmode', sfxVolume: Number.NaN }, 124);
    expect(settings.musicVolume).toBe(0.3);
    expect(settings.difficulty).toBe('strict');
    expect(settings.inputOffset).toBe(0);
    expect((settings as unknown as Record<string, unknown>).hacked).toBeUndefined();
  });
});

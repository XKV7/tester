import { describe, expect, it } from 'vitest';
import { encodeMp3, resample } from '../src/audio/mp3';

const tone = (sec: number, sr: number, f = 440) => {
  const a = new Float32Array(Math.floor(sec * sr));
  for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
  return a;
};

/** mp3 프레임 동기 비트(11비트 1) 찾기. */
const hasFrameSync = (b: Uint8Array) => {
  for (let i = 0; i < Math.min(b.length - 1, 4096); i++) if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) return true;
  return false;
};

describe('mp3 인코딩', () => {
  it('모노 3초 128kbps: 올바른 크기와 프레임', async () => {
    let last = 0;
    const out = await encodeMp3([tone(3, 44100)], 44100, { onProgress: (r) => (last = r), yieldEvery: 20 });
    expect(hasFrameSync(out)).toBe(true);
    const expected = (128000 / 8) * 3;
    expect(out.length).toBeGreaterThan(expected * 0.85);
    expect(out.length).toBeLessThan(expected * 1.15);
    expect(last).toBe(1);
  });
  it('스테레오 48kHz 192kbps', async () => {
    const out = await encodeMp3([tone(2, 48000), tone(2, 48000, 660)], 48000);
    expect(hasFrameSync(out)).toBe(true);
    expect(out.length).toBeGreaterThan((192000 / 8) * 2 * 0.85);
  });
  it('지원하지 않는 샘플레이트(96kHz)는 48kHz로 리샘플', async () => {
    const out = await encodeMp3([tone(1, 96000)], 96000);
    expect(hasFrameSync(out)).toBe(true);
    expect(resample(new Float32Array(96000), 96000, 48000).length).toBe(48000);
  });
  it('빈 입력은 오류', async () => {
    await expect(encodeMp3([], 44100)).rejects.toThrow();
  });
});

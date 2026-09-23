import { describe, expect, it } from 'vitest';
import { beatTime, composeSong, encodeWav, MOODS, renderSong, songFill, songHits } from '../src/audio/songgen';
import { levelFromHits } from '../src/core/autochart';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { TILE_LEN } from '../src/core/math';
import { estimateTempo } from '../src/core/tempo';

const SR = 8000;

describe('음악 자동 생성', () => {
  it('같은 seed면 같은 곡, 다른 seed면 다른 멜로디', () => {
    const a = composeSong({ mood: 'upbeat', seconds: 40, seed: 7 });
    const b = composeSong({ mood: 'upbeat', seconds: 40, seed: 7 });
    const c = composeSong({ mood: 'upbeat', seconds: 40, seed: 8 });
    expect(a.events).toEqual(b.events);
    const mel = (s: typeof a) => s.events.filter((e) => e.inst === 'lead').map((e) => `${e.beat}:${e.midi}`).join();
    expect(mel(a)).not.toEqual(mel(c));
  });

  it('길이와 구성', () => {
    const s = composeSong({ mood: 'calm', seconds: 60 });
    const secs = (s.bars * 4 * 60) / s.bpm;
    expect(secs).toBeGreaterThan(50);
    expect(secs).toBeLessThan(75);
    expect(s.sections[0].name).toBe('intro');
    expect(s.sections[s.sections.length - 1].name).toBe('outro');
    expect(s.sections.some((x) => x.name === 'A')).toBe(true);
  });

  for (const m of MOODS) {
    it(`${m.label}: 합성 → 박이 들리고, 레벨이 음표 위치에 맞는다`, () => {
      const song = composeSong({ mood: m.value, seconds: 40, seed: 3 });
      // 멜로디는 음계 안
      const scale = m.value === 'upbeat' || m.value === 'calm' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
      const root = { upbeat: 60, calm: 65, fast: 57, dark: 62 }[m.value];
      for (const e of song.events.filter((x) => x.inst === 'lead')) expect(scale).toContain((((e.midi! - root) % 12) + 12) % 12);

      const pcm = renderSong(song, SR);
      let peak = 0;
      let energy = 0;
      for (const v of pcm) {
        peak = Math.max(peak, Math.abs(v));
        energy += v * v;
      }
      expect(peak).toBeLessThanOrEqual(0.91);
      expect(energy / pcm.length).toBeGreaterThan(1e-4);

      const est = estimateTempo(pcm, SR);
      expect(est).not.toBeNull();
      const ratio = est!.bpm / song.bpm;
      // 템포 추정이 정확하거나 정확히 절반/두 배
      expect([0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.01)).toBe(true);

      for (const d of ['easy', 'normal', 'hard'] as const) {
        const first = beatTime(song, song.levelStartBeat);
        const r = levelFromHits(songHits(song, d), song.bpm, first, { songFile: 'x.wav', fill: songFill(song) });
        expect(r, d).not.toBeNull();
        expect(validateLevel(r!.level).ok).toBe(true);
        const c = compileChart(r!.level);
        // 모든 타격 시각이 실제 음표(킥·스네어·멜로디·베이스) 또는 채움 1박 격자 위
        const noteTimes = new Set(song.events.map((e) => Math.round(beatTime(song, e.beat) * 1000)));
        const onNotes = c.times.slice(1, -1).filter((t) => noteTimes.has(Math.round(t * 1000)) || noteTimes.has(Math.round(t * 1000) + 1) || noteTimes.has(Math.round(t * 1000) - 1)).length;
        expect(onNotes / (c.times.length - 2), d).toBeGreaterThan(0.9);
        const fastest = Math.min(...c.tiles.slice(0, -1).map((t) => t.duration));
        expect(fastest).toBeGreaterThanOrEqual(0.2 - 1e-6);
        let bad = 0;
        for (let i = 0; i < c.tiles.length; i++)
          for (let j = i + 3; j < c.tiles.length; j++)
            if (Math.hypot(c.tiles[i].x - c.tiles[j].x, c.tiles[i].y - c.tiles[j].y) < TILE_LEN * 0.6) bad++;
        expect(bad, d).toBeLessThanOrEqual(Math.ceil(c.tiles.length * 0.02));
      }
    });
  }

  it('난이도가 높을수록 타일이 많다', () => {
    const song = composeSong({ mood: 'upbeat', seconds: 60, seed: 5 });
    const first = beatTime(song, song.levelStartBeat);
    const n = (d: 'easy' | 'normal' | 'hard') => levelFromHits(songHits(song, d), song.bpm, first)!.tiles;
    expect(n('easy')).toBeLessThan(n('normal'));
    expect(n('normal')).toBeLessThanOrEqual(n('hard'));
  });

  it('WAV 인코딩', () => {
    const w = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 8000);
    expect(w.length).toBe(44 + 8);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.slice(8, 12))).toBe('WAVE');
  });
});

describe('생성 곡 + 세밀한 난이도', () => {
  it('매우 어려움·극한도 유효한 레벨, 최소 간격 유지', async () => {
    const { DIFF_CFG } = await import('../src/core/autochart');
    for (const m of MOODS) {
      const song = composeSong({ mood: m.value, seconds: 40, seed: 11 });
      const first = beatTime(song, song.levelStartBeat);
      for (const d of ['expert', 'master'] as const) {
        const cfg = DIFF_CFG[d];
        const r = levelFromHits(songHits(song, d), song.bpm, first, { fill: songFill(song), minBeats: cfg.minBeats, minGapSec: cfg.minGapSec });
        expect(r, `${m.value}/${d}`).not.toBeNull();
        expect(validateLevel(r!.level).ok).toBe(true);
        const c = compileChart(r!.level);
        expect(Math.min(...c.tiles.slice(0, -1).map((t) => t.duration))).toBeGreaterThanOrEqual(cfg.minGapSec - 1e-6);
        const hard = levelFromHits(songHits(song, 'hard'), song.bpm, first, { fill: songFill(song) })!;
        expect(r!.tiles).toBeGreaterThanOrEqual(hard.tiles);
      }
    }
  });
});

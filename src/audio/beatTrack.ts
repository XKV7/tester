import type { Chart } from '../core/chart';

/**
 * 레벨 hitTime과 박 그리드에 맞춘 합성 비트 트랙 (킥·하이햇·베이스).
 * 순수 함수 — 샘플 배열만 만든다. AudioBuffer 변환은 호출 측에서.
 */
export function synthBeatTrack(chart: Chart, sampleRate = 44100): Float32Array {
  const tiles = chart.tiles;
  const last = tiles[tiles.length - 1];
  const outroBeats = 4;
  const endTime = last.time + (outroBeats * 60) / last.bpm + 1;
  const len = Math.max(1, Math.ceil(endTime * sampleRate));
  const out = new Float32Array(len);

  // 박 그리드 (반 박 단위)
  const grid: { t: number; beat: number }[] = [];
  for (const tile of tiles) {
    const b0 = tile.beatPos;
    const b1 = tile.floor === last.floor ? b0 + outroBeats : b0 + tile.beats;
    for (let k = Math.ceil(b0 * 2 - 1e-9); k < b1 * 2 - 1e-9; k++) {
      const b = k / 2;
      grid.push({ t: tile.time + ((b - b0) * 60) / tile.bpm, beat: b });
    }
  }

  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };

  const kick = (t: number, amp: number) => {
    const s0 = Math.floor(t * sampleRate);
    const n = Math.floor(0.28 * sampleRate);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const idx = s0 + i;
      if (idx < 0 || idx >= len) continue;
      const tt = i / sampleRate;
      const f = 45 + 110 * Math.exp(-tt * 28);
      phase += (2 * Math.PI * f) / sampleRate;
      const env = Math.exp(-tt * 9) * Math.min(1, i / 40);
      out[idx] += Math.sin(phase) * env * amp + (i < 60 ? rand() * 0.3 * amp * (1 - i / 60) : 0);
    }
  };
  const hat = (t: number, amp: number) => {
    const s0 = Math.floor(t * sampleRate);
    const n = Math.floor(0.05 * sampleRate);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const idx = s0 + i;
      if (idx < 0 || idx >= len) continue;
      const w = rand();
      const hp = w - prev; // 간단한 고역 통과
      prev = w;
      out[idx] += hp * Math.exp((-i / sampleRate) * 90) * amp;
    }
  };
  const bass = (t: number, dur: number, freq: number, amp: number) => {
    const s0 = Math.floor(t * sampleRate);
    const n = Math.floor(dur * sampleRate);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const idx = s0 + i;
      if (idx < 0 || idx >= len) continue;
      const tt = i / sampleRate;
      const saw = 2 * ((tt * freq) % 1) - 1;
      lp += (saw - lp) * 0.08;
      const env = Math.min(1, i / 200) * Math.exp(-tt * 3) * (i > n - 300 ? (n - i) / 300 : 1);
      out[idx] += lp * env * amp;
    }
  };

  const roots = [55, 55, 65.41, 49];
  for (const g of grid) {
    const isBeat = Math.abs(g.beat - Math.round(g.beat)) < 1e-6;
    hat(g.t, isBeat ? 0.12 : 0.2);
    if (isBeat) {
      const bar = Math.floor(g.beat / 4);
      const spb = 60 / (tiles.find((x) => x.time <= g.t + 1e-9 && x.time + x.duration > g.t)?.bpm ?? last.bpm);
      bass(g.t, Math.min(0.45, spb * 0.9), roots[((bar % 4) + 4) % 4], 0.22);
    }
  }
  for (let i = 0; i < tiles.length; i++) {
    if (i > 0 && tiles[i].time === tiles[i - 1].time) continue; // midspin 중복
    kick(tiles[i].time, i === tiles.length - 1 ? 1 : 0.8);
  }

  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0.95 ? 0.95 / peak : 1;
  if (k !== 1) for (let i = 0; i < len; i++) out[i] *= k;
  return out;
}

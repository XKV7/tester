/**
 * 음원에서 BPM과 첫 박 위치(offset)를 추정한다. 순수 함수.
 *
 * 1. 10ms 단위 로그 에너지 증가량(onset strength)을 구하고 이동 평균을 빼 정규화.
 * 2. BPM 후보마다 박 그리드(위상 포함)에 onset이 얼마나 모이는지 점수화.
 * 3. 120BPM 근처를 약하게 선호해 절반/두 배 오류를 줄이고, 최고 후보를 세밀하게 다듬는다.
 */
export interface TempoEstimate {
  bpm: number;
  /** 첫 박 시각 (초, 0 ≤ offset < 한 박). */
  offset: number;
  /** 0~1, 높을수록 박이 뚜렷함. */
  confidence: number;
}

const HOP = 0.01;

export function onsetEnvelope(samples: Float32Array, sampleRate: number, maxSeconds = 90): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * HOP));
  const n = Math.min(samples.length, Math.floor(maxSeconds * sampleRate));
  const frames = Math.floor(n / hop);
  const logE = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const a = f * hop;
    const b = Math.min(n, a + hop * 2);
    for (let i = a; i < b; i++) e += samples[i] * samples[i];
    logE[f] = Math.log(1e-9 + e / (b - a));
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) flux[f] = Math.max(0, logE[f] - logE[f - 1]);
  // 이동 평균(±0.25초) 빼기
  const w = 25;
  const out = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < Math.min(frames, w); f++) sum += flux[f];
  for (let f = 0; f < frames; f++) {
    const add = f + w;
    const rem = f - w - 1;
    if (add < frames) sum += flux[add];
    if (rem >= 0) sum -= flux[rem];
    const cnt = Math.min(frames, f + w + 1) - Math.max(0, f - w);
    out[f] = Math.max(0, flux[f] - sum / cnt);
  }
  return out;
}

function sampleAt(o: Float32Array, t: number, wide = true): number {
  const x = t / HOP;
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= o.length) return 0;
  const k = x - i;
  const v = o[i] * (1 - k) + o[i + 1] * k;
  if (!wide) return v;
  // 근처 값(±1 프레임)도 일부 인정해 박자 흔들림 허용
  return Math.max(v, o[Math.max(0, i - 1)] * 0.8, o[Math.min(o.length - 1, i + 2)] * 0.8);
}

/** 프레임 f의 에너지 증가는 창의 새로 들어온 구간 [f+1, f+2)×HOP에서 생긴다. */
const FRAME_LAG = 1.5 * HOP;

function gridScore(o: Float32Array, bpm: number): { score: number; phase: number } {
  const period = 60 / bpm;
  const dur = o.length * HOP;
  const beats = Math.floor(dur / period) - 1;
  if (beats < 4) return { score: 0, phase: 0 };
  let best = -1;
  let bestPhase = 0;
  for (let ph = 0; ph < period; ph += HOP) {
    let s = 0;
    for (let k = 0; k < beats; k++) s += sampleAt(o, ph + k * period);
    if (s > best) {
      best = s;
      bestPhase = ph;
    }
  }
  return { score: best / beats, phase: bestPhase };
}

export function estimateTempo(samples: Float32Array, sampleRate: number, lo = 60, hi = 200): TempoEstimate | null {
  const o = onsetEnvelope(samples, sampleRate);
  if (o.length < 400) return null; // 4초 미만
  let mean = 0;
  for (const v of o) mean += v;
  mean /= o.length;
  if (mean <= 1e-6) return null;

  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.2) ** 2);
  let bestBpm = 0;
  let bestVal = -1;
  for (let bpm = lo; bpm <= hi; bpm += 0.5) {
    const v = gridScore(o, bpm).score * prior(bpm);
    if (v > bestVal) {
      bestVal = v;
      bestBpm = bpm;
    }
  }
  // 세밀화 ±0.6 BPM, 0.02 단위
  let fine = bestBpm;
  let fineVal = -1;
  let phase = 0;
  for (let bpm = bestBpm - 0.6; bpm <= bestBpm + 0.6; bpm += 0.02) {
    const g = gridScore(o, bpm);
    if (g.score > fineVal) {
      fineVal = g.score;
      fine = bpm;
      phase = g.phase;
    }
  }
  const bpm = Math.round(fine * 100) / 100;
  const period = 60 / bpm;
  // 위상 세밀화: ±15ms를 1ms 단위로
  const beats = Math.floor((o.length * HOP) / period) - 1;
  let bestPh = phase;
  let bestS = -1;
  for (let ph = phase - 0.015; ph <= phase + 0.015; ph += 0.001) {
    let sc = 0;
    for (let k = 0; k < beats; k++) sc += sampleAt(o, ph + k * period, false);
    if (sc > bestS) {
      bestS = sc;
      bestPh = ph;
    }
  }
  const off = bestPh + FRAME_LAG;
  return {
    bpm,
    offset: ((off % period) + period) % period,
    confidence: Math.max(0, Math.min(1, fineVal / (mean * 6))),
  };
}

/** 탭 템포: 탭 시각(초) → BPM. 탭이 4개 미만이면 null. */
export function tapTempo(taps: number[]): number | null {
  if (taps.length < 4) return null;
  const iv: number[] = [];
  for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
  iv.sort((a, b) => a - b);
  const trim = iv.slice(Math.floor(iv.length * 0.2), Math.ceil(iv.length * 0.8)) as number[];
  const m = (trim.length ? trim : iv).reduce((a, b) => a + b, 0) / (trim.length || iv.length);
  return m > 0 ? Math.round((60 / m) * 10) / 10 : null;
}

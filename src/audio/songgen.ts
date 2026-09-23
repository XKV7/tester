/**
 * 음악 자동 생성: 작곡(음표 목록) + 합성(샘플). 순수 함수 — DOM·Web Audio 의존 없음.
 * 곡의 모든 음표 위치를 알고 있으므로 레벨은 음표에서 바로 만든다 (분석 불필요, 박자 정확).
 */
import type { AutoDifficulty } from '../core/autochart';

export type Mood = 'upbeat' | 'calm' | 'fast' | 'dark';

export const MOODS: { value: Mood; label: string; hint: string; bpm: number }[] = [
  { value: 'upbeat', label: '신나는', hint: '밝은 장조, 4박 킥', bpm: 124 },
  { value: 'calm', label: '잔잔한', hint: '부드러운 패드와 멜로디', bpm: 88 },
  { value: 'fast', label: '빠른', hint: '단조, 몰아치는 8분 베이스', bpm: 150 },
  { value: 'dark', label: '어두운', hint: '단조, 하프타임 드럼', bpm: 104 },
];

export interface SongOptions {
  mood: Mood;
  bpm?: number;
  /** 대략 길이(초). */
  seconds?: number;
  seed?: number;
}

export type Inst = 'kick' | 'snare' | 'hat' | 'bass' | 'lead' | 'pad';

export interface NoteEvent {
  /** 곡 시작 기준 박. */
  beat: number;
  inst: Inst;
  midi?: number;
  /** 길이(박). */
  dur?: number;
  vel: number;
}

export interface Section {
  name: 'intro' | 'A' | 'B' | 'C' | 'outro';
  bar: number;
  bars: number;
}

export interface Song {
  mood: Mood;
  bpm: number;
  seed: number;
  /** 곡 박 0의 시각(초). */
  lead: number;
  bars: number;
  sections: Section[];
  events: NoteEvent[];
  /** 레벨 타일 0이 놓일 박 (인트로 뒤). */
  levelStartBeat: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

interface MoodSpec {
  root: number;
  scale: number[];
  prog: number[][];
  kick: number[];
  kickB: number[];
  snare: number[];
  hats: number[];
  bass: number[];
  /** 멜로디 리듬 후보 (한 마디, [박, 길이]). */
  rhythms: [number, number][][];
  leadWave: 'square' | 'triangle' | 'saw';
  padLevel: number;
}

const SPEC: Record<Mood, MoodSpec> = {
  upbeat: {
    root: 60,
    scale: MAJOR,
    prog: [[0, 4, 5, 3], [5, 3, 0, 4]],
    kick: [0, 1, 2, 3],
    kickB: [0, 1, 2, 3, 3.5],
    snare: [1, 3],
    hats: [0.5, 1.5, 2.5, 3.5],
    bass: [0.5, 1.5, 2.5, 3.5],
    rhythms: [
      [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1]],
      [[0, 0.5], [0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1]],
      [[0, 1.5], [1.5, 0.5], [2, 0.5], [2.5, 1.5]],
      [[0, 0.5], [1, 0.5], [1.5, 1], [3, 0.5], [3.5, 0.5]],
    ],
    leadWave: 'square',
    padLevel: 0.5,
  },
  calm: {
    root: 65,
    scale: MAJOR,
    prog: [[0, 5, 3, 4], [3, 4, 2, 5]],
    kick: [0, 2.5],
    kickB: [0, 1.5, 2.5],
    snare: [2],
    hats: [0, 1, 2, 3],
    bass: [0, 2],
    rhythms: [
      [[0, 2], [2, 1], [3, 1]],
      [[0, 1.5], [1.5, 0.5], [2, 2]],
      [[0, 1], [1, 1], [2, 2]],
      [[0.5, 1.5], [2, 1], [3, 1]],
    ],
    leadWave: 'triangle',
    padLevel: 1,
  },
  fast: {
    root: 57,
    scale: MINOR,
    prog: [[0, 5, 2, 6], [0, 3, 5, 4]],
    kick: [0, 1.5, 2, 3],
    kickB: [0, 0.5, 1.5, 2, 3, 3.5],
    snare: [1, 3],
    hats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    bass: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    rhythms: [
      [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1]],
      [[0, 1], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 1]],
      [[0, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]],
    ],
    leadWave: 'saw',
    padLevel: 0.35,
  },
  dark: {
    root: 62,
    scale: MINOR,
    prog: [[0, 3, 5, 4], [0, 5, 3, 6]],
    kick: [0, 2.5],
    kickB: [0, 0.75 + 0.75, 2.5, 3.5],
    snare: [2],
    hats: [0.5, 1.5, 2.5, 3.5],
    bass: [0, 1.5, 2.5],
    rhythms: [
      [[0, 1.5], [1.5, 0.5], [2, 2]],
      [[0, 1], [1, 0.5], [1.5, 1.5], [3, 1]],
      [[0, 0.5], [0.5, 1.5], [2.5, 1.5]],
    ],
    leadWave: 'square',
    padLevel: 0.8,
  },
};

function chordNotes(spec: MoodSpec, degree: number, base: number): number[] {
  const sc = spec.scale;
  const at = (d: number) => base + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  return [at(degree), at(degree + 2), at(degree + 4)];
}

/** 작곡. 같은 옵션·seed면 항상 같은 곡. */
export function composeSong(opts: SongOptions): Song {
  const spec = SPEC[opts.mood];
  const moodBpm = MOODS.find((m) => m.value === opts.mood)!.bpm;
  const bpm = Math.max(60, Math.min(200, Math.round(opts.bpm ?? moodBpm)));
  const seed = opts.seed ?? 1;
  const rand = rng(seed * 9973 + bpm);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  const seconds = Math.max(20, Math.min(300, opts.seconds ?? 60));
  const totalBars = Math.max(10, Math.round((seconds * bpm) / 60 / 4));

  // 구성: intro 2 | (A B A C ...) 8마디씩 | outro 2
  const sections: Section[] = [{ name: 'intro', bar: 0, bars: 2 }];
  const bodyOrder: Section['name'][] = ['A', 'B', 'A', 'C', 'B', 'A', 'B', 'C'];
  let bar = 2;
  let k = 0;
  while (bar < totalBars - 2) {
    const len = Math.min(8, totalBars - 2 - bar);
    sections.push({ name: bodyOrder[k % bodyOrder.length], bar, bars: len });
    bar += len;
    k++;
  }
  sections.push({ name: 'outro', bar, bars: 2 });
  const bars = bar + 2;

  const events: NoteEvent[] = [];
  const bassBase = spec.root - 24;
  const padBase = spec.root - 12;
  // 섹션별 멜로디 모티프 (A는 같은 모티프를 재사용해 반복감)
  const motifs = new Map<string, [number, number][][]>();
  const motif = (name: string) => {
    let m = motifs.get(name);
    if (!m) {
      m = [pick(spec.rhythms), pick(spec.rhythms)];
      motifs.set(name, m);
    }
    return m;
  };
  let pitchDeg = 7; // 음계 도수 (0 = 근음, 7 = 한 옥타브 위)

  for (const sec of sections) {
    const prog = sec.name === 'B' ? spec.prog[1] : spec.prog[0];
    const mot = motif(sec.name);
    for (let i = 0; i < sec.bars; i++) {
      const b = sec.bar + i;
      const t0 = b * 4;
      const deg = prog[i % prog.length];
      const chord = chordNotes(spec, deg, padBase);
      const last = i === sec.bars - 1;
      const drums = sec.name !== 'intro' && sec.name !== 'outro' && sec.name !== 'C';
      // 드럼
      if (drums) {
        for (const x of sec.name === 'B' ? spec.kickB : spec.kick) events.push({ beat: t0 + x, inst: 'kick', vel: 1 });
        for (const x of spec.snare) events.push({ beat: t0 + x, inst: 'snare', vel: 0.9 });
        if (last && sec.bars >= 4) for (const x of [3.5]) events.push({ beat: t0 + x, inst: 'snare', vel: 0.7 });
      } else if (sec.name === 'C' || sec.name === 'outro') {
        events.push({ beat: t0, inst: 'kick', vel: 0.8 });
        if (sec.name === 'C') events.push({ beat: t0 + 2, inst: 'snare', vel: 0.5 });
      }
      for (const x of spec.hats) events.push({ beat: t0 + x, inst: 'hat', vel: drums ? (x % 1 === 0 ? 0.6 : 1) : 0.5 });
      // 베이스
      if (sec.name !== 'intro') {
        const pat = sec.name === 'C' ? [0, 2] : spec.bass;
        pat.forEach((x, j) => {
          const next = j + 1 < pat.length ? pat[j + 1] : 4;
          events.push({ beat: t0 + x, inst: 'bass', midi: bassBase + spec.scale[deg % 7], dur: Math.min(1, next - x) * 0.9, vel: 0.9 });
        });
      }
      // 패드 (한 마디)
      for (const m of chord) events.push({ beat: t0, inst: 'pad', midi: m, dur: 4, vel: spec.padLevel * (sec.name === 'C' || sec.name === 'intro' ? 1.2 : 0.8) });
      // 멜로디
      if (sec.name === 'A' || sec.name === 'B' || sec.name === 'C') {
        const rhythm = last ? [[0, 2] as [number, number], [2, 2] as [number, number]] : mot[i % 2];
        const chordDegs = [deg, deg + 2, deg + 4];
        for (const [x, d] of rhythm) {
          const strong = x % 1 === 0;
          if (strong) {
            // 코드 구성음 중 가까운 것 (한 옥타브 위 영역)
            let best = pitchDeg;
            let bd = Infinity;
            for (const c of chordDegs)
              for (const o of [0, 7, 14]) {
                const cand = c + o;
                const dd = Math.abs(cand - pitchDeg) + (cand < 4 || cand > 13 ? 5 : 0);
                if (dd < bd) {
                  bd = dd;
                  best = cand;
                }
              }
            pitchDeg = best;
          } else {
            pitchDeg += pick([-2, -1, -1, 1, 1, 2]);
            pitchDeg = Math.max(4, Math.min(13, pitchDeg));
          }
          if (last && x === 2) pitchDeg = deg + 7; // 마무리: 근음
          const midi = spec.root + spec.scale[((pitchDeg % 7) + 7) % 7] + 12 * Math.floor(pitchDeg / 7) - 12;
          events.push({ beat: t0 + x, inst: 'lead', midi, dur: d * 0.9, vel: sec.name === 'C' ? 0.7 : 1 });
        }
      }
    }
  }
  events.sort((a, b) => a.beat - b.beat);
  return { mood: opts.mood, bpm, seed, lead: 0.5, bars, sections, events, levelStartBeat: 8 };
}

/** 난이도별 타격 위치 (레벨 타일 0 기준 박). */
export function songHits(song: Song, difficulty: AutoDifficulty): number[] {
  const use: Record<AutoDifficulty, Inst[]> = {
    easy: ['kick', 'snare'],
    normal: ['kick', 'snare', 'lead'],
    hard: ['kick', 'snare', 'lead', 'bass'],
  };
  const set = new Set(use[difficulty]);
  const end = song.bars * 4 - 4; // 아웃트로 마지막 마디 제외
  const beats = new Set<number>();
  for (const e of song.events) {
    if (!set.has(e.inst)) continue;
    const b = e.beat - song.levelStartBeat;
    if (b <= 0 || e.beat >= end) continue;
    // 쉬움은 박·반박까지만
    const q = Math.round(b * 2) / 2;
    if (Math.abs(q - b) > 1e-6) continue;
    beats.add(q);
  }
  return [...beats].sort((a, b) => a - b);
}

/** 빈 곳 채움 후보: 모든 악기의 음표 위치 (레벨 타일 0 기준 박, 반박 격자). */
export function songFill(song: Song): number[] {
  const out = new Set<number>();
  for (const e of song.events) {
    const b = e.beat - song.levelStartBeat;
    if (b <= 0 || e.inst === 'pad') continue;
    if (Math.abs(Math.round(b * 2) / 2 - b) < 1e-6) out.add(b);
  }
  return [...out].sort((a, b) => a - b);
}

/** 곡 시각(초)에서의 박. */
export function beatTime(song: Song, beat: number): number {
  return song.lead + (beat * 60) / song.bpm;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** 합성 (모노). */
export function renderSong(song: Song, sampleRate = 44100): Float32Array {
  const spec = SPEC[song.mood];
  const spb = 60 / song.bpm;
  const len = Math.ceil((beatTime(song, song.bars * 4) + 2) * sampleRate);
  const out = new Float32Array(len);
  const rand = rng(song.seed * 31 + 7);
  const noise = () => rand() * 2 - 1;

  const add = (start: number, n: number, f: (i: number, t: number) => number) => {
    const s0 = Math.floor(start * sampleRate);
    for (let i = 0; i < n; i++) {
      const idx = s0 + i;
      if (idx < 0 || idx >= len) continue;
      out[idx] += f(i, i / sampleRate);
    }
  };

  for (const e of song.events) {
    const t = beatTime(song, e.beat);
    const v = e.vel;
    switch (e.inst) {
      case 'kick': {
        let ph = 0;
        add(t, Math.floor(0.3 * sampleRate), (_, tt) => {
          ph += (2 * Math.PI * (45 + 110 * Math.exp(-tt * 30))) / sampleRate;
          return Math.sin(ph) * Math.exp(-tt * 9) * 0.9 * v;
        });
        break;
      }
      case 'snare': {
        let lp = 0;
        let ph = 0;
        add(t, Math.floor(0.2 * sampleRate), (_, tt) => {
          const nz = noise();
          lp += (nz - lp) * 0.5;
          ph += (2 * Math.PI * 185) / sampleRate;
          return ((nz - lp) * 0.9 * Math.exp(-tt * 18) + Math.sin(ph) * 0.5 * Math.exp(-tt * 30)) * 0.42 * v;
        });
        break;
      }
      case 'hat': {
        let prev = 0;
        add(t, Math.floor(0.05 * sampleRate), (_, tt) => {
          const nz = noise();
          const hp = nz - prev;
          prev = nz;
          return hp * Math.exp(-tt * 85) * 0.1 * v;
        });
        break;
      }
      case 'bass': {
        const f = mtof(e.midi!);
        const dur = (e.dur ?? 0.5) * spb;
        let lp = 0;
        add(t, Math.floor((dur + 0.03) * sampleRate), (_, tt) => {
          const saw = 2 * ((tt * f) % 1) - 1;
          lp += (saw - lp) * 0.09;
          const env = Math.min(1, tt / 0.005) * (tt > dur ? Math.max(0, 1 - (tt - dur) / 0.03) : 1) * (0.7 + 0.3 * Math.exp(-tt * 6));
          return lp * env * 0.32 * v;
        });
        break;
      }
      case 'lead': {
        const f = mtof(e.midi!);
        const dur = (e.dur ?? 0.5) * spb;
        const voice = (delay: number, gain: number) => {
          let lp = 0;
          add(t + delay, Math.floor((dur + 0.12) * sampleRate), (_, tt) => {
            const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt / 0.25);
            const p = (tt * f * vib) % 1;
            const w = spec.leadWave === 'square' ? (p < 0.5 ? 1 : -1) * 0.6 : spec.leadWave === 'saw' ? 2 * p - 1 : 1 - 4 * Math.abs(p - 0.5);
            lp += (w - lp) * (spec.leadWave === 'triangle' ? 0.6 : 0.25);
            const a = Math.min(1, tt / 0.01);
            const rel = tt > dur ? Math.max(0, 1 - (tt - dur) / 0.12) : 1;
            return lp * a * rel * (0.75 + 0.25 * Math.exp(-tt * 4)) * 0.16 * v * gain;
          });
        };
        voice(0, 1);
        voice(spb * 0.75, 0.3); // 에코
        break;
      }
      case 'pad': {
        const f = mtof(e.midi!);
        const dur = (e.dur ?? 4) * spb;
        for (const det of [-0.004, 0, 0.005]) {
          let lp = 0;
          add(t, Math.floor((dur + 0.3) * sampleRate), (_, tt) => {
            const saw = 2 * ((tt * f * (1 + det)) % 1) - 1;
            lp += (saw - lp) * 0.02;
            const env = Math.min(1, tt / 0.35) * (tt > dur ? Math.max(0, 1 - (tt - dur) / 0.3) : 1);
            return lp * env * 0.05 * v;
          });
        }
        break;
      }
    }
  }
  // 소프트 클리핑 + 정규화
  let peak = 0;
  for (let i = 0; i < len; i++) {
    out[i] = Math.tanh(out[i] * 1.2);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let i = 0; i < len; i++) out[i] *= k;
  }
  return out;
}

/** 16비트 모노 WAV 인코딩 (패키지 저장용). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return new Uint8Array(buf);
}

import { describe, expect, it } from 'vitest';
import { autoChartFull, chooseMults, pickTempo, quantizeBeat, restsToPauses, scanTempo } from '../src/core/autochart';
import { compileChart } from '../src/core/chart';
import { validateLevel } from '../src/core/level';
import { detectOnsets, fft } from '../src/core/onset';
import { TILE_LEN } from '../src/core/math';

const SR = 44100;

/** 킥·스네어·하이햇·멜로디 톤을 지정 시각에 (페이드아웃 포함). */
function synth(events: { t: number; k: 'kick' | 'snare' | 'hat' | 'tone' }[], len: number) {
  const out = new Float32Array(Math.ceil(len * SR));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  for (const e of events) {
    const s0 = Math.round(e.t * SR);
    let ph = 0;
    let prev = 0;
    const n = Math.floor((e.k === 'hat' ? 0.04 : 0.16) * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      if (e.k === 'kick') {
        ph += (2 * Math.PI * (50 + 120 * Math.exp(-t * 30))) / SR;
        v = Math.sin(ph) * Math.exp(-t * 12) * 0.8;
      } else if (e.k === 'snare') v = rnd() * Math.exp(-t * 25) * 0.4;
      else if (e.k === 'hat') {
        const r = rnd();
        v = (r - prev) * Math.exp(-t * 90) * 0.25;
        prev = r;
      } else {
        ph += (2 * Math.PI * 740) / SR;
        v = Math.sin(ph) * Math.min(1, t / 0.002) * Math.exp(-t * 14) * 0.3;
      }
      const fade = Math.min(1, (n - i) / (0.02 * SR));
      if (s0 + i < out.length) out[s0 + i] += v * fade;
    }
  }
  return out;
}

describe('FFT', () => {
  it('사인파 한 개 → 해당 bin', () => {
    const n = 64;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    const mag = [...re].map((r, i) => Math.hypot(r, im[i]));
    expect(mag.indexOf(Math.max(...mag.slice(0, n / 2)))).toBe(5);
    expect(mag[5]).toBeCloseTo(n / 2, 3);
  });
});

describe('박 맞추기', () => {
  it('가장 단순한 단위 우선', () => {
    expect(quantizeBeat(1.01, 0.03)).toBe(1);
    expect(quantizeBeat(1.26, 0.03)).toBe(1.25);
    expect(quantizeBeat(1.335, 0.03)).toBeCloseTo(4 / 3);
    expect(quantizeBeat(1.125, 0.01)).toBe(1.125);
    expect(quantizeBeat(1.125, 0.01, 4)).not.toBe(1.125);
  });
  it('템포 후보 교정: 1/3로 잘못 잡힌 템포를 되돌린다', () => {
    const bpm = 180;
    const beat = 60 / bpm;
    const times: number[] = [];
    for (let r = 0; r < 16; r++) for (const b of [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.25, 3, 3.5]) times.push(1 + (r * 4 + b) * beat);
    expect(pickTempo(times, 60, 1).bpm).toBeCloseTo(180, 1);
    expect(pickTempo(times, 90, 1).bpm).toBeCloseTo(180, 1);
    expect(pickTempo(times, 180, 1).bpm).toBeCloseTo(180, 1);
  });

  it('2박 넘는 쉼은 일시 공전', () => {
    const r = restsToPauses([1, 1.5, 6, 6.25]);
    expect(r).toEqual([
      { turn: 1, pause: 0 },
      { turn: 0.5, pause: 0 },
      { turn: 0.5, pause: 4 },
      { turn: 0.25, pause: 0 },
    ]);
  });
});

describe('원곡 그대로 (모든 소리)', () => {
  // 180BPM: 16분 = 83ms, 32분 = 42ms(최소 간격 60ms라 제외 대상), 셋잇단 = 111ms
  const bpm = 180;
  const beat = 60 / bpm;
  const first = 1.2;
  // 4마디 패턴: 16분 연타, 셋잇단, 긴 쉼(3박 넘게), 싱코페이션
  const pattern: [number, 'kick' | 'snare' | 'hat' | 'tone'][] = [
    [0, 'kick'], [0.25, 'hat'], [0.5, 'tone'], [0.75, 'hat'], [1, 'snare'], [1.25, 'tone'], [1.5, 'kick'], [1.75, 'tone'],
    [2, 'kick'], [2 + 1 / 3, 'tone'], [2 + 2 / 3, 'tone'], [3, 'snare'], [3.5, 'tone'], [3.75, 'tone'],
    [4, 'kick'], [4.5, 'hat'], [5, 'snare'], [5.25, 'tone'], [5.5, 'tone'], [5.75, 'tone'], [6, 'tone'], [6.25, 'tone'],
    [7, 'kick'], // 여기서부터 3.5박 쉼
    [10.5, 'snare'], [10.75, 'tone'], [11, 'kick'], [11.5, 'tone'], [12, 'kick'], [13, 'snare'], [14, 'kick'], [14.5, 'tone'], [15, 'snare'],
  ];
  const reps = 6;
  const ev: { t: number; k: 'kick' | 'snare' | 'hat' | 'tone' }[] = [];
  const truthBeats: number[] = [];
  for (let r = 0; r < reps; r++)
    for (const [b, k] of pattern) {
      ev.push({ t: first + (r * 16 + b) * beat, k });
      truthBeats.push(r * 16 + b);
    }
  const pcm = synth(ev, first + reps * 16 * beat + 1.5);

  it('검출 시각 정확도 (중앙값 ±4ms 이내)', () => {
    const on = detectOnsets(pcm, SR);
    const errs: number[] = [];
    for (const e of ev) {
      let best = Infinity;
      for (const o of on) if (Math.abs(o.t - e.t) < Math.abs(best)) best = o.t - e.t;
      if (Math.abs(best) < 0.03) errs.push(best * 1000);
    }
    errs.sort((a, b) => a - b);
    expect(errs.length / ev.length).toBeGreaterThan(0.9);
    expect(Math.abs(errs[errs.length >> 1])).toBeLessThan(4);
  });

  it('모든 소리를 박 단위 그대로 타일로 (16분·셋잇단·쉼)', () => {
    const r = autoChartFull(pcm, SR, { bpm, offset: first });
    expect(r).not.toBeNull();
    const v = validateLevel(r!.level);
    expect(v.ok, v.ok ? '' : v.errors.join('\n')).toBe(true);
    const c = compileChart(r!.level);
    // 타일 도착 박 (첫 박 기준)
    const got = c.tiles.slice(1).map((t) => Math.round(((t.time - c.times[0]) / beat) * 1e4) / 1e4);
    const truth = truthBeats.filter((b) => b > 0).map((b) => Math.round(b * 1e4) / 1e4);
    const setGot = new Set(got);
    const exact = truth.filter((b) => setGot.has(b)).length;
    expect(exact / truth.length).toBeGreaterThan(0.9); // 박 값이 정확히 일치
    const setTruth = new Set(truth);
    expect(got.filter((b) => setTruth.has(b)).length / got.length).toBeGreaterThan(0.95); // 가짜 타일 거의 없음
    // 긴 쉼은 일시 공전으로 (채움 타일 없음)
    expect(r!.level.actions.some((a) => a.type === 'Pause')).toBe(true);
    // 빠른 구간은 속도를 올린다 (최대 2배 → 16분 = 90° 꺾임, 겹치지 않게 계단·지그재그용 회전 반전)
    expect(r!.level.actions.some((a) => a.type === 'SetSpeed')).toBe(true);
    expect(r!.twirls).toBeLessThan(c.tiles.length * 0.35);
    for (const t of c.tiles) expect(t.bpm).toBeLessThanOrEqual(bpm * 2 + 1e-6);
    // 셋잇단·16분 간격(초)이 그대로
    const gapsMs = c.tiles.slice(1, -1).map((t) => Math.round(t.duration * 1000));
    expect(gapsMs).toContain(Math.round((beat / 4) * 1000));
    expect(gapsMs).toContain(Math.round((beat / 3) * 1000));
    let bad = 0;
    for (let i = 0; i < c.tiles.length; i++)
      for (let j = i + 3; j < c.tiles.length; j++)
        if (Math.hypot(c.tiles[i].x - c.tiles[j].x, c.tiles[i].y - c.tiles[j].y) < TILE_LEN * 0.6) bad++;
    expect(bad).toBeLessThanOrEqual(Math.ceil(c.tiles.length * 0.03));
  });

  it('BPM·첫 박 자동 추정으로도 동작', () => {
    const r = autoChartFull(pcm, SR, {});
    expect(r).not.toBeNull();
    // 박자 후보 교정으로 원래 템포
    expect(Math.abs(r!.bpm - bpm)).toBeLessThan(0.5);
    expect(r!.tiles).toBeGreaterThan(truthBeats.length * 0.8);
  });
});

describe('원곡 그대로: 박자가 아닌 소리는 거른다', () => {
  // 실제 곡처럼: 10초 조용한 인트로(잡음 패드·비브라토 보컬·잔향) → 드럼 본편(128BPM)
  const bpm = 128;
  const beat = 60 / bpm;
  const intro = 10;
  const first = intro;
  const bodyBeats = 64;
  const len = intro + bodyBeats * beat + 1.5;
  const n = Math.ceil(len * SR);
  const pcm = new Float32Array(n);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  // 인트로·전체에 깔리는 요소
  let lp = 0;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // 천천히 출렁이는 바람 소리 같은 잡음 패드
    lp += (rnd() - lp) * 0.05;
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.3 * t) * Math.sin(2 * Math.PI * 0.07 * t);
    pcm[i] += lp * 0.25 * swell;
    // 비브라토 보컬 같은 지속음 (음정·세기가 계속 흔들림)
    const f = 330 * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t)) * (t < intro ? 1 : 1.5);
    ph += (2 * Math.PI * f) / SR;
    const amp = 0.12 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.7 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.45 * t));
    pcm[i] += Math.sin(ph) * amp + 0.4 * Math.sin(2 * ph) * amp;
    // 잔잔한 숨소리 같은 짧은 잡음 덩어리 (박자 아님)
  }
  for (let k = 0; k < 25; k++) {
    const t0 = 0.3 + k * 0.37 + (k % 3) * 0.05;
    if (t0 > intro - 0.3) break;
    const s0 = Math.round(t0 * SR);
    for (let i = 0; i < 0.12 * SR; i++) pcm[s0 + i] += rnd() * 0.05 * Math.sin((Math.PI * i) / (0.12 * SR));
  }
  // 본편 드럼: 킥 정박, 스네어 2·4, 하이햇 8분
  const truth: number[] = [];
  const ev: { t: number; k: 'kick' | 'snare' | 'hat' | 'tone' }[] = [];
  for (let b = 0; b < bodyBeats; b += 0.5) {
    const t = first + b * beat;
    if (b % 1 === 0) ev.push({ t, k: b % 2 === 1 ? 'snare' : 'kick' });
    ev.push({ t, k: 'hat' });
    truth.push(b);
  }
  const drums = synth(ev, len);
  for (let i = 0; i < n; i++) pcm[i] += drums[i];

  it('인트로에서는 타일이 거의 생기지 않고, 본편 박자는 잡는다', () => {
    for (const sens of [0.3, 0.55, 0.85]) {
      const r = autoChartFull(pcm, SR, { bpm, offset: first % beat, sensitivity: sens });
      expect(r, `sens ${sens}`).not.toBeNull();
      const c = compileChart(r!.level);
      const times = c.times.slice(1, -1);
      const inIntro = times.filter((t) => t < intro - 0.1).length;
      expect(inIntro, `sens ${sens}: 인트로 타일`).toBeLessThanOrEqual(3);
      const body = times.filter((t) => t >= intro - 0.05);
      const truthT = truth.map((b) => first + b * beat);
      const near = (t: number, xs: number[]) => xs.some((x) => Math.abs(x - t) < 0.025);
      expect(body.filter((t) => near(t, truthT)).length / body.length, `sens ${sens}: 정밀도`).toBeGreaterThan(0.95);
      expect(truthT.filter((t) => near(t, body)).length / truthT.length, `sens ${sens}: 재현율`).toBeGreaterThan(sens < 0.4 ? 0.45 : 0.85);
    }
  });
});

describe('원곡 그대로: 구간 단위 속도·템포 스캔', () => {
  it('16분 연타와 8분·4분이 섞여도 속도를 타일마다 바꾸지 않는다', () => {
    // 한 마디: 16분 8개 + 8분 2개 + 4분 1개 (타일 11개), 8마디
    const bar = [...Array(8).fill(0.25), 0.5, 0.5, 1];
    const gaps = Array.from({ length: 8 }, () => bar).flat();
    const m = chooseMults(gaps);
    let changes = 0;
    for (let k = 1; k < m.length; k++) if (m[k] !== m[k - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(1);
    // 보이는 회전(2박 넘는 부분은 일시 공전)이 ½~1½ 범위 (360° 머리핀 없음)
    for (let k = 1; k < m.length; k++) {
      let x = gaps[k] * m[k];
      while (x > 2 + 1e-9) x -= 2;
      expect(x).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(x).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  it('onset 격자 스캔으로 템포를 찾는다 (125 BPM, 16분·8분 섞임)', () => {
    const beat = 60 / 125;
    const times: number[] = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let b = 0; b < 64; b++)
      for (let q = 0; q < 4; q++) if (q === 0 || rnd() < 0.45) times.push(0.3 + (b + q / 4) * beat + (rnd() - 0.5) * 0.006);
    const top = scanTempo(times)[0];
    expect(Math.abs(top.bpm - 125)).toBeLessThan(0.6);
    const r = pickTempo(times, 125, top.phase, 70, 240, [1]);
    expect(r.bpm).toBe(125);
  });
});

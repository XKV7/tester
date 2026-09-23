import { defaultMeta, defaultSettings } from './level';
import { degToRad, flipDir, normDeg, TILE_LEN } from './math';
import { estimateTempo, FRAME_LAG, HOP, onsetEnvelope } from './tempo';
import type { Action, Dir, LevelData } from './types';

/**
 * 음원 → 레벨 자동 생성. 순수 함수.
 *
 * 1. BPM·첫 박 추정 (또는 지정값 사용)
 * 2. 반박 격자 위의 onset 세기를 재고, 백분위 기준으로 타격 지점을 고른다.
 * 3. 간격은 반박~1.5박으로 정리(2박 이상 빈 곳은 1박 타일로 채움), 입력 간격 최소 200ms.
 * 4. 간격(박) → 각도. 트랙이 겹치지 않도록 필요할 때만 회전 반전(Twirl)을 넣는다.
 * 5. 16박마다 체크포인트, 32박마다 트랙 색 변경.
 */
export type AutoDifficulty = 'easy' | 'normal' | 'hard';

export interface AutoOptions {
  difficulty?: AutoDifficulty;
  /** 지정하면 추정 대신 사용. */
  bpm?: number;
  /** 첫 박 시각 (bpm과 함께 지정). */
  offset?: number;
  title?: string;
  songFile?: string;
}

export interface AutoResult {
  level: LevelData;
  bpm: number;
  offset: number;
  tiles: number;
  twirls: number;
}

const MIN_GAP_SEC = 0.2;

const THRESH: Record<AutoDifficulty, { step: number; on: number; off: number; diff: number }> = {
  easy: { step: 0.5, on: 0.3, off: 0.9, diff: 2 },
  normal: { step: 0.5, on: 0.2, off: 0.72, diff: 4 },
  hard: { step: 0.5, on: 0.05, off: 0.45, diff: 6 },
};

const PALETTE = ['#3a3f55', '#4a3b5e', '#3b5e52', '#5e553b', '#553a3f'];

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** 곡 시각 t 근처(±30ms)의 onset 최댓값. */
export function onsetStrength(o: Float32Array, t: number): number {
  const c = Math.round((t - FRAME_LAG) / HOP);
  let m = 0;
  for (let f = c - 3; f <= c + 3; f++) if (f >= 0 && f < o.length && o[f] > m) m = o[f];
  return m;
}

/** 박 간격 목록 → 겹치지 않는 경로 (+ Twirl 위치). 꺾일 때마다 두 방향을 앞으로 몇 칸 시뮬레이션해 더 오래 비어 있는 쪽을 고른다. */
export function layoutBeats(intervals: number[], startDir: Dir = 'CW', lookahead = 12): { path: number[]; twirls: number[] } {
  const path: number[] = [];
  const twirls: number[] = [];
  const xs: number[] = [0];
  const ys: number[] = [0];
  const cell = TILE_LEN;
  const grid = new Map<string, number[]>();
  const addPt = (i: number) => {
    const k = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
    const a = grid.get(k);
    if (a) a.push(i);
    else grid.set(k, [i]);
  };
  addPt(0);
  const LIMIT = TILE_LEN * 0.75;
  /** 기존 점(최근 2개 제외)과 LIMIT 안으로 가까워지는지. */
  const blocked = (x: number, y: number, upto: number): boolean => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (i >= upto) continue;
          if (Math.hypot(xs[i] - x, ys[i] - y) < LIMIT) return true;
        }
    return false;
  };
  const step = (heading: number, first: boolean, b: number, d: Dir) =>
    normDeg(d === 'CW' ? (first ? 180 : heading + 180) - b * 180 : (first ? 180 : heading + 180) + b * 180);
  /** 선택 후 앞으로 몇 칸이나 막히지 않고 갈 수 있는지 (같은 방향 유지 가정, 막히면 반대 방향도 시도). */
  const freeRun = (k: number, angle: number, d: Dir): number => {
    let x = xs[xs.length - 1];
    let y = ys[ys.length - 1];
    let h = angle;
    let dd = d;
    const sim: [number, number][] = [];
    const clash = (px: number, py: number, upto: number) =>
      blocked(px, py, upto) || sim.slice(0, -2).some(([sx, sy]) => Math.hypot(sx - px, sy - py) < LIMIT);
    for (let j = 0; j <= lookahead && k + j < intervals.length; j++) {
      if (j > 0) {
        const b = intervals[k + j];
        let a = step(h, false, b, dd);
        const nx = x + TILE_LEN * Math.cos(degToRad(a));
        const ny = y + TILE_LEN * Math.sin(degToRad(a));
        if (clash(nx, ny, xs.length - 1) && Math.abs(b - 1) > 1e-9) {
          const alt = step(h, false, b, flipDir(dd));
          const ax = x + TILE_LEN * Math.cos(degToRad(alt));
          const ay = y + TILE_LEN * Math.sin(degToRad(alt));
          if (!clash(ax, ay, xs.length - 1)) {
            a = alt;
            dd = flipDir(dd);
          }
        }
        h = a;
      }
      x += TILE_LEN * Math.cos(degToRad(h));
      y += TILE_LEN * Math.sin(degToRad(h));
      if (clash(x, y, xs.length - 1)) return j;
      sim.push([x, y]);
    }
    return lookahead + 1;
  };

  let dir = startDir;
  let heading = 0;
  intervals.forEach((b, k) => {
    const keep = step(heading, k === 0, b, dir);
    let angle = keep;
    if (Math.abs(b - 1) > 1e-9) {
      const runKeep = freeRun(k, keep, dir);
      if (runKeep <= lookahead) {
        const altDir = flipDir(dir);
        const alt = step(heading, k === 0, b, altDir);
        if (freeRun(k, alt, altDir) > runKeep) {
          twirls.push(k);
          dir = altDir;
          angle = alt;
        }
      }
    }
    path.push(angle);
    heading = angle;
    const i = xs.length - 1;
    xs.push(xs[i] + TILE_LEN * Math.cos(degToRad(angle)));
    ys.push(ys[i] + TILE_LEN * Math.sin(degToRad(angle)));
    addPt(xs.length - 1);
  });
  return { path, twirls };
}

export function autoChart(samples: Float32Array, sampleRate: number, opts: AutoOptions = {}): AutoResult | null {
  const diff = opts.difficulty ?? 'normal';
  const cfg = THRESH[diff];
  const est =
    opts.bpm && opts.bpm > 0
      ? { bpm: opts.bpm, offset: opts.offset ?? 0 }
      : estimateTempo(samples, sampleRate);
  if (!est) return null;
  const bpm = est.bpm;
  const beat = 60 / bpm;
  let first = est.offset;
  while (first < 1) first += beat;
  const songEnd = samples.length / sampleRate - 0.8;
  if (songEnd - first < beat * 8) return null;

  const o = onsetEnvelope(samples, sampleRate, songEnd + 2);
  let step = cfg.step;
  if (step * beat < MIN_GAP_SEC) step = 1;
  if (beat < MIN_GAP_SEC) return null;

  // 격자 지점 세기
  const pos: { b: number; s: number; on: boolean }[] = [];
  for (let b = step; first + b * beat < songEnd; b += step) {
    const on = Math.abs(b - Math.round(b)) < 1e-6;
    pos.push({ b, s: onsetStrength(o, first + b * beat), on });
  }
  const onTh = percentile(pos.filter((p) => p.on).map((p) => p.s), cfg.on);
  const offTh = cfg.off >= 1 ? Infinity : percentile(pos.filter((p) => !p.on).map((p) => p.s), cfg.off);
  const picked = pos.filter((p) => p.s > 0 && p.s >= (p.on ? onTh : offTh)).map((p) => p.b);

  // 간격 정리: 2박 이상 빈 곳은 1박씩 채우고, 너무 짧은 간격은 버린다
  const hits: number[] = [];
  let prev = 0;
  for (const b of picked) {
    while (b - prev > 1.5 + 1e-9) {
      prev += 1;
      hits.push(prev);
    }
    if ((b - prev) * beat < MIN_GAP_SEC - 1e-9 || b - prev < 0.5 - 1e-9) continue;
    hits.push(b);
    prev = b;
  }
  if (hits.length < 8) return null;
  const intervals = hits.map((b, i) => b - (i === 0 ? 0 : hits[i - 1]));

  const lay = layoutBeats(intervals, 'CW');
  const actions: Action[] = lay.twirls.map((k) => ({ floor: k, type: 'Twirl' as const }));
  const n = lay.path.length + 1;
  let nextCp = 16;
  let nextColor = 32;
  let colorIdx = 0;
  for (let i = 1; i < n - 1; i++) {
    const at = hits[i - 1];
    if (at >= nextCp) {
      actions.push({ floor: i, type: 'Checkpoint' });
      nextCp = at + 16;
    }
    if (at >= nextColor) {
      colorIdx = (colorIdx + 1) % PALETTE.length;
      actions.push({ floor: i, type: 'RecolorTrack', from: i, to: n - 1, color: PALETTE[colorIdx], duration: 1 });
      nextColor = at + 32;
    }
  }
  actions.sort((a, b) => a.floor - b.floor);

  const settings = { ...defaultSettings(), bpm, offset: Math.round(first * 1000) / 1000, songFile: opts.songFile ?? '' };
  const meta = {
    ...defaultMeta(),
    title: opts.title || '자동 생성 레벨',
    artist: '',
    author: 'ORBIT 자동 생성',
    difficulty: cfg.diff,
    previewStart: Math.round(Math.max(0, (samples.length / sampleRate) * 0.3) * 10) / 10,
  };
  return {
    level: { version: 1, meta, settings, path: lay.path, actions },
    bpm,
    offset: settings.offset,
    tiles: n,
    twirls: lay.twirls.length,
  };
}

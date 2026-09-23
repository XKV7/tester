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
 * 5. 체크포인트·색 변경 같은 이벤트는 넣지 않는다 (Twirl만). 필요하면 에디터에서 직접 추가.
 */
export type AutoDifficulty = 'easy' | 'normal' | 'hard' | 'expert' | 'master';

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

interface DiffCfg {
  /** 한 박 안의 격자 위치 (0 = 정박). */
  grid: number[];
  /** 백분위 기준: 정박 / 반박 / 그보다 잘게 (16분·셋잇단). 1이면 쓰지 않음. */
  beat: number;
  half: number;
  fine: number;
  /** 타일 사이 최소 박 / 최소 시간(초). */
  minBeats: number;
  minGapSec: number;
  diff: number;
}

export const DIFF_CFG: Record<AutoDifficulty, DiffCfg> = {
  easy: { grid: [0, 0.5], beat: 0.3, half: 0.9, fine: 1, minBeats: 0.5, minGapSec: 0.2, diff: 2 },
  normal: { grid: [0, 0.5], beat: 0.2, half: 0.72, fine: 1, minBeats: 0.5, minGapSec: 0.2, diff: 4 },
  hard: { grid: [0, 0.5], beat: 0.05, half: 0.45, fine: 1, minBeats: 0.5, minGapSec: 0.2, diff: 6 },
  /** 16분음표까지 */
  expert: { grid: [0, 0.25, 0.5, 0.75], beat: 0.05, half: 0.35, fine: 0.62, minBeats: 0.25, minGapSec: 0.12, diff: 8 },
  /** 16분음표 + 셋잇단 */
  master: { grid: [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75], beat: 0.02, half: 0.3, fine: 0.5, minBeats: 1 / 6, minGapSec: 0.1, diff: 10 },
};

export const DIFF_LABEL: Record<AutoDifficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
  expert: '매우 어려움',
  master: '극한',
};

const EPS = 1e-6;


function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** 박 위치가 minBeats보다 가까운 후보끼리는 세기가 큰 쪽만 남긴다. */
function suppressClose<T extends { b: number; s: number }>(xs: T[], minBeats: number): T[] {
  const byStrength = [...xs].sort((a, b) => b.s - a.s);
  const kept: T[] = [];
  for (const x of byStrength) if (!kept.some((k) => Math.abs(k.b - x.b) < minBeats - EPS)) kept.push(x);
  return kept.sort((a, b) => a.b - b.b);
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
  const cfg = DIFF_CFG[diff];
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
  if (beat < MIN_GAP_SEC) return null;
  // 이 BPM에서 너무 촘촘한 격자는 뺀다: 각 위치가 속한 박자 단위(반박·16분·셋잇단)의 간격이 최소 간격보다 짧으면 제외.
  // (16분과 셋잇단끼리 가까운 것은 아래 suppressClose가 처리)
  const unitOf = (f: number) =>
    f === 0 ? 1 : Math.abs(f * 2 - Math.round(f * 2)) < EPS ? 0.5 : Math.abs(f * 3 - Math.round(f * 3)) < EPS ? 1 / 3 : 0.25;
  const grid = cfg.grid.filter((f) => unitOf(f) * beat >= Math.min(cfg.minGapSec, 0.5 * beat) - EPS);

  // 격자 지점 세기
  type Pos = { b: number; s: number; kind: 'beat' | 'half' | 'fine' };
  const pos: Pos[] = [];
  for (let k = 0; first + k * beat < songEnd; k++)
    for (const f of grid) {
      const b = k + f;
      if (b <= 0 || first + b * beat >= songEnd) continue;
      const kind = f === 0 ? 'beat' : Math.abs(f - 0.5) < EPS ? 'half' : 'fine';
      pos.push({ b, s: onsetStrength(o, first + b * beat), kind });
    }
  const th = (kind: Pos['kind']) => {
    const p = kind === 'beat' ? cfg.beat : kind === 'half' ? cfg.half : cfg.fine;
    return p >= 1 ? Infinity : percentile(pos.filter((x) => x.kind === kind).map((x) => x.s), p);
  };
  const T = { beat: th('beat'), half: th('half'), fine: th('fine') };
  let cand = pos.filter((p) => p.s > 0 && p.s >= T[p.kind]);
  // 너무 가까운 후보(16분 vs 셋잇단 등)는 더 강한 쪽만
  cand = suppressClose(cand, cfg.minBeats);
  const picked = cand.map((p) => p.b);
  // 채움 후보: 격자 중 소리가 조금이라도 있는 곳 (세기 순 상위 절반)
  const fillTh = percentile(pos.map((p) => p.s), 0.5);
  const fill = pos.filter((p) => p.s > 0 && p.s >= fillTh).map((p) => p.b);

  return levelFromHits(picked, bpm, first, {
    minBeats: cfg.minBeats,
    minGapSec: cfg.minGapSec,
    fill,
    title: opts.title,
    songFile: opts.songFile,
    difficulty: cfg.diff,
    previewStart: Math.max(0, (samples.length / sampleRate) * 0.3),
  });
}

/**
 * 타격 위치(첫 박 기준 박, 오름차순) → 레벨. 음원 분석과 음악 생성이 함께 쓴다.
 * 간격 정리: 입력 간격 최소 반박·200ms, 1.5박보다 긴 빈 곳은 1박 타일로 채운다.
 */
export function levelFromHits(
  beats: number[],
  bpm: number,
  first: number,
  opts: {
    title?: string;
    songFile?: string;
    difficulty?: number;
    previewStart?: number;
    author?: string;
    artist?: string;
    /** 빈 곳을 채울 때 우선 고를 위치 (약한 소리가 나는 박). 없으면 1박 간격. */
    fill?: number[];
    /** 타일 사이 최소 박 (기본 0.5) / 최소 시간 (기본 0.2초). */
    minBeats?: number;
    minGapSec?: number;
  } = {},
): AutoResult | null {
  const beat = 60 / bpm;
  const minBeats = opts.minBeats ?? 0.5;
  const minGap = opts.minGapSec ?? MIN_GAP_SEC;
  const fill = [...(opts.fill ?? [])].sort((x, y) => x - y);
  const hits: number[] = [];
  let prev = 0;
  for (const b of [...beats].sort((x, y) => x - y)) {
    if (b <= 0) continue;
    while (b - prev > 1.5 + 1e-9) {
      // 다음 채움 위치: prev+1에 가장 가까운 소리 (prev+0.5 ~ prev+1.5, 다음 타격 0.5박 전까지)
      const lo = prev + Math.max(0.5, minGap / beat);
      const hi = Math.min(prev + 1.5, b - Math.max(minBeats, minGap / beat));
      let pickB = prev + 1;
      let best = Infinity;
      for (const f of fill) {
        if (f < lo - 1e-9) continue;
        if (f > hi + 1e-9) break;
        const d = Math.abs(f - (prev + 1));
        if (d < best) {
          best = d;
          pickB = f;
        }
      }
      prev = pickB;
      hits.push(prev);
    }
    if ((b - prev) * beat < minGap - 1e-9 || b - prev < minBeats - 1e-9) continue;
    hits.push(b);
    prev = b;
  }
  if (hits.length < 8) return null;
  const intervals = hits.map((b, i) => b - (i === 0 ? 0 : hits[i - 1]));

  const lay = layoutBeats(intervals, 'CW');
  const actions: Action[] = lay.twirls.map((k) => ({ floor: k, type: 'Twirl' as const }));
  const n = lay.path.length + 1;

  const settings = { ...defaultSettings(), bpm, offset: Math.round(first * 1000) / 1000, songFile: opts.songFile ?? '' };
  const meta = {
    ...defaultMeta(),
    title: opts.title || '자동 생성 레벨',
    artist: opts.artist ?? '',
    author: opts.author ?? 'ORBIT 자동 생성',
    difficulty: opts.difficulty ?? 4,
    previewStart: Math.round((opts.previewStart ?? 0) * 10) / 10,
  };
  return {
    level: { version: 1, meta, settings, path: lay.path, actions },
    bpm,
    offset: settings.offset,
    tiles: n,
    twirls: lay.twirls.length,
  };
}

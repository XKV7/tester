import type { Dir, Vec2 } from './types';

/** 타일 간 거리 (월드 단위). */
export const TILE_LEN = 100;
const EPS = 1e-6;

export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

export function normDeg(a: number): number {
  return mod(a, 360);
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 두 각도가 (mod 360) 같은지. */
export function sameAngle(a: number, b: number): boolean {
  const d = normDeg(a - b);
  return d < EPS || d > 360 - EPS;
}

/** path → 타일 위치 (수학 좌표계, y 위쪽). 길이 = path.length + 1. */
export function tilePositions(path: readonly number[], len = TILE_LEN): Vec2[] {
  const out: Vec2[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (const a of path) {
    const r = degToRad(a);
    x += len * Math.cos(r);
    y += len * Math.sin(r);
    out.push({ x, y });
  }
  return out;
}

/** 타일 i에 도착했을 때 공전 시작 각도. */
export function entryAngle(path: readonly number[], i: number): number {
  return i === 0 ? 180 : path[i - 1] + 180;
}

/**
 * 회전량 θ (도). θ가 0이면 360(U턴)으로 처리. midspin이면 0 허용.
 */
export function rotationTheta(start: number, target: number, dir: Dir, midspin = false): number {
  let t = dir === 'CW' ? mod(start - target, 360) : mod(target - start, 360);
  if (t < EPS || t > 360 - EPS) t = midspin ? 0 : 360;
  return t;
}

export function thetaToBeats(theta: number): number {
  return theta / 180;
}

/** 각속도 (°/s). */
export function angularSpeed(bpm: number): number {
  return (180 * bpm) / 60;
}

export function dirSign(dir: Dir): 1 | -1 {
  return dir === 'CW' ? -1 : 1;
}

export function flipDir(dir: Dir): Dir {
  return dir === 'CW' ? 'CCW' : 'CW';
}

/** 가장 가까운 step 단위로 스냅. */
export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

/** 이진 탐색: times[i] <= t 인 가장 큰 i (없으면 0). */
export function floorIndex(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t < times[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

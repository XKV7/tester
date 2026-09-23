import { cloneLevel } from './level';
import { flipDir, mod, normDeg, snap } from './math';
import type { Action, Dir, LevelData } from './types';

/** 선택 타일 뒤에 새 타일 추가. 반환: 새 레벨과 새로 선택할 타일. */
export function insertTileAfter(level: LevelData, sel: number, angle: number): { level: LevelData; sel: number } {
  const lv = cloneLevel(level);
  const a = normDeg(angle);
  lv.path.splice(sel, 0, a);
  for (const act of lv.actions) shiftAction(act, sel, +1);
  return { level: lv, sel: sel + 1 };
}

/** 타일 sel 삭제 (타일 0은 삭제 불가). */
export function deleteTile(level: LevelData, sel: number): { level: LevelData; sel: number } {
  if (sel <= 0 || level.path.length <= 1) return { level, sel };
  const lv = cloneLevel(level);
  lv.path.splice(sel - 1, 1);
  lv.actions = lv.actions.filter((a) => a.floor !== sel);
  for (const act of lv.actions) shiftAction(act, sel, -1);
  const n = lv.path.length + 1;
  lv.actions = lv.actions.filter((a) => a.floor < n);
  return { level: lv, sel: sel - 1 };
}

function shiftAction(a: Action, pivot: number, d: 1 | -1): void {
  if (a.floor > pivot) a.floor += d;
  if (a.type === 'RecolorTrack' || a.type === 'MoveTrack') {
    if (a.from > pivot) a.from += d;
    if (d > 0 ? a.to > pivot : a.to >= pivot) a.to += d;
    if (a.to < a.from) a.to = a.from;
  }
}

/** 선택 타일의 나가는 방향 설정. */
export function setOutAngle(level: LevelData, sel: number, angle: number): LevelData {
  if (sel >= level.path.length) return level;
  const lv = cloneLevel(level);
  lv.path[sel] = normDeg(angle);
  return lv;
}

export function addAction(level: LevelData, action: Action): LevelData {
  const lv = cloneLevel(level);
  lv.actions.push(action);
  if (action.type === 'Midspin' && action.floor > 0 && action.floor < lv.path.length) {
    lv.path[action.floor] = normDeg(lv.path[action.floor - 1] + 180);
  }
  return lv;
}

export function removeAction(level: LevelData, index: number): LevelData {
  const lv = cloneLevel(level);
  lv.actions.splice(index, 1);
  return lv;
}

export function replaceAction(level: LevelData, index: number, action: Action): LevelData {
  const lv = cloneLevel(level);
  lv.actions[index] = action;
  return lv;
}

export type RecordMode = 'zigzag' | 'oneway' | 'straight';

export interface RecordResult {
  angles: number[];
  /** 추가 타일 기준 상대 floor에 넣을 Twirl (0 = 첫 추가 타일의 출발 타일). */
  twirls: number[];
}

/**
 * 녹화 모드: 누른 간격(초) → 박 수 → θ(15° 스냅) → 각도.
 * @param entry 첫 출발 타일의 공전 시작 각도
 * @param dir 첫 출발 타일의 회전 방향
 */
export function recordToAngles(
  intervals: number[],
  bpm: number,
  entry: number,
  dir: Dir,
  mode: RecordMode,
): RecordResult {
  const angles: number[] = [];
  const twirls: number[] = [];
  let start = entry;
  let d = dir;
  let turnSign = 1;
  intervals.forEach((sec, k) => {
    const beats = (sec * bpm) / 60;
    let theta = snap(beats * 180, 15);
    theta = Math.min(360, Math.max(15, theta));
    if (mode === 'straight' && Math.abs(theta - 180) <= 30) theta = 180;
    const isTurn = theta !== 180 && theta !== 360;
    if (mode === 'zigzag' && isTurn) {
      // 좌·우 꺾임을 번갈아: 필요하면 Twirl로 회전 방향 반전.
      const want: Dir = turnSign > 0 ? dir : flipDir(dir);
      if (want !== d) {
        twirls.push(k);
        d = want;
      }
      turnSign = -turnSign;
    }
    const target = d === 'CW' ? start - theta : start + theta;
    const a = normDeg(target);
    angles.push(a);
    start = mod(a + 180, 360);
  });
  return { angles, twirls };
}

/** 선택 타일 뒤에 1박 직진 타일 count개 채우기. */
export function fillStraight(level: LevelData, sel: number, count: number, bpm?: number): { level: LevelData; sel: number } {
  let lv = level;
  let s = sel;
  const dir = s === 0 ? 0 : lv.path[s - 1];
  if (bpm && bpm > 0) {
    lv = cloneLevel(lv);
    lv.actions = lv.actions.filter((a) => !(a.floor === s && a.type === 'SetSpeed'));
    lv.actions.push({ floor: s, type: 'SetSpeed', bpm });
  }
  for (let i = 0; i < count; i++) {
    const r = insertTileAfter(lv, s, dir);
    lv = r.level;
    s = r.sel;
  }
  return { level: lv, sel: s };
}

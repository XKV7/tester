import {
  angularSpeed,
  dirSign,
  entryAngle,
  flipDir,
  floorIndex,
  normDeg,
  rotationTheta,
  thetaToBeats,
  tilePositions,
  TILE_LEN,
} from './math';
import type { Action, Dir, LevelData } from './types';

export interface ChartTile {
  floor: number;
  x: number;
  y: number;
  /** 이 타일로 들어온 방향 (path[i-1]). 타일 0은 null. */
  angleIn: number | null;
  /** 다음 타일로 가는 방향 (path[i]). 도착 타일은 null. */
  angleOut: number | null;
  /** 공전 시작 각도. */
  start: number;
  /** 목표 각도. */
  target: number;
  dir: Dir;
  /** 기본 회전량 (도). */
  theta: number;
  pauseBeats: number;
  holdBeats: number;
  /** 이 타일에서 다음 타일까지 전체 박 수 (θ/180 + pause + hold). */
  beats: number;
  /** 시각적으로 도는 전체 각도. */
  sweep: number;
  bpm: number;
  /** 이 타일에 도착하는 목표 시각 (곡 기준 초). */
  time: number;
  /** 다음 타일까지 걸리는 시간 (곡 기준 초). */
  duration: number;
  /** 공전 각속도 (°/s, 부호 없음). */
  rate: number;
  midspin: boolean;
  checkpoint: boolean;
  twirl: boolean;
  speed: 'up' | 'down' | null;
  text: string | null;
  /** 누적 박 (첫 타일 기준). */
  beatPos: number;
}

export interface TimedAction {
  action: Action;
  time: number;
  /** 초 단위 지속 시간. */
  duration: number;
}

export interface Chart {
  level: LevelData;
  tiles: ChartTile[];
  times: number[];
  /** 연출 이벤트 (시간순). */
  visual: TimedAction[];
  finish: number;
  lastTime: number;
}

const VISUAL_TYPES = new Set(['Camera', 'Flash', 'RecolorTrack', 'MoveTrack', 'Background']);

/** 레벨을 컴파일해 모든 타일의 위치·박·시각을 미리 계산한다. */
export function compileChart(level: LevelData): Chart {
  const { path, settings } = level;
  const pos = tilePositions(path, TILE_LEN);
  const n = path.length + 1;
  const byFloor: Action[][] = Array.from({ length: n }, () => []);
  for (const a of level.actions) if (a.floor >= 0 && a.floor < n) byFloor[a.floor].push(a);

  const tiles: ChartTile[] = [];
  const times: number[] = [];
  let dir: Dir = settings.startDirection;
  let bpm = settings.bpm;
  let time = settings.offset;
  let beatPos = 0;

  for (let i = 0; i < n; i++) {
    let twirl = false;
    let midspin = false;
    let checkpoint = false;
    let pauseBeats = 0;
    let holdBeats = 0;
    let text: string | null = null;
    const prevBpm = bpm;
    for (const a of byFloor[i]) {
      switch (a.type) {
        case 'Twirl':
          dir = flipDir(dir);
          twirl = !twirl;
          break;
        case 'SetSpeed':
          bpm = a.bpm !== undefined ? a.bpm : bpm * (a.multiplier ?? 1);
          break;
        case 'Midspin':
          midspin = true;
          break;
        case 'Checkpoint':
          checkpoint = true;
          break;
        case 'Pause':
          pauseBeats += a.beats;
          break;
        case 'Hold':
          holdBeats += a.beats;
          break;
        case 'Text':
          text = a.text;
          break;
      }
    }
    const isFinish = i === n - 1;
    const start = normDeg(entryAngle(path, i));
    const target = isFinish ? start : normDeg(path[i]);
    const theta = isFinish ? 0 : rotationTheta(start, target, dir, midspin);
    if (isFinish) {
      pauseBeats = 0;
      holdBeats = 0;
    }
    const beats = thetaToBeats(theta) + pauseBeats + holdBeats;
    const extra = pauseBeats + holdBeats;
    // 추가 공전은 온바퀴 단위로 돌아 목표 각도에 정확히 도착한다.
    const turns = extra > 0 ? Math.max(1, Math.round(extra / 2)) : 0;
    const sweep = theta + 360 * turns;
    const duration = (beats * 60) / bpm;
    tiles.push({
      floor: i,
      x: pos[i].x,
      y: pos[i].y,
      angleIn: i === 0 ? null : path[i - 1],
      angleOut: isFinish ? null : path[i],
      start,
      target,
      dir,
      theta,
      pauseBeats,
      holdBeats,
      beats,
      sweep,
      bpm,
      time,
      duration,
      rate: duration > 0 ? sweep / duration : angularSpeed(bpm),
      midspin,
      checkpoint,
      twirl,
      speed: bpm > prevBpm + 1e-9 ? 'up' : bpm < prevBpm - 1e-9 ? 'down' : null,
      text,
      beatPos,
    });
    times.push(time);
    time += duration;
    beatPos += beats;
  }

  const visual: TimedAction[] = [];
  for (const a of level.actions) {
    if (!VISUAL_TYPES.has(a.type) || a.floor >= n) continue;
    const t = tiles[a.floor];
    const beats = 'duration' in a && typeof a.duration === 'number' ? a.duration : 0;
    visual.push({ action: a, time: t.time, duration: (beats * 60) / t.bpm });
  }
  visual.sort((a, b) => a.time - b.time);

  return { level, tiles, times, visual, finish: n - 1, lastTime: times[n - 1] };
}

/** 타일 i가 축일 때 곡 시각 t에서 공전 행성의 각도 (도). */
export function orbiterAngle(tile: ChartTile, t: number): number {
  return tile.start + dirSign(tile.dir) * tile.rate * (t - tile.time);
}

/** 곡 시각 t에서 누적 박 위치 (비트 펄스, 합성 음원용). */
export function beatPhaseAt(chart: Chart, t: number): number {
  const tiles = chart.tiles;
  if (t < tiles[0].time) return ((t - tiles[0].time) * tiles[0].bpm) / 60;
  const i = floorIndex(chart.times, t);
  const tile = tiles[i];
  return tile.beatPos + ((t - tile.time) * tile.bpm) / 60;
}

/** 1박 길이 (ms, 실제 시간). */
export function beatMs(tile: ChartTile, pitch: number): number {
  return 60000 / tile.bpm / pitch;
}

/** 체크포인트 재개 시 시작할 곡 시각: 해당 타일 2박 전. */
export function resumeTime(chart: Chart, floor: number, beats = 2): number {
  const prev = chart.tiles[Math.max(0, floor - 1)];
  return chart.tiles[floor].time - (beats * 60) / prev.bpm;
}

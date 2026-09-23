/** 회전 방향. CW = 시계, CCW = 반시계. */
export type Dir = 'CW' | 'CCW';

export type EaseName =
  | 'linear'
  | 'inSine'
  | 'outSine'
  | 'inOutSine'
  | 'inQuad'
  | 'outQuad'
  | 'inOutQuad'
  | 'outBack'
  | 'outElastic';

export interface LevelMeta {
  title: string;
  artist: string;
  author: string;
  difficulty: number;
  previewStart: number;
}

export interface LevelSettings {
  songFile: string;
  bpm: number;
  offset: number;
  pitch: number;
  volume: number;
  countdownTicks: number;
  trackColor: string;
  bgColor: string;
  startDirection: Dir;
}

interface ActionBase {
  floor: number;
}

export interface SetSpeedAction extends ActionBase {
  type: 'SetSpeed';
  bpm?: number;
  multiplier?: number;
}
export interface TwirlAction extends ActionBase {
  type: 'Twirl';
}
export interface CheckpointAction extends ActionBase {
  type: 'Checkpoint';
}
export interface MidspinAction extends ActionBase {
  type: 'Midspin';
}
export interface PauseAction extends ActionBase {
  type: 'Pause';
  beats: number;
}
export interface HoldAction extends ActionBase {
  type: 'Hold';
  beats: number;
}
export interface CameraAction extends ActionBase {
  type: 'Camera';
  zoom?: number;
  rotation?: number;
  offset?: [number, number];
  duration?: number;
  ease?: EaseName;
}
export interface FlashAction extends ActionBase {
  type: 'Flash';
  color?: string;
  opacity?: number;
  duration?: number;
}
export interface RecolorTrackAction extends ActionBase {
  type: 'RecolorTrack';
  from: number;
  to: number;
  color: string;
  duration?: number;
}
export interface MoveTrackAction extends ActionBase {
  type: 'MoveTrack';
  from: number;
  to: number;
  offset?: [number, number];
  rotation?: number;
  opacity?: number;
  duration?: number;
  ease?: EaseName;
}
export interface BackgroundAction extends ActionBase {
  type: 'Background';
  color?: string;
  image?: string;
}
/** 명세 확장: 튜토리얼 안내 문구. */
export interface TextAction extends ActionBase {
  type: 'Text';
  text: string;
}

export type Action =
  | SetSpeedAction
  | TwirlAction
  | CheckpointAction
  | MidspinAction
  | PauseAction
  | HoldAction
  | CameraAction
  | FlashAction
  | RecolorTrackAction
  | MoveTrackAction
  | BackgroundAction
  | TextAction;

export type ActionType = Action['type'];

export interface LevelData {
  version: 1;
  meta: LevelMeta;
  settings: LevelSettings;
  path: number[];
  actions: Action[];
}

export interface Vec2 {
  x: number;
  y: number;
}

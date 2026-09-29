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
  /** 연출 이벤트: 타일을 친 뒤 이만큼(박) 늦게 시작. */
  delay?: number;
}

/** 카메라 기준: 행성(기본) · 특정 타일 · 월드 원점 · 직전 기준 유지. */
export type CameraAnchor = 'player' | 'tile' | 'global' | 'last';

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
  relativeTo?: CameraAnchor;
  /** relativeTo='tile'일 때 기준 타일 번호. */
  tile?: number;
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
  /** 끝 색·불투명도 (생략 = 같은 색, 0). 끝나도 끝 상태가 남는다. */
  endColor?: string;
  endOpacity?: number;
  /** fg = 화면 전체(기본), bg = 배경만 (트랙 뒤) */
  plane?: 'fg' | 'bg';
  duration?: number;
}
/** 타일 모양: orbit(기본, 둥근 띠) · standard(채움 + 어두운 테두리) · neon(어두운 속 + 밝은 테두리, 밟으면 환하게) · basic(단색). */
export type TrackStyle = 'orbit' | 'standard' | 'neon' | 'basic';
export interface RecolorTrackAction extends ActionBase {
  type: 'RecolorTrack';
  from: number;
  to: number;
  color: string;
  duration?: number;
  style?: TrackStyle;
  /** 두 번째 색: 있으면 두 색 사이를 물결치듯 오간다 (원작 Glow). */
  color2?: string;
  /** 한 번 오가는 시간 (초). */
  glowDuration?: number;
  /** 물결 한 번의 길이 (타일 수). */
  pulseLength?: number;
}
export interface MoveTrackAction extends ActionBase {
  type: 'MoveTrack';
  from: number;
  to: number;
  offset?: [number, number];
  rotation?: number;
  opacity?: number;
  /** 타일 크기 배율 (1 = 원래 크기). */
  scale?: number;
  duration?: number;
  ease?: EaseName;
}
export interface BackgroundAction extends ActionBase {
  type: 'Background';
  color?: string;
  image?: string;
  /** 이미지 배치: cover(화면 채움, 기본) · contain · unscaled · tile. */
  fit?: 'cover' | 'contain' | 'unscaled' | 'tile';
  /** 이미지 색조 (#rrggbb). */
  tint?: string;
  /** 이미지 불투명도 (0~1, 기본 0.55). */
  opacity?: number;
  /** 배경 동영상 파일 이름 ('' = 끔). 소리 없이 곡 시각에 맞춰 재생. */
  video?: string;
  /** 동영상 시작 시각 (초, 곡 시각 기준). */
  videoOffset?: number;
  /** 끝나면 반복 */
  videoLoop?: boolean;
}
/** 화면 필터 (원작 SetFilter). intensity 0~1. */
export interface FilterAction extends ActionBase {
  type: 'Filter';
  filter: string;
  enabled: boolean;
  intensity?: number;
  /** 켜면서 다른 필터를 모두 끔. */
  exclusive?: boolean;
  duration?: number;
}
/** 빛 번짐 (원작 Bloom). intensity 0~(대략)2. */
export interface BloomAction extends ActionBase {
  type: 'Bloom';
  enabled: boolean;
  intensity?: number;
  threshold?: number;
  color?: string;
}
/** 화면 흔들림. strength: 타일 길이 대비 (1 = 한 타일). */
export interface ShakeAction extends ActionBase {
  type: 'Shake';
  duration: number;
  strength?: number;
  /** 초당 흔들림 횟수. */
  frequency?: number;
  fadeOut?: boolean;
}
export type TrackAppear = 'none' | 'fade' | 'grow' | 'extend' | 'drop' | 'rise' | 'scatter' | 'spin';
export type TrackDisappear = 'none' | 'fade' | 'shrink' | 'scatter' | 'retract' | 'spin';
/** 타일이 나타나고 사라지는 방식 (원작 AnimateTrack). */
export interface TrackAnimAction extends ActionBase {
  type: 'TrackAnim';
  appear?: TrackAppear;
  /** 칠 시각보다 이만큼(박) 앞에서 나타남. */
  beatsAhead?: number;
  disappear?: TrackDisappear;
  /** 친 뒤 이만큼(박) 지나 사라짐. */
  beatsBehind?: number;
}
/** 장식 움직이기 (원작 MoveDecorations). tag는 공백으로 여러 개. */
export interface MoveDecorationsAction extends ActionBase {
  type: 'MoveDecorations';
  tag: string;
  /** 원래 위치 기준 이동량 (월드 단위, y 위쪽). */
  offset?: [number, number];
  rotation?: number;
  scale?: [number, number];
  color?: string;
  opacity?: number;
  visible?: boolean;
  image?: string;
  duration?: number;
  ease?: EaseName;
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
  | TextAction
  | FilterAction
  | BloomAction
  | ShakeAction
  | TrackAnimAction
  | MoveDecorationsAction;

export type ActionType = Action['type'];

/** 장식 (이미지 또는 글자). 위치·크기는 월드 단위 (TILE_LEN = 타일 한 칸, y 위쪽). */
export interface Decoration {
  /** 태그 (공백으로 여러 개) — MoveDecorations가 찾는 이름. */
  tag?: string;
  image?: string;
  text?: string;
  /** 기준: tile(floor 타일) · global(월드 원점) · camera(화면 중앙, 카메라와 함께 움직임). */
  relativeTo?: 'tile' | 'global' | 'camera';
  floor?: number;
  position?: [number, number];
  /** 회전 중심 이동 (월드 단위). */
  pivot?: [number, number];
  rotation?: number;
  /** 이미지 원본 1px = 1/150 타일 기준 배율. */
  scale?: [number, number];
  color?: string;
  opacity?: number;
  /** 작을수록 앞. 0 이상은 트랙 뒤. */
  depth?: number;
  /** 0 = 월드와 함께, 1 = 화면에 고정 (x, y). */
  parallax?: [number, number];
  visible?: boolean;
  /** 글자 크기 (월드 단위). */
  fontSize?: number;
}

export interface LevelData {
  version: 1;
  meta: LevelMeta;
  settings: LevelSettings;
  path: number[];
  actions: Action[];
  decorations?: Decoration[];
}

export interface Vec2 {
  x: number;
  y: number;
}

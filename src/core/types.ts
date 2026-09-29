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
  /** 원래 위치 기준 이동량 (월드 단위, y 위쪽). null인 축은 그대로. */
  offset?: [number | null, number | null];
  rotation?: number;
  /** null인 축은 그대로. */
  scale?: [number | null, number | null];
  /** 카메라 따라가기 비율 (0~1), null인 축은 그대로. */
  parallax?: [number | null, number | null];
  /** 카메라 따라가기 기준점 이동 (월드 단위), null인 축은 그대로. */
  parallaxOffset?: [number | null, number | null];
  /** 색의 불투명도 (원작 8자리 색의 마지막 두 자리, 0~1). */
  alpha?: number;
  color?: string;
  opacity?: number;
  visible?: boolean;
  image?: string;
  /** 글자 장식의 글자 바꾸기 (원작 SetText) */
  text?: string;
  /** 입자 장식: 방출 시작·멈춤·모두 지우기 (원작 SetParticle) */
  particle?: 'start' | 'stop' | 'clear';
  /** 입자 장식: 한 번에 이만큼 뿜기 (원작 EmitParticle) */
  emit?: number;
  duration?: number;
  ease?: EaseName;
}
/** 행성 크기·공전 반지름 (원작 ScalePlanets·ScaleRadius). 1 = 기본. */
export interface PlanetsAction extends ActionBase {
  type: 'Planets';
  radius?: number;
  size?: number;
  duration?: number;
  ease?: EaseName;
}
/**
 * 화면 전체 효과 (원작 ScreenTile·ScreenScroll·HallOfMirrors·SetFrameRate).
 * tile: 화면을 가로·세로 몇 번 반복 (음수 = 뒤집기), scroll: 초당 화면 몇 개만큼 흐르기,
 * mirrors: 화면을 지우지 않아 잔상이 남음, fps: 화면을 이 초당 장면 수로 끊기 (0 = 끔).
 */
export interface ScreenAction extends ActionBase {
  type: 'Screen';
  tile?: [number, number];
  scroll?: [number, number];
  mirrors?: boolean;
  fps?: number;
  duration?: number;
  ease?: EaseName;
}
/** 소리 (원작 SetHitsound·PlaySound). hitsound: 이후 타격음 종류 ('None' = 없음), play: 이 순간 소리 하나. */
export interface SoundAction extends ActionBase {
  type: 'Sound';
  hitsound?: string;
  hitVolume?: number;
  play?: string;
  volume?: number;
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
  | MoveDecorationsAction
  | PlanetsAction
  | ScreenAction
  | SoundAction;

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
  /** 0 = 월드와 함께, 1 = 화면에 고정 (x, y). 기준 타일 위치를 중심으로 계산. */
  parallax?: [number, number];
  /** 카메라 따라가기 기준점 이동 (월드 단위). */
  parallaxOffset?: [number, number];
  /** 색의 불투명도 (0~1, 원작 8자리 색). opacity와 곱한다. */
  alpha?: number;
  /** 그림을 가로·세로 몇 번 이어 붙일지 (원작 tile). */
  tile?: [number, number];
  /** 섞는 방식: add = 더하기(원작 LinearDodge), screen = 스크린 */
  blend?: 'add' | 'screen';
  /** 카메라 회전·확대와 상관없이 화면에서 같은 방향·크기 */
  lockRotation?: boolean;
  lockScale?: boolean;
  visible?: boolean;
  /** 글자 크기 (월드 단위). */
  fontSize?: number;
  /** 도형 장식 (원작 AddObject): 행성 또는 타일 모양. 크기는 scale 1 = 실제 행성·타일 크기. */
  shape?: 'planet' | 'tile';
  /** 입자 장식 (원작 AddParticle). image가 입자 그림. */
  particle?: ParticleDef;
}

/** 입자 방출 설정. 길이는 월드 단위(TILE_LEN), 시간은 초. */
export interface ParticleDef {
  /** 초당 방출 수 [최소, 최대] */
  rate: [number, number];
  /** 입자 수명 (초) [최소, 최대] */
  lifetime: [number, number];
  /** 입자 크기 (그림 원래 크기 배율) [최소, 최대] */
  size: [number, number];
  /** 속도 (월드 단위/초) — 최소 벡터, 최대 벡터 */
  velocity: [[number, number], [number, number]];
  /** 초당 회전 (도) [최소, 최대] */
  spin?: [number, number];
  /** 방출 영역 (월드 단위, 가로·세로 전체 크기). 0이면 한 점. */
  area?: [number, number];
  /** 수명 동안 색 [시작, 끝] (#rrggbb) */
  colors?: [string, string];
  /** 수명 동안 불투명도: [시각 0~1, 값 0~1] 목록 */
  alphaKeys?: [number, number][];
  /** 레벨 시작부터 방출 */
  autoPlay?: boolean;
  /** 방출 시간 (초, 반복 아니면 이만큼 뒤 멈춤) */
  duration?: number;
  loop?: boolean;
  /** 동시에 있을 수 있는 최대 입자 수 */
  max?: number;
  /** 시간 배율 (1 = 보통) */
  speed?: number;
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

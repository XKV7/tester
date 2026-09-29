import { EASE_NAMES } from '../core/ease';
import { FILTER_NAMES } from '../core/level';
import type { Action, ActionType } from '../core/types';

export type FieldKind = 'num' | 'int' | 'color' | 'vec' | 'ease' | 'text' | 'bool' | 'choice';
export interface Field {
  k: string;
  label: string;
  kind: FieldKind;
  optional?: boolean;
  step?: number;
  /** kind='choice'의 선택지. */
  options?: string[];
}


export const ACTION_LABEL: Record<ActionType, string> = {
  SetSpeed: '속도 변경',
  Twirl: '회전 반전',
  Checkpoint: '체크포인트',
  Midspin: '미드스핀',
  Pause: '일시 공전',
  Hold: '홀드',
  Camera: '카메라',
  Flash: '플래시',
  RecolorTrack: '트랙 색 변경',
  MoveTrack: '트랙 이동',
  Background: '배경',
  Text: '안내 문구',
  Filter: '화면 필터',
  Bloom: '빛 번짐',
  Shake: '화면 흔들림',
  TrackAnim: '타일 등장·퇴장',
  MoveDecorations: '장식 움직이기',
  Planets: '행성 크기·반지름',
  Screen: '화면 반복·흐름·잔상',
  Sound: '소리',
};

export const SCHEMA: Record<ActionType, Field[]> = {
  SetSpeed: [
    { k: 'bpm', label: 'BPM', kind: 'num', optional: true },
    { k: 'multiplier', label: '배율', kind: 'num', optional: true, step: 0.25 },
  ],
  Twirl: [],
  Checkpoint: [],
  Midspin: [],
  Pause: [{ k: 'beats', label: '박', kind: 'num', step: 0.5 }],
  Hold: [{ k: 'beats', label: '박', kind: 'num', step: 0.5 }],
  Camera: [
    { k: 'relativeTo', label: '기준', kind: 'choice', optional: true, options: ['player', 'tile', 'global', 'last'] },
    { k: 'tile', label: '기준 타일', kind: 'int', optional: true },
    { k: 'zoom', label: '줌', kind: 'num', optional: true, step: 0.05 },
    { k: 'rotation', label: '회전(°)', kind: 'num', optional: true, step: 5 },
    { k: 'offset', label: '오프셋', kind: 'vec', optional: true },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Flash: [
    { k: 'color', label: '색', kind: 'color', optional: true },
    { k: 'opacity', label: '불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'endColor', label: '끝 색', kind: 'color', optional: true },
    { k: 'endOpacity', label: '끝 불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'plane', label: '면', kind: 'choice', optional: true, options: ['fg', 'bg'] },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
  ],
  RecolorTrack: [
    { k: 'from', label: '시작 타일', kind: 'int' },
    { k: 'to', label: '끝 타일', kind: 'int' },
    { k: 'color', label: '색', kind: 'color' },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'style', label: '타일 모양', kind: 'choice', optional: true, options: ['orbit', 'standard', 'neon', 'basic'] },
    { k: 'color2', label: '물결 색', kind: 'color', optional: true },
    { k: 'glowDuration', label: '물결 시간(초)', kind: 'num', optional: true, step: 0.5 },
    { k: 'pulseLength', label: '물결 길이(타일)', kind: 'num', optional: true, step: 1 },
  ],
  MoveTrack: [
    { k: 'from', label: '시작 타일', kind: 'int' },
    { k: 'to', label: '끝 타일', kind: 'int' },
    { k: 'offset', label: '오프셋', kind: 'vec', optional: true },
    { k: 'rotation', label: '회전(°)', kind: 'num', optional: true, step: 5 },
    { k: 'opacity', label: '불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'scale', label: '크기', kind: 'num', optional: true, step: 0.1 },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Background: [
    { k: 'color', label: '색', kind: 'color', optional: true },
    { k: 'image', label: '이미지 파일', kind: 'text', optional: true },
    { k: 'fit', label: '이미지 배치', kind: 'choice', optional: true, options: ['cover', 'contain', 'unscaled', 'tile'] },
    { k: 'tint', label: '이미지 색조', kind: 'color', optional: true },
    { k: 'opacity', label: '이미지 불투명도', kind: 'num', optional: true, step: 0.05 },
  ],
  Text: [{ k: 'text', label: '문구', kind: 'text' }],
  Filter: [
    { k: 'filter', label: '필터', kind: 'choice', options: FILTER_NAMES },
    { k: 'enabled', label: '켜기', kind: 'bool' },
    { k: 'intensity', label: '세기 (1=100%)', kind: 'num', optional: true, step: 0.1 },
    { k: 'exclusive', label: '다른 필터 끄기', kind: 'bool', optional: true },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'delay', label: '지연(박)', kind: 'num', optional: true, step: 0.25 },
  ],
  Bloom: [
    { k: 'enabled', label: '켜기', kind: 'bool' },
    { k: 'intensity', label: '세기', kind: 'num', optional: true, step: 0.1 },
    { k: 'threshold', label: '기준 밝기 (0~1)', kind: 'num', optional: true, step: 0.05 },
    { k: 'color', label: '색', kind: 'color', optional: true },
  ],
  Shake: [
    { k: 'duration', label: '길이(박)', kind: 'num', step: 0.5 },
    { k: 'strength', label: '세기 (1=100%)', kind: 'num', optional: true, step: 0.1 },
    { k: 'frequency', label: '초당 횟수', kind: 'num', optional: true, step: 1 },
    { k: 'fadeOut', label: '점점 약하게', kind: 'bool', optional: true },
  ],
  TrackAnim: [
    { k: 'appear', label: '나타나기', kind: 'choice', optional: true, options: ['none', 'fade', 'grow', 'extend', 'drop', 'rise', 'scatter', 'spin'] },
    { k: 'beatsAhead', label: '몇 박 전에', kind: 'num', optional: true, step: 0.5 },
    { k: 'disappear', label: '사라지기', kind: 'choice', optional: true, options: ['none', 'fade', 'shrink', 'scatter', 'retract', 'spin'] },
    { k: 'beatsBehind', label: '몇 박 뒤에', kind: 'num', optional: true, step: 0.5 },
  ],
  MoveDecorations: [
    { k: 'tag', label: '태그', kind: 'text' },
    { k: 'offset', label: '이동', kind: 'vec', optional: true },
    { k: 'rotation', label: '회전(°)', kind: 'num', optional: true, step: 5 },
    { k: 'scale', label: '크기', kind: 'vec', optional: true },
    { k: 'color', label: '색', kind: 'color', optional: true },
    { k: 'opacity', label: '불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'visible', label: '보이기', kind: 'bool', optional: true },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Planets: [
    { k: 'radius', label: '공전 반지름(배)', kind: 'num', optional: true, step: 0.1 },
    { k: 'size', label: '행성 크기(배)', kind: 'num', optional: true, step: 0.1 },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Screen: [
    { k: 'tile', label: '화면 반복', kind: 'vec', optional: true },
    { k: 'scroll', label: '흐름(화면/초)', kind: 'vec', optional: true },
    { k: 'mirrors', label: '잔상', kind: 'bool', optional: true },
    { k: 'fps', label: '끊김(장면/초, 0=끔)', kind: 'num', optional: true, step: 1 },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Sound: [
    { k: 'hitsound', label: '타격음', kind: 'choice', optional: true, options: ['Kick', 'Hat', 'Snare', 'Clap', 'Sizzle', 'Chuck', 'Hammer', 'Shaker', 'None'] },
    { k: 'hitVolume', label: '타격음 크기', kind: 'num', optional: true, step: 0.1 },
    { k: 'play', label: '지금 재생', kind: 'choice', optional: true, options: ['Kick', 'Hat', 'Snare', 'Clap', 'Sizzle', 'Chuck', 'Hammer', 'Shaker'] },
    { k: 'volume', label: '재생 크기', kind: 'num', optional: true, step: 0.1 },
  ],
};

export function defaultAction(type: ActionType, floor: number, finish: number): Action {
  const to = Math.min(finish, floor + 8);
  switch (type) {
    case 'SetSpeed':
      return { floor, type, multiplier: 2 };
    case 'Pause':
    case 'Hold':
      return { floor, type, beats: 2 };
    case 'Camera':
      return { floor, type, zoom: 1, rotation: 0, offset: [0, 0], duration: 2, ease: 'outSine' };
    case 'Flash':
      return { floor, type, color: '#ffffff', opacity: 0.6, duration: 1 };
    case 'RecolorTrack':
      return { floor, type, from: floor, to, color: '#5e3b4a', duration: 1 };
    case 'MoveTrack':
      return { floor, type, from: floor, to, offset: [0, 0], rotation: 0, opacity: 1, duration: 2, ease: 'outSine' };
    case 'Background':
      return { floor, type, color: '#0e0f16' };
    case 'Text':
      return { floor, type, text: '안내 문구' };
    case 'Filter':
      return { floor, type, filter: 'Grayscale', enabled: true, intensity: 1 };
    case 'Bloom':
      return { floor, type, enabled: true, intensity: 1, threshold: 0.3 };
    case 'Shake':
      return { floor, type, duration: 2, strength: 1, fadeOut: true };
    case 'TrackAnim':
      return { floor, type, appear: 'fade', beatsAhead: 3, disappear: 'fade', beatsBehind: 2 };
    case 'MoveDecorations':
      return { floor, type, tag: '', offset: [0, 0], duration: 1, ease: 'outSine' };
    case 'Planets':
      return { floor, type, radius: 1.5, duration: 1, ease: 'outSine' };
    case 'Screen':
      return { floor, type, tile: [2, 2], duration: 0 };
    case 'Sound':
      return { floor, type, play: 'Clap', volume: 1 };
    default:
      return { floor, type } as Action;
  }
}

export { EASE_NAMES };

import { EASE_NAMES } from '../core/ease';
import type { Action, ActionType } from '../core/types';

export type FieldKind = 'num' | 'int' | 'color' | 'vec' | 'ease' | 'text';
export interface Field {
  k: string;
  label: string;
  kind: FieldKind;
  optional?: boolean;
  step?: number;
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
    { k: 'zoom', label: '줌', kind: 'num', optional: true, step: 0.05 },
    { k: 'rotation', label: '회전(°)', kind: 'num', optional: true, step: 5 },
    { k: 'offset', label: '오프셋', kind: 'vec', optional: true },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Flash: [
    { k: 'color', label: '색', kind: 'color', optional: true },
    { k: 'opacity', label: '불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
  ],
  RecolorTrack: [
    { k: 'from', label: '시작 타일', kind: 'int' },
    { k: 'to', label: '끝 타일', kind: 'int' },
    { k: 'color', label: '색', kind: 'color' },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
  ],
  MoveTrack: [
    { k: 'from', label: '시작 타일', kind: 'int' },
    { k: 'to', label: '끝 타일', kind: 'int' },
    { k: 'offset', label: '오프셋', kind: 'vec', optional: true },
    { k: 'rotation', label: '회전(°)', kind: 'num', optional: true, step: 5 },
    { k: 'opacity', label: '불투명도', kind: 'num', optional: true, step: 0.05 },
    { k: 'duration', label: '길이(박)', kind: 'num', optional: true, step: 0.5 },
    { k: 'ease', label: '이징', kind: 'ease', optional: true },
  ],
  Background: [
    { k: 'color', label: '색', kind: 'color', optional: true },
    { k: 'image', label: '이미지 파일', kind: 'text', optional: true },
  ],
  Text: [{ k: 'text', label: '문구', kind: 'text' }],
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
    default:
      return { floor, type } as Action;
  }
}

export { EASE_NAMES };

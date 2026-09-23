import type { Action, LevelData } from '../core/types';

export interface DemoLevel {
  id: string;
  level: LevelData;
}

function base(title: string, bpm: number, difficulty: number): LevelData {
  return {
    version: 1,
    meta: { title, artist: 'ORBIT 합성 비트', author: 'ORBIT', difficulty, previewStart: 4 },
    settings: {
      songFile: '',
      bpm,
      offset: 1.0,
      pitch: 1,
      volume: 0.8,
      countdownTicks: 4,
      trackColor: '#3a3f55',
      bgColor: '#0e0f16',
      startDirection: 'CW',
    },
    path: [],
    actions: [],
  };
}

const rep = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/** 1. 튜토리얼 (100BPM, 32타일) */
function tutorial(): LevelData {
  const lv = base('튜토리얼', 100, 1);
  lv.path = [
    ...rep(10, () => 0),
    ...rep(10, (i) => (i % 2 === 0 ? 90 : 0)),
    ...[0, 0, 0, 270, 0, 270, 0, 0, 0, 0, 0],
  ];
  const acts: Action[] = [
    { floor: 0, type: 'Text', text: '박자에 맞춰 아무 키나 누르세요' },
    { floor: 10, type: 'Text', text: '꺾이는 곳은 박 길이가 달라집니다' },
    { floor: 10, type: 'Checkpoint' },
    { floor: 20, type: 'Text', text: '소용돌이: 회전 방향이 바뀝니다' },
    { floor: 20, type: 'Twirl' },
    { floor: 20, type: 'Checkpoint' },
  ];
  lv.actions = acts;
  return lv;
}

/** 2. 지그재그 (128BPM, 64타일) */
function zigzag(): LevelData {
  const lv = base('지그재그', 128, 4);
  lv.settings.trackColor = '#3b4a5e';
  const path = [
    ...rep(8, () => 0),
    ...rep(8, (i) => (i % 2 === 0 ? 90 : 0)),
    ...rep(4, () => 0),
    ...rep(8, (i) => (i % 2 === 0 ? 270 : 0)),
    ...rep(4, () => 0),
    ...rep(10, (i) => (i % 2 === 0 ? 90 : 0)),
  ];
  while (path.length < 63) path.push([45, 0, 315, 0][(path.length - 42) % 4]);
  lv.path = path;
  lv.actions = [
    { floor: 21, type: 'Checkpoint' },
    { floor: 21, type: 'RecolorTrack', from: 21, to: 41, color: '#4a3b5e', duration: 1 },
    { floor: 42, type: 'Checkpoint' },
    { floor: 42, type: 'RecolorTrack', from: 42, to: 63, color: '#3b5e52', duration: 1 },
    { floor: 42, type: 'Flash', color: '#ffffff', opacity: 0.25, duration: 1 },
  ];
  return lv;
}

/** 3. 가속 (140 → 280BPM) */
function accel(): LevelData {
  const lv = base('가속', 140, 7);
  lv.settings.trackColor = '#553a3f';
  lv.settings.bgColor = '#120d14';
  const path = [
    ...rep(8, () => 0),
    ...rep(8, (i) => (i % 2 === 0 ? 90 : 0)),
    // floor 16: ×2
    ...rep(12, () => 0),
    90,
    90,
    90,
    270, // floor 31: Midspin
    0,
    ...rep(8, (i) => (i % 2 === 0 ? 270 : 0)),
    ...rep(12, () => 0),
  ];
  lv.path = path;
  lv.actions = [
    { floor: 16, type: 'SetSpeed', multiplier: 2 },
    { floor: 16, type: 'Checkpoint' },
    { floor: 16, type: 'Camera', zoom: 0.65, duration: 4, ease: 'outSine' },
    { floor: 16, type: 'Flash', color: '#ff7a5c', opacity: 0.45, duration: 2 },
    { floor: 16, type: 'Background', color: '#1a0f18' },
    { floor: 31, type: 'Midspin' },
    { floor: 33, type: 'Checkpoint' },
    { floor: 33, type: 'Twirl' },
    { floor: 41, type: 'Twirl' },
    { floor: 41, type: 'MoveTrack', from: 42, to: path.length, offset: [0, 20], duration: 2, ease: 'outBack' },
    { floor: path.length - 4, type: 'Camera', zoom: 1, duration: 4, ease: 'inOutSine' },
  ];
  return lv;
}

export function demoLevels(): DemoLevel[] {
  return [
    { id: 'demo-tutorial', level: tutorial() },
    { id: 'demo-zigzag', level: zigzag() },
    { id: 'demo-accel', level: accel() },
  ];
}

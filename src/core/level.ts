import { isColor } from './color';
import { EASE_NAMES } from './ease';
import { sameAngle } from './math';
import type { Action, ActionType, LevelData, LevelMeta, LevelSettings } from './types';

export const ACTION_TYPES: ActionType[] = [
  'SetSpeed',
  'Twirl',
  'Checkpoint',
  'Midspin',
  'Pause',
  'Hold',
  'Camera',
  'Flash',
  'RecolorTrack',
  'MoveTrack',
  'Background',
  'Text',
];

/** 게임 진행에 영향을 주는 이벤트 (나머지는 연출). */
export const GAMEPLAY_ACTIONS: ReadonlySet<ActionType> = new Set([
  'SetSpeed',
  'Twirl',
  'Checkpoint',
  'Midspin',
  'Pause',
  'Hold',
]);

export function defaultMeta(): LevelMeta {
  return { title: '제목 없음', artist: '알 수 없음', author: '', difficulty: 1, previewStart: 0 };
}

export function defaultSettings(): LevelSettings {
  return {
    songFile: '',
    bpm: 120,
    offset: 0.5,
    pitch: 1,
    volume: 0.8,
    countdownTicks: 4,
    trackColor: '#3a3f55',
    bgColor: '#0e0f16',
    startDirection: 'CW',
  };
}

export function emptyLevel(): LevelData {
  return {
    version: 1,
    meta: defaultMeta(),
    settings: defaultSettings(),
    path: [0, 0, 0, 0],
    actions: [],
  };
}

export type ValidateResult =
  | { ok: true; level: LevelData; warnings: string[] }
  | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 레벨 JSON 검증. 누락된 선택 필드는 기본값으로 채운다.
 * 오류 메시지는 사용자에게 그대로 표시된다.
 */
export function validateLevel(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['레벨 파일의 최상위 값은 JSON 객체여야 합니다.'] };

  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(`지원하지 않는 version 값입니다: ${String(raw.version)} (1만 지원)`);
  }

  // meta
  const meta = defaultMeta();
  if (raw.meta !== undefined) {
    if (!isObj(raw.meta)) errors.push('meta는 객체여야 합니다.');
    else {
      for (const k of ['title', 'artist', 'author'] as const) {
        const v = raw.meta[k];
        if (v === undefined) continue;
        if (typeof v !== 'string') errors.push(`meta.${k}는 문자열이어야 합니다.`);
        else meta[k] = v;
      }
      if (raw.meta.difficulty !== undefined) {
        if (!isNum(raw.meta.difficulty)) errors.push('meta.difficulty는 숫자여야 합니다.');
        else meta.difficulty = Math.max(1, Math.min(10, Math.round(raw.meta.difficulty)));
      }
      if (raw.meta.previewStart !== undefined) {
        if (!isNum(raw.meta.previewStart) || raw.meta.previewStart < 0)
          errors.push('meta.previewStart는 0 이상의 숫자여야 합니다.');
        else meta.previewStart = raw.meta.previewStart;
      }
    }
  }

  // settings
  const settings = defaultSettings();
  if (!isObj(raw.settings)) {
    errors.push('settings 객체가 없습니다.');
  } else {
    const s = raw.settings;
    if (s.songFile !== undefined) {
      if (typeof s.songFile !== 'string') errors.push('settings.songFile은 문자열이어야 합니다.');
      else settings.songFile = s.songFile;
    }
    if (!isNum(s.bpm) || s.bpm <= 0 || s.bpm > 10000)
      errors.push('settings.bpm은 0보다 크고 10000 이하인 숫자여야 합니다.');
    else settings.bpm = s.bpm;
    const num = (k: 'offset' | 'pitch' | 'volume' | 'countdownTicks', lo: number, hi: number) => {
      const v = s[k];
      if (v === undefined) return;
      if (!isNum(v) || v < lo || v > hi) errors.push(`settings.${k}는 ${lo} ~ ${hi} 범위의 숫자여야 합니다.`);
      else settings[k] = v;
    };
    num('offset', -60, 3600);
    num('pitch', 0.25, 4);
    num('volume', 0, 1);
    num('countdownTicks', 0, 16);
    settings.countdownTicks = Math.round(settings.countdownTicks);
    for (const k of ['trackColor', 'bgColor'] as const) {
      if (s[k] === undefined) continue;
      if (!isColor(s[k])) errors.push(`settings.${k}는 '#rrggbb' 형식의 색이어야 합니다.`);
      else settings[k] = s[k] as string;
    }
    if (s.startDirection !== undefined) {
      if (s.startDirection !== 'CW' && s.startDirection !== 'CCW')
        errors.push("settings.startDirection은 'CW' 또는 'CCW'여야 합니다.");
      else settings.startDirection = s.startDirection;
    }
  }

  // path
  const path: number[] = [];
  if (!Array.isArray(raw.path)) errors.push('path는 각도(숫자) 배열이어야 합니다.');
  else if (raw.path.length === 0) errors.push('path에 최소 1개의 각도가 필요합니다.');
  else {
    raw.path.forEach((v, i) => {
      if (!isNum(v)) errors.push(`path[${i}]가 숫자가 아닙니다: ${JSON.stringify(v)}`);
      else path.push(v);
    });
  }
  const tileCount = path.length + 1;

  // actions
  const actions: Action[] = [];
  if (raw.actions !== undefined && !Array.isArray(raw.actions)) errors.push('actions는 배열이어야 합니다.');
  else if (Array.isArray(raw.actions)) {
    raw.actions.forEach((a, i) => {
      const where = `actions[${i}]`;
      if (!isObj(a)) {
        errors.push(`${where}는 객체여야 합니다.`);
        return;
      }
      const type = a.type as ActionType;
      if (!ACTION_TYPES.includes(type)) {
        errors.push(`${where}: 알 수 없는 이벤트 type '${String(a.type)}'`);
        return;
      }
      if (!isNum(a.floor) || !Number.isInteger(a.floor) || a.floor < 0 || a.floor >= tileCount) {
        errors.push(`${where} (${type}): floor는 0 ~ ${tileCount - 1} 범위의 정수여야 합니다.`);
        return;
      }
      const err = validateActionParams(a, type, tileCount);
      if (err) {
        errors.push(`${where} (${type}, floor ${a.floor}): ${err}`);
        return;
      }
      actions.push(a as unknown as Action);
    });
  }

  // 교차 검증
  if (errors.length === 0) {
    const bpmSeen = new Set<number>();
    for (const a of actions) {
      if (a.type === 'Midspin') {
        if (a.floor === 0 || a.floor >= path.length) {
          errors.push(`Midspin (floor ${a.floor})은 첫 타일과 도착 타일에 둘 수 없습니다.`);
        } else if (!sameAngle(path[a.floor], path[a.floor - 1] + 180)) {
          errors.push(
            `Midspin (floor ${a.floor}): path[${a.floor}]는 이전 방향의 반대(${(path[a.floor - 1] + 180) % 360}°)여야 합니다.`,
          );
        }
      }
      if (a.type === 'SetSpeed') {
        if (bpmSeen.has(a.floor)) warnings.push(`floor ${a.floor}에 SetSpeed가 여러 개 있습니다. 마지막 값이 적용됩니다.`);
        bpmSeen.add(a.floor);
      }
    }
    const midspinFloors = new Set(actions.filter((a) => a.type === 'Midspin').map((a) => a.floor));
    for (const a of actions) {
      if ((a.type === 'Hold' || a.type === 'Pause') && midspinFloors.has(a.floor))
        errors.push(`floor ${a.floor}: Midspin 타일에는 ${a.type}을 함께 둘 수 없습니다.`);
      if ((a.type === 'Hold' || a.type === 'Pause') && a.floor >= path.length)
        errors.push(`floor ${a.floor}: 도착 타일에는 ${a.type}을 둘 수 없습니다.`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, level: { version: 1, meta, settings, path, actions }, warnings };
}

function validateActionParams(a: Record<string, unknown>, type: ActionType, tileCount: number): string | null {
  const optNum = (k: string, lo = -Infinity, hi = Infinity): string | null => {
    if (a[k] === undefined) return null;
    return isNum(a[k]) && (a[k] as number) >= lo && (a[k] as number) <= hi ? null : `${k}는 ${lo}~${hi} 범위의 숫자여야 합니다.`;
  };
  const vec = (k: string): string | null => {
    if (a[k] === undefined) return null;
    const v = a[k];
    return Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]) ? null : `${k}는 [x, y] 숫자 배열이어야 합니다.`;
  };
  const easeOk = (): string | null =>
    a.ease === undefined || EASE_NAMES.includes(a.ease as never) ? null : `ease '${String(a.ease)}'를 알 수 없습니다.`;
  const range = (): string | null => {
    if (!isNum(a.from) || !isNum(a.to) || !Number.isInteger(a.from) || !Number.isInteger(a.to))
      return 'from, to는 정수 타일 번호여야 합니다.';
    if (a.from < 0 || a.to >= tileCount || a.from > a.to) return `from ≤ to 이고 0 ~ ${tileCount - 1} 범위여야 합니다.`;
    return null;
  };
  const first = (...xs: (string | null)[]) => xs.find((x) => x) ?? null;
  switch (type) {
    case 'SetSpeed':
      if (a.bpm === undefined && a.multiplier === undefined) return 'bpm 또는 multiplier가 필요합니다.';
      if (a.bpm !== undefined && (!isNum(a.bpm) || a.bpm <= 0 || a.bpm > 10000)) return 'bpm은 0보다 큰 숫자여야 합니다.';
      if (a.multiplier !== undefined && (!isNum(a.multiplier) || a.multiplier <= 0 || a.multiplier > 100))
        return 'multiplier는 0보다 큰 숫자여야 합니다.';
      return null;
    case 'Twirl':
    case 'Checkpoint':
    case 'Midspin':
      return null;
    case 'Pause':
    case 'Hold':
      return isNum(a.beats) && a.beats > 0 && a.beats <= 64 ? null : 'beats는 0보다 크고 64 이하인 숫자여야 합니다.';
    case 'Camera':
      return first(optNum('zoom', 0.05, 20), optNum('rotation'), vec('offset'), optNum('duration', 0, 1000), easeOk());
    case 'Flash':
      return first(
        a.color !== undefined && !isColor(a.color) ? 'color 형식이 잘못되었습니다.' : null,
        optNum('opacity', 0, 1),
        optNum('duration', 0, 1000),
      );
    case 'RecolorTrack':
      return first(range(), isColor(a.color) ? null : 'color가 필요합니다.', optNum('duration', 0, 1000));
    case 'MoveTrack':
      return first(range(), vec('offset'), optNum('rotation'), optNum('opacity', 0, 1), optNum('duration', 0, 1000), easeOk());
    case 'Background':
      if (a.color === undefined && a.image === undefined) return 'color 또는 image가 필요합니다.';
      if (a.color !== undefined && !isColor(a.color)) return 'color 형식이 잘못되었습니다.';
      if (a.image !== undefined && typeof a.image !== 'string') return 'image는 파일 이름 문자열이어야 합니다.';
      return null;
    case 'Text':
      return typeof a.text === 'string' ? null : 'text는 문자열이어야 합니다.';
  }
}

/** JSON 문자열 파싱 + 검증. */
export function parseLevelJson(text: string): ValidateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON 구문 오류: ${(e as Error).message}`] };
  }
  return validateLevel(raw);
}

export function serializeLevel(level: LevelData): string {
  return JSON.stringify(level, null, 2);
}

export function cloneLevel(level: LevelData): LevelData {
  return JSON.parse(JSON.stringify(level)) as LevelData;
}

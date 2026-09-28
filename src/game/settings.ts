import type { JudgeDifficulty } from '../core/judge';

export interface UserSettings {
  musicVolume: number;
  sfxVolume: number;
  difficulty: JudgeDifficulty;
  /** 입력 오프셋 (ms). 양수 = 늦게 누르는 경향 보정. */
  inputOffset: number;
  /** 화면 오프셋 (ms). 양수 = 화면을 앞당겨 그림. */
  visualOffset: number;
  reduceEffects: boolean;
  showJudgeText: boolean;
  autoHitSound: boolean;
  beatPulse: boolean;
  /** 플레이 속도 배율 (곡과 판정 시각 모두). 1이 아니면 기록은 저장하지 않는다. */
  playbackSpeed: number;
}

const KEY = 'orbit.settings.v1';
const AT_KEY = 'orbit.settings.at';
const BEST_KEY = 'orbit.best.v1';

/** 설정·기록이 바뀌면 호출 (온라인 동기화용). */
let changeHook: (() => void) | null = null;
export function onLocalChange(fn: () => void): void {
  changeHook = fn;
}

export function defaultUserSettings(): UserSettings {
  return {
    musicVolume: 0.8,
    sfxVolume: 0.7,
    difficulty: 'normal',
    inputOffset: 0,
    visualOffset: 0,
    reduceEffects: false,
    showJudgeText: true,
    autoHitSound: true,
    beatPulse: true,
    playbackSpeed: 1,
  };
}

function load(): UserSettings {
  const d = defaultUserSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...d, ...(JSON.parse(raw) as Partial<UserSettings>) };
  } catch {
    /* 저장소 사용 불가 */
  }
  return d;
}

export const settings: UserSettings = load();

export const SPEED_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

export function saveSettings(at = Date.now(), notify = true): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    localStorage.setItem(AT_KEY, String(at));
  } catch {
    /* 무시 */
  }
  if (notify) changeHook?.();
}

/** 설정을 마지막으로 바꾼 시각 (ms, 모르면 0). */
export function settingsChangedAt(): number {
  try {
    return Number(localStorage.getItem(AT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** 다른 기기에서 받은 설정 적용 (알 수 없는 키·잘못된 타입은 무시). */
export function applyRemoteSettings(remote: Record<string, unknown>, at: number): void {
  const d = defaultUserSettings() as unknown as Record<string, unknown>;
  const cur = settings as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    const v = remote[k];
    if (!(k in remote) || typeof v !== typeof d[k] || (typeof v === 'number' && !Number.isFinite(v))) continue;
    if (k === 'difficulty' && !['lenient', 'normal', 'strict'].includes(v as string)) continue;
    cur[k] = v;
  }
  saveSettings(at, false);
}

let bestCache: Record<string, number> | null = null;
function bests(): Record<string, number> {
  if (!bestCache) {
    try {
      bestCache = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, number>;
    } catch {
      bestCache = {};
    }
  }
  return bestCache;
}

export function getBest(id: string): number | null {
  return bests()[id] ?? null;
}

/** 최고 정확도 갱신. 갱신되면 true. */
export function submitBest(id: string, acc: number): boolean {
  const b = bests();
  if (b[id] !== undefined && b[id] >= acc) return false;
  b[id] = acc;
  storeBests();
  changeHook?.();
  return true;
}

function storeBests(): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(bests()));
  } catch {
    /* 무시 */
  }
}

export function allBests(): Record<string, number> {
  return { ...bests() };
}

/** 다른 기기의 기록과 합침 (레벨마다 높은 쪽). 바뀐 게 있으면 true. */
export function mergeBests(remote: Record<string, number>): boolean {
  const b = bests();
  let changed = false;
  for (const [k, v] of Object.entries(remote)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (b[k] === undefined || v > b[k]) {
      b[k] = v;
      changed = true;
    }
  }
  if (changed) storeBests();
  return changed;
}

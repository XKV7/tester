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
const BEST_KEY = 'orbit.best.v1';

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

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* 무시 */
  }
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
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* 무시 */
  }
  return true;
}

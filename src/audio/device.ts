import { audio } from './engine';

/**
 * 오디오 출력 기기별 오프셋 (원작처럼 이어폰·스피커마다 따로).
 * 웹에서는 기기 이름을 알 수 없어, 브라우저가 알려주는 출력 지연(outputLatency)으로 기기를 구분한다
 * (블루투스는 수백 ms, 폰 스피커·유선은 수십 ms). 기기마다 다르니 온라인 설정 동기화에는 넣지 않는다.
 *
 * 기기 오프셋 D(ms): 들리는 소리가 엔진 시계보다 D만큼 늦다. 판정과 화면을 함께 D만큼 늦춘다.
 */
export interface DeviceProfile {
  /** 보정할 때의 출력 지연 (ms) — 기기 구분용 */
  lat: number;
  /** 기기 오프셋 (ms) */
  offset: number;
  /** 정확도 등급 A~D */
  grade: string;
  /** 저장 시각 */
  at: number;
}

const KEY = 'orbit.devices.v1';

function load(): DeviceProfile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v.filter((p) => p && typeof p.lat === 'number' && typeof p.offset === 'number') as DeviceProfile[]) : [];
  } catch {
    return [];
  }
}

let profiles = load();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profiles));
  } catch {
    /* 저장소 사용 불가 */
  }
}

/** 지금 출력 지연 (ms). */
export function outputLatencyMs(): number {
  return Math.round(audio().outputLatency * 1000);
}

/** 같은 기기로 볼 지연 차이 */
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(25, 0.25 * Math.max(a, b));

/** 지금 출력과 맞는 보정 (없으면 null). */
export function currentProfile(lat = outputLatencyMs()): DeviceProfile | null {
  let best: DeviceProfile | null = null;
  for (const p of profiles) if (near(p.lat, lat) && (!best || Math.abs(p.lat - lat) < Math.abs(best.lat - lat))) best = p;
  return best;
}

/** 지금 출력의 기기 오프셋 (ms). 보정 안 한 기기면 0. */
export function deviceOffsetMs(): number {
  return currentProfile()?.offset ?? 0;
}

/** 지금 출력의 보정 저장 (같은 기기 보정은 덮어씀). */
export function saveDeviceProfile(offset: number, grade: string): DeviceProfile {
  const lat = outputLatencyMs();
  const old = currentProfile(lat);
  if (old) profiles = profiles.filter((p) => p !== old);
  const p: DeviceProfile = { lat, offset: Math.round(offset), grade, at: Date.now() };
  profiles.push(p);
  // 오래된 것부터 정리 (기기 8개까지)
  profiles.sort((a, b) => b.at - a.at);
  profiles = profiles.slice(0, 8);
  persist();
  return p;
}

/** 지금 출력의 기기 오프셋만 바꾸기 (플레이 중 미세조정·자동 추천). 보정이 없으면 새로 만든다. */
export function setDeviceOffset(offset: number): void {
  const p = currentProfile();
  if (p) {
    p.offset = Math.round(offset);
    p.at = Date.now();
    persist();
  } else saveDeviceProfile(offset, '-');
}

export function deviceProfiles(): readonly DeviceProfile[] {
  return profiles;
}

/** 출력 이름 (짐작): 지연이 크면 블루투스. */
export function describeOutput(lat = outputLatencyMs()): string {
  if (lat >= 100) return `블루투스 이어폰·스피커로 보이는 출력 (지연 ${lat}ms)`;
  if (lat > 0) return `폰 스피커·유선 이어폰으로 보이는 출력 (지연 ${lat}ms)`;
  return '지금 오디오 출력';
}

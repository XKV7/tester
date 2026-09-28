import { allBests, applyRemoteSettings, mergeBests, onLocalChange, settings, settingsChangedAt } from '../game/settings';
import { currentProfile, initOnline, loadUserData, saveUserData } from './cloud';
import { onlineAvailable } from './config';

/**
 * 설정·최고 기록 동기화: 로그인하면 서버 것과 합치고(설정은 더 최근에 바꾼 쪽, 기록은 레벨마다 높은 쪽),
 * 이후 이 기기에서 바뀌면 잠시 모았다가 올린다.
 */
let timer: ReturnType<typeof setTimeout> | null = null;

async function push(uid: string): Promise<void> {
  await saveUserData(uid, { settings: { ...settings }, settingsAt: settingsChangedAt(), best: allBests() });
}

export function startSync(): void {
  if (!onlineAvailable()) return;
  onLocalChange(() => {
    const p = currentProfile();
    if (!p) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void push(p.uid).catch((e) => console.warn('[ORBIT] 동기화 실패', e)), 1500);
  });
  void initOnline(async (uid) => {
    const remote = await loadUserData(uid);
    if (remote.settings && (remote.settingsAt ?? 0) > settingsChangedAt()) applyRemoteSettings(remote.settings, remote.settingsAt ?? Date.now());
    if (remote.best) mergeBests(remote.best);
    await push(uid);
  }).catch((e) => console.warn('[ORBIT] 온라인 초기화 실패', e));
}

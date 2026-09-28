import './ui/style.css';
import { audio } from './audio/engine';
import { settings } from './game/settings';
import { stage } from './render/stage';
import { library } from './levels/library';
import { initUi, show } from './ui/dom';
import { TitleScreen } from './ui/title';
import { startSync } from './online/sync';

async function main(): Promise<void> {
  await stage.init(document.getElementById('stage')!);
  initUi(document.getElementById('ui')!);
  // 모바일/자동재생 정책: 첫 사용자 입력에서 AudioContext 재개
  const unlock = () => {
    const eng = audio();
    eng.setMusicVolume(settings.musicVolume);
    eng.setSfxVolume(settings.sfxVolume);
    void eng.resume();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  // Firebase 설정이 있으면 로그인 유지·설정 동기화 (없으면 아무것도 안 함)
  startSync();
  // 함께 배포된 레벨 (public/levels) — 없으면 건너뜀
  const errs = await library.loadBundled();
  if (errs.length) console.warn('[ORBIT] 포함 레벨 불러오기:', errs.join('\n'));
  await show(new TitleScreen());
}

void main();

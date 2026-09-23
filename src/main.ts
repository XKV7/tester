import './ui/style.css';
import { audio } from './audio/engine';
import { settings } from './game/settings';
import { stage } from './render/stage';
import { initUi, show } from './ui/dom';
import { TitleScreen } from './ui/title';

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
  await show(new TitleScreen());
}

void main();

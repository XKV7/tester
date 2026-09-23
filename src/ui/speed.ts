import { saveSettings, settings, SPEED_OPTIONS } from '../game/settings';
import { h } from './dom';

/** 플레이 속도 선택 상자 (설정·레벨 선택 공용). */
export function speedSelect(onChange?: () => void): HTMLSelectElement {
  const sel = h(
    'select',
    {
      id: 'play-speed',
      onchange: () => {
        settings.playbackSpeed = Number(sel.value) || 1;
        saveSettings();
        onChange?.();
      },
    },
    ...SPEED_OPTIONS.map((v) => h('option', { value: String(v) }, v === 1 ? '×1 (기본)' : `×${v}`)),
  );
  sel.value = String(SPEED_OPTIONS.includes(settings.playbackSpeed) ? settings.playbackSpeed : 1);
  return sel;
}

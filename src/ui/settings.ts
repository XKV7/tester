import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import type { JudgeDifficulty } from '../core/judge';
import { saveSettings, settings, type UserSettings } from '../game/settings';
import { ambient } from '../render/stage';
import { CalibrateScreen } from './calibrate';
import { h, show, type Screen } from './dom';
import { speedSelect } from './speed';

/** 설정 화면. */
export class SettingsScreen implements Screen {
  constructor(private readonly back: () => Screen) {}
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') void show(this.back());
  };

  enter(root: HTMLElement): void {
    ambient(true);
    const eng = audio();
    const slider = (k: 'musicVolume' | 'sfxVolume') => {
      const val = h('span', { class: 'val' }, `${Math.round(settings[k] * 100)}%`);
      const inp = h('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: Math.round(settings[k] * 100),
        oninput: () => {
          settings[k] = Number(inp.value) / 100;
          val.textContent = `${inp.value}%`;
          eng.setMusicVolume(settings.musicVolume);
          eng.setSfxVolume(settings.sfxVolume);
          saveSettings();
        },
        onchange: () => {
          if (k === 'sfxVolume') new Sfx(eng).hit();
        },
      });
      return h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), val);
    };
    const offset = (k: 'inputOffset' | 'visualOffset') => {
      const inp = h('input', {
        type: 'number',
        step: 1,
        min: -500,
        max: 500,
        value: settings[k],
        onchange: () => {
          settings[k] = Math.max(-500, Math.min(500, Math.round(Number(inp.value) || 0)));
          inp.value = String(settings[k]);
          saveSettings();
        },
      });
      return h('div', { class: 'row' }, h('div', { style: 'width:120px' }, inp), h('span', { class: 'dim' }, 'ms'));
    };
    const toggle = (k: keyof Pick<UserSettings, 'reduceEffects' | 'showJudgeText' | 'autoHitSound' | 'beatPulse' | 'fitWide'>) =>
      h('input', {
        type: 'checkbox',
        checked: settings[k],
        onchange: (e: Event) => {
          settings[k] = (e.target as HTMLInputElement).checked;
          saveSettings();
        },
      });
    const diff = h(
      'select',
      {
        onchange: () => {
          settings.difficulty = diff.value as JudgeDifficulty;
          saveSettings();
        },
      },
      h('option', { value: 'lenient' }, '느슨함 — 완벽 ±56ms'),
      h('option', { value: 'normal' }, '보통 — 완벽 ±40ms'),
      h('option', { value: 'strict' }, '엄격 — 완벽 ±28ms'),
    );
    diff.value = settings.difficulty;

    root.append(
      h(
        'div',
        { class: 'page' },
        h(
          'div',
          { class: 'page-head' },
          h('button', { class: 'btn small', onclick: () => show(this.back()) }, '← 뒤로'),
          h('h1', null, '설정'),
        ),
        h(
          'div',
          { class: 'page-body' },
          h(
            'div',
            { class: 'form' },
            h('label', null, '음악 볼륨'),
            slider('musicVolume'),
            h('label', null, '효과음 볼륨'),
            slider('sfxVolume'),
            h('label', null, '판정 난이도'),
            diff,
            h('label', null, '플레이 속도'),
            h('label', { class: 'row' }, h('div', { style: 'width:140px' }, speedSelect()), h('span', { class: 'dim' }, '1이 아니면 기록 저장 안 함')),
            h('label', null, '입력 오프셋'),
            offset('inputOffset'),
            h('label', null, '화면 오프셋'),
            offset('visualOffset'),
            h('label', null, '오프셋 보정'),
            h(
              'div',
              null,
              h('button', { class: 'btn small cool', onclick: () => show(new CalibrateScreen(() => new SettingsScreen(this.back))) }, '보정 시작'),
            ),
            h('label', null, '자동 타격음'),
            h('label', { class: 'row' }, toggle('autoHitSound'), h('span', { class: 'dim' }, '켜면 노래 박자에 딱 맞춰 재생 (끄면 누른 순간 재생 — 휴대폰 소리 지연만큼 어긋날 수 있음). 원작 맵은 항상 켜짐')),
            h('label', null, '판정 텍스트 표시'),
            toggle('showJudgeText'),
            h('label', null, '비트 펄스'),
            toggle('beatPulse'),
            h('label', null, '원작 화면 맞춤'),
            h('label', { class: 'row' }, toggle('fitWide'), h('span', { class: 'dim' }, '원작 맵은 세로 화면에서도 원작의 가로(16:9) 화면이 다 보이게 — 끄면 크게 보이지만 양옆 장식이 잘림')),
            h('label', null, '효과 줄이기'),
            h('label', { class: 'row' }, toggle('reduceEffects'), h('span', { class: 'dim' }, '플래시·흔들림·화면 회전·잡음·글리치 끄기 (폰이 느리면 켜세요)')),
          ),
        ),
      ),
    );
    window.addEventListener('keydown', this.key);
  }

  exit(): void {
    ambient(false);
    window.removeEventListener('keydown', this.key);
  }
}

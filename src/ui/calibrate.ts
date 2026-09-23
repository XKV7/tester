import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import { saveSettings, settings } from '../game/settings';
import { ambient } from '../render/stage';
import { h, show, type Screen } from './dom';

const BPM = 120;
const TAPS = 16;
const BEAT = 60 / BPM;

/** 오프셋 보정: 메트로놈(소리) 또는 깜빡이는 원(화면)에 맞춰 16회 탭. */
export class CalibrateScreen implements Screen {
  private mode: 'audio' | 'visual' | null = null;
  private errors: number[] = [];
  private status!: HTMLElement;
  private taps!: HTMLElement;
  private result!: HTMLElement;
  private circle!: HTMLElement;
  private raf = 0;
  private readonly eng = audio();
  private readonly sfx = new Sfx(this.eng);
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      void show(this.back());
      return;
    }
    if (e.repeat || (e.target as HTMLElement).closest?.('button')) return;
    this.tap(e.timeStamp);
  };
  private pointer = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    this.tap(e.timeStamp);
  };

  constructor(private readonly back: () => Screen) {}

  enter(root: HTMLElement): void {
    ambient(true);
    this.status = h('div', { class: 'dim' }, '방식을 고르세요.');
    this.taps = h('div', { class: 'taps' }, '');
    this.result = h('div', { class: 'col', style: 'align-items:center' });
    this.circle = h('div', { class: 'calib-circle' });
    root.append(
      h(
        'div',
        { class: 'page' },
        h(
          'div',
          { class: 'page-head' },
          h('button', { class: 'btn small', onclick: () => show(this.back()) }, '← 뒤로'),
          h('h1', null, '오프셋 보정'),
        ),
        h(
          'div',
          { class: 'center-screen', style: 'position:relative;flex:1' },
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn cool', onclick: () => this.begin('audio') }, '입력 보정 (소리)'),
            h('button', { class: 'btn', onclick: () => this.begin('visual') }, '화면 보정 (깜빡임)'),
          ),
          this.circle,
          this.status,
          this.taps,
          this.result,
          h(
            'div',
            { class: 'dim', style: 'max-width:480px;text-align:center;font-size:13px' },
            `현재 입력 오프셋 ${settings.inputOffset}ms · 화면 오프셋 ${settings.visualOffset}ms. ` +
              '입력 보정은 120BPM 메트로놈 틱에, 화면 보정은 소리 없이 깜빡이는 원에 맞춰 아무 키나 16번 누르세요.',
          ),
        ),
      ),
    );
    window.addEventListener('keydown', this.key);
    window.addEventListener('pointerdown', this.pointer);
  }

  private async begin(mode: 'audio' | 'visual'): Promise<void> {
    await this.eng.resume();
    this.mode = mode;
    this.errors = [];
    this.result.innerHTML = '';
    this.eng.cancelScheduled();
    this.eng.play(null, -1, 1, 1, 0.05);
    const total = TAPS + 8;
    if (mode === 'audio') for (let k = 0; k < total; k++) this.sfx.tick(this.eng.ctxTimeForSong(k * BEAT), k % 4 === 0);
    this.status.textContent = mode === 'audio' ? '틱 소리에 맞춰 누르세요 (처음 4박은 준비)' : '원이 밝아지는 순간에 누르세요 (처음 4박은 준비)';
    this.taps.textContent = `0 / ${TAPS}`;
    cancelAnimationFrame(this.raf);
    const loop = () => {
      const t = this.eng.songTime();
      const ph = t / BEAT;
      const frac = ph - Math.floor(ph);
      this.circle.classList.toggle('on', this.mode === 'visual' && t >= 0 && frac < 0.12);
      if (this.mode) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tap(ts: number): void {
    if (!this.mode) return;
    let t = this.eng.songTimeAtPerf(ts);
    if (this.mode === 'visual') t -= settings.inputOffset / 1000;
    if (t < 4 * BEAT - BEAT / 2) return; // 준비 박
    const nearest = Math.round(t / BEAT) * BEAT;
    this.errors.push((t - nearest) * 1000);
    this.taps.textContent = `${this.errors.length} / ${TAPS}`;
    if (this.errors.length >= TAPS) this.finish();
  }

  private finish(): void {
    const mode = this.mode!;
    this.mode = null;
    this.eng.stop();
    this.eng.cancelScheduled();
    this.circle.classList.remove('on');
    // 이상치 제거: 중앙값에서 가장 먼 4개 제외 후 평균
    const med = [...this.errors].sort((a, b) => a - b)[this.errors.length >> 1];
    const kept = [...this.errors].sort((a, b) => Math.abs(a - med) - Math.abs(b - med)).slice(0, this.errors.length - 4);
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    const sd = Math.sqrt(kept.reduce((a, b) => a + (b - mean) ** 2, 0) / kept.length);
    const value = Math.round(mean);
    const key = mode === 'audio' ? 'inputOffset' : 'visualOffset';
    const label = mode === 'audio' ? '입력 오프셋' : '화면 오프셋';
    this.status.textContent = `평균 오차 ${mean.toFixed(1)}ms (편차 ±${sd.toFixed(1)}ms)`;
    this.taps.textContent = `제안 ${label}: ${value}ms`;
    this.result.innerHTML = '';
    this.result.append(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              settings[key] = value;
              saveSettings();
              this.status.textContent = `${label}을(를) ${value}ms로 적용했습니다.`;
              this.result.innerHTML = '';
            },
          },
          '적용',
        ),
        h('button', { class: 'btn', onclick: () => this.begin(mode) }, '다시 측정'),
      ),
    );
  }

  exit(): void {
    ambient(false);
    this.mode = null;
    cancelAnimationFrame(this.raf);
    this.eng.stop();
    this.eng.cancelScheduled();
    window.removeEventListener('keydown', this.key);
    window.removeEventListener('pointerdown', this.pointer);
  }
}

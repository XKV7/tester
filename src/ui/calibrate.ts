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
  private mode: 'audio' | 'visual' | 'sync' | null = null;
  /** 직접 맞추기: 행성 그림판·오프셋 표시·다음에 예약할 박 */
  private canvas: HTMLCanvasElement | null = null;
  private syncBox!: HTMLElement;
  private nextBeat = 0;
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
            h('button', { class: 'btn primary', onclick: () => this.beginSync() }, '화면·소리 직접 맞추기'),
          ),
          (this.syncBox = h('div', { class: 'col', style: 'align-items:center;gap:8px' })),
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
    this.syncBox.innerHTML = '';
    this.canvas = null;
    this.circle.style.display = '';
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

  /**
   * 직접 맞추기: 게임처럼 행성이 박마다 다음 타일에 착지하고, 착지 순간 타격음이 난다.
   * 행성이 닿는 순간과 소리가 같게 들릴 때까지 화면 오프셋을 조절한다 (바로 저장, 게임에 그대로 적용).
   */
  private async beginSync(): Promise<void> {
    await this.eng.resume();
    this.mode = 'sync';
    this.circle.style.display = 'none';
    this.errors = [];
    this.result.innerHTML = '';
    this.taps.textContent = '';
    this.eng.cancelScheduled();
    this.eng.play(null, -0.5, 1, 1, 0.05);
    this.nextBeat = 0;
    this.status.textContent = '행성이 타일에 닿는 순간과 "딱" 소리가 같게 들리도록 조절하세요.';
    const cv = h('canvas', { width: 640, height: 200, style: 'width:min(640px,92vw);height:auto;border-radius:10px;background:#0b0c14' }) as HTMLCanvasElement;
    this.canvas = cv;
    const val = h('div', { style: 'font-size:18px;font-weight:700' });
    const show = () => {
      val.textContent = `화면 오프셋 ${settings.visualOffset > 0 ? '+' : ''}${settings.visualOffset}ms`;
    };
    const step = (d: number) => {
      settings.visualOffset = Math.max(-500, Math.min(500, settings.visualOffset + d));
      saveSettings();
      show();
    };
    show();
    const btn = (label: string, d: number) => h('button', { class: 'btn small', onclick: () => step(d) }, label);
    this.syncBox.innerHTML = '';
    this.syncBox.append(
      cv,
      val,
      h('div', { class: 'row' }, btn('−20', -20), btn('−5', -5), btn('+5', 5), btn('+20', 20), h('button', { class: 'btn small', onclick: () => step(-settings.visualOffset) }, '0으로')),
      h(
        'div',
        { class: 'dim', style: 'max-width:520px;text-align:center;font-size:13px' },
        '행성이 소리보다 먼저 닿으면 −, 소리보다 늦게 닿으면 + 쪽으로. 이어폰(특히 블루투스)을 쓸 때 다시 맞추세요. 값은 바로 저장되어 모든 맵에 적용됩니다.',
      ),
    );
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (this.mode !== 'sync') return;
      const t = this.eng.songTime();
      // 타격음 예약 (게임과 같은 경로라 노래와 같은 지연)
      while (this.nextBeat * BEAT < t + 0.3) {
        if (this.nextBeat * BEAT > t - 0.02) this.sfx.hit(this.eng.ctxTimeForSong(this.nextBeat * BEAT), true);
        this.nextBeat++;
      }
      this.drawSync(t + settings.visualOffset / 1000);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** 곧게 뻗은 타일 위를 행성이 박마다 반 바퀴 돌아 다음 타일에 착지 (게임과 같은 계산). */
  private drawSync(tr: number): void {
    const cv = this.canvas;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const W = cv.width;
    const H = cv.height;
    const L = 90; // 타일 간격 (px)
    const ph = Math.max(0, tr / BEAT);
    const k = Math.floor(ph);
    const f = ph - k;
    g.clearRect(0, 0, W, H);
    // 카메라는 지금 축 타일 근처를 따라간다
    const camX = (k + f) * L;
    const cy = H / 2 + 20;
    for (let i = k - 5; i <= k + 6; i++) {
      const x = W / 2 + i * L - camX;
      const lit = i === k + 1 && f > 0.9 ? 1 : i === k && f < 0.12 ? 1 - f / 0.12 : 0;
      g.fillStyle = lit > 0 ? `rgba(255,255,255,${0.35 + 0.65 * lit})` : i <= k ? '#6e7aa8' : '#3a4166';
      g.fillRect(x - L / 2 + 3, cy - 16, L - 6, 32);
    }
    const px = W / 2 + k * L - camX;
    const ang = Math.PI * (1 - f); // 뒤쪽(왼쪽)에서 위로 돌아 앞(오른쪽) 타일에 착지
    const ox = px + L * Math.cos(ang);
    const oy = cy - L * Math.sin(ang);
    const pivotA = k % 2 === 0;
    g.fillStyle = pivotA ? '#ff8a3d' : '#3de0d0';
    g.beginPath();
    g.arc(px, cy, 13, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = pivotA ? '#3de0d0' : '#ff8a3d';
    g.beginPath();
    g.arc(ox, oy, 13, 0, Math.PI * 2);
    g.fill();
  }

  private tap(ts: number): void {
    if (!this.mode || this.mode === 'sync') return;
    let t = this.eng.songTimeAtPerf(ts);
    if (this.mode === 'visual') t -= settings.inputOffset / 1000;
    if (t < 4 * BEAT - BEAT / 2) return; // 준비 박
    const nearest = Math.round(t / BEAT) * BEAT;
    this.errors.push((t - nearest) * 1000);
    this.taps.textContent = `${this.errors.length} / ${TAPS}`;
    if (this.errors.length >= TAPS) this.finish();
  }

  private finish(): void {
    const mode = this.mode as 'audio' | 'visual';
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

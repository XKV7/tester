import { currentProfile, describeOutput, deviceOffsetMs, outputLatencyMs, saveDeviceProfile, setDeviceOffset } from '../audio/device';
import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import { saveSettings, settings } from '../game/settings';
import { ambient } from '../render/stage';
import { h, show, type Screen } from './dom';
import { offsetNudger } from './offsetUi';

// 블루투스 이어폰은 수백 ms 늦게 들리므로, 박 간격(800ms) 안에서 −150 ~ +650ms까지 잰다
const BPM = 75;
const BEAT = 60 / BPM;
const EARLY_MS = 150;
/** 끝내기 전 최소 탭 수 · 일정한지 보는 최근 탭 수 · 최대 탭 수 */
const MIN_TAPS = 12;
const WINDOW = 10;
const MAX_TAPS = 32;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 정확도 등급 (탭이 서로 얼마나 가까운지, 중앙값 절대 편차 ms) */
const grade = (mad: number) => (mad < 8 ? 'A' : mad < 15 ? 'B' : mad < 25 ? 'C' : 'D');

/**
 * 오프셋 보정 (원작 방식): 행성이 박마다 반 바퀴 돌고 드럼이 울린다. 아무 때나 드럼 박자에 맞춰 탭하면
 * 탭한 자리에 X가 찍히고, 탭이 일정해지면 알아서 끝나 지금 오디오 기기의 '기기 오프셋'으로 저장된다.
 * 기기 오프셋은 판정과 화면을 함께 옮겨서, 화면을 따로 맞출 필요가 거의 없다.
 */
export class CalibrateScreen implements Screen {
  private mode: 'tap' | 'visual' | 'check' | null = null;
  private canvas!: HTMLCanvasElement;
  private status!: HTMLElement;
  private live!: HTMLElement;
  private result!: HTMLElement;
  private nudgeBox!: HTMLElement;
  private raf = 0;
  /** 탭 오차 (ms, 엔진 시계 기준 — +면 늦게) 와 탭한 순간의 박 위치 */
  private taps: { err: number; phase: number }[] = [];
  private nextBeat = 0;
  private readonly eng = audio();
  private readonly sfx = new Sfx(this.eng);
  /** 끝난 단계에서 Enter로 넘어갈 다음 단계 */
  private next: (() => void) | null = null;
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      void show(this.back());
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab' || /^F\d+$/.test(e.key)) return;
    // 버튼에 포커스가 남아 있어도 키는 탭으로 (스페이스·엔터가 그 버튼을 다시 눌러 보정이 처음부터 시작되던 문제)
    const t = e.target as HTMLElement;
    if (t.closest?.('button')) t.blur();
    if (t.closest?.('input, select, textarea')) return;
    e.preventDefault();
    if (e.repeat) return;
    // 방향키: 미세조정 (←/→ 기기 오프셋, ↑/↓ 화면 미세 · Shift는 10ms씩)
    if (e.key.startsWith('Arrow')) {
      this.nudge(e.key, e.shiftKey ? 10 : 1);
      return;
    }
    if (e.key === 'Enter' && this.next && this.mode === null) {
      const n = this.next;
      this.next = null;
      n();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      if (this.mode !== 'tap') void this.beginTap();
      return;
    }
    this.tap(e.timeStamp);
  };
  private nudge(key: string, step: number): void {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      setDeviceOffset(Math.max(-200, Math.min(1000, deviceOffsetMs() + (key === 'ArrowRight' ? step : -step))));
    } else {
      settings.visualOffset = Math.max(-300, Math.min(450, settings.visualOffset + (key === 'ArrowUp' ? step : -step)));
      saveSettings();
    }
    this.live.textContent = `기기 오프셋 ${deviceOffsetMs()}ms · 화면 미세 ${settings.visualOffset > 0 ? '+' : ''}${settings.visualOffset}ms`;
    // 미세조정 칸이 열려 있으면 숫자도 새로
    if (this.nudgeBox.childElementCount) {
      this.nudgeBox.innerHTML = '';
      this.nudgeBox.append(offsetNudger());
    }
  }
  private pointer = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    this.tap(e.timeStamp);
  };

  constructor(private readonly back: () => Screen) {}

  enter(root: HTMLElement): void {
    ambient(true);
    this.status = h('div', { style: 'text-align:center;max-width:560px;font-size:15px' });
    this.live = h('div', { style: 'font-size:16px;font-weight:700;min-height:22px' });
    this.result = h('div', { class: 'col', style: 'align-items:center;gap:8px' });
    this.nudgeBox = h('div');
    this.canvas = h('canvas', { width: 520, height: 360, style: 'width:min(520px,92vw);height:auto' }) as HTMLCanvasElement;
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
          { class: 'center-screen', style: 'position:relative;flex:1;gap:10px' },
          this.status,
          this.canvas,
          this.live,
          this.result,
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn primary', onclick: () => this.beginTap() }, '처음부터 보정'),
            h('button', { class: 'btn', onclick: () => this.beginVisual() }, '화면만 다시'),
            h('button', { class: 'btn', onclick: () => this.beginCheck() }, '확인·미세조정'),
          ),
          this.nudgeBox,
        ),
      ),
    );
    window.addEventListener('keydown', this.key);
    window.addEventListener('pointerdown', this.pointer);
    void this.beginTap();
  }

  /** 드럼이 울리는 동안 박마다 반 바퀴 도는 행성 (보정·확인 공통). */
  private async startLoop(sound: boolean): Promise<void> {
    await this.eng.resume();
    this.eng.cancelScheduled();
    this.eng.play(null, -0.6, 1, 1, 0.05);
    this.nextBeat = 0;
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.mode) return;
      const t = this.eng.songTime();
      if (sound) {
        while (this.nextBeat * BEAT < t + 0.3) {
          if (this.nextBeat * BEAT > t - 0.02) this.sfx.hit(this.eng.ctxTimeForSong(this.nextBeat * BEAT), true, 'kick');
          this.nextBeat++;
        }
      }
      this.draw(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private async beginTap(): Promise<void> {
    this.mode = 'tap';
    this.next = null;
    this.taps = [];
    this.result.innerHTML = '';
    this.nudgeBox.innerHTML = '';
    const p = currentProfile();
    this.status.innerHTML = '';
    this.status.append(
      h('div', null, '드럼 박자에 맞춰 화면을 탭하거나 아무 키(스페이스·J·F 등)를 누르세요. 아무 때나 시작해도 되고, 행성 위치는 신경 쓰지 마세요.'),
      h('div', { class: 'dim', style: 'font-size:13px;margin-top:4px' }, `${describeOutput()} · ${p ? `저장된 기기 오프셋 ${p.offset}ms` : '이 기기는 아직 보정 전'}`),
    );
    this.live.textContent = '';
    await this.startLoop(true);
  }

  /**
   * 2단계 — 화면 맞추기: 소리 없이 행성이 위·아래 점에 닿는 순간 탭한다.
   * 드럼 탭(1단계)에는 소리 지연 + 터치 지연이, 이 탭에는 화면 지연 + 터치 지연이 들어 있어
   * 둘의 차이만큼만 화면을 늦추면 행성이 소리가 들리는 순간에 닿는다 (터치 지연 몫은 화면에서 빠진다).
   */
  private async beginVisual(): Promise<void> {
    this.mode = 'visual';
    this.next = null;
    this.taps = [];
    this.result.innerHTML = '';
    this.nudgeBox.innerHTML = '';
    this.status.innerHTML = '';
    this.status.append(
      h('div', { style: 'font-weight:700' }, '2단계 · 화면 맞추기'),
      h('div', null, '소리 없이 돌아요. 행성이 위·아래 점에 닿는 순간에 맞춰 탭하거나 키를 누르세요.'),
    );
    this.live.textContent = '';
    await this.startLoop(false);
  }

  private finishVisual(lag: number, mad: number): void {
    this.mode = null;
    cancelAnimationFrame(this.raf);
    this.eng.stop();
    this.eng.cancelScheduled();
    // 화면 미세 = 화면 쪽 지연 (게임에서 화면은 기기 오프셋 − 이 값만큼 늦춰 그린다)
    settings.visualOffset = Math.max(-300, Math.min(450, Math.round(lag)));
    saveSettings();
    const shift = deviceOffsetMs() - settings.visualOffset;
    this.draw(null);
    this.status.innerHTML = '';
    this.status.append(h('div', { style: 'font-size:18px;font-weight:700' }, mad >= 25 ? '맞췄어요 (탭이 들쭉날쭉해요 — 다시 해 보세요)' : '화면도 맞췄어요!'));
    this.live.textContent = `화면 쪽 지연 ${settings.visualOffset}밀리초 · 정확도 ${grade(mad)}`;
    this.result.innerHTML = '';
    this.result.append(
      h(
        'div',
        { class: 'dim', style: 'font-size:13px;text-align:center;max-width:520px' },
        `게임에서 화면을 소리에 맞춰 ${Math.abs(shift)}ms ${shift >= 0 ? '늦춰' : '앞당겨'} 그려요. '확인·미세조정'에서 행성이 드럼과 같이 닿는지 보세요.`,
      ),
      h('button', { class: 'btn primary', onclick: () => this.beginCheck() }, '확인하기 (Enter)'),
    );
    this.next = () => void this.beginCheck();
  }

  /** 확인: 게임처럼 판정·화면에 기기 오프셋을 적용해 보여 준다 (행성이 드럼과 함께 닿으면 성공). */
  private async beginCheck(): Promise<void> {
    this.mode = 'check';
    this.next = null;
    this.taps = [];
    this.result.innerHTML = '';
    this.status.textContent = '행성이 위·아래 점에 닿는 순간 드럼이 들리면 맞은 거예요. 어긋나 보이면 아래 버튼이나 키보드로 미세조정하세요 (←/→ 기기 오프셋, ↑/↓ 화면 미세, Shift = 10ms씩, R = 처음부터).';
    this.live.textContent = '';
    this.nudgeBox.innerHTML = '';
    this.nudgeBox.append(offsetNudger());
    await this.startLoop(true);
  }

  private tap(ts: number): void {
    if (this.mode !== 'tap' && this.mode !== 'visual') return;
    const t = this.eng.songTimeAtPerf(ts);
    if (t < 0) return;
    // 가장 가까운 박이 아니라 '조금 이르거나 많이 늦은' 쪽으로 (늦게 들리는 기기를 잴 수 있게)
    const k = Math.floor((t * 1000 + EARLY_MS) / (BEAT * 1000));
    this.taps.push({ err: (t - k * BEAT) * 1000, phase: t / BEAT });
    if (this.taps.length > MAX_TAPS) this.taps.shift();
    const recent = this.taps.slice(-WINDOW).map((x) => x.err);
    const m = median(recent);
    const mad = median(recent.map((e) => Math.abs(e - m)));
    this.live.textContent = `${Math.round(m)}밀리초`;
    // 최근 탭이 고르면 끝 (너무 오래 걸리면 최대 탭 수에서)
    if ((this.taps.length >= MIN_TAPS && mad < 25) || this.taps.length >= MAX_TAPS) {
      if (this.mode === 'visual') this.finishVisual(m, mad);
      else this.finish(m, mad);
    }
  }

  private finish(offset: number, mad: number): void {
    this.mode = null;
    cancelAnimationFrame(this.raf);
    this.eng.stop();
    this.eng.cancelScheduled();
    const g = grade(mad);
    const prev = deviceOffsetMs();
    saveDeviceProfile(offset, g);
    // 예전에 따로 맞춰 둔 입력·화면 오프셋은 기기 오프셋에 들어갔으니 0으로
    const hadFine = settings.inputOffset !== 0 || settings.visualOffset !== 0;
    settings.inputOffset = 0;
    settings.visualOffset = 0;
    saveSettings();
    this.draw(null);
    this.status.innerHTML = '';
    this.status.append(
      h('div', { style: 'font-size:18px;font-weight:700' }, g === 'D' ? '보정했어요 (탭이 들쭉날쭉해요 — 다시 해 보세요)' : '좋아요!'),
      h('div', null, `${describeOutput(outputLatencyMs())} 보정을 했어요.`),
    );
    this.live.textContent = `기기 오프셋 ${Math.round(offset)}밀리초 · 정확도 ${g} (X가 서로 가까운 정도)`;
    this.result.innerHTML = '';
    this.result.append(
      h(
        'div',
        { class: 'dim', style: 'font-size:13px;text-align:center;max-width:520px' },
        `이 값은 지금 오디오 기기(이어폰·스피커)에만 저장돼요 — 기기를 바꾸면 그 기기로 한 번 더 보정하세요. 다음부터는 기기가 바뀌면 알아서 그 기기의 값을 써요.` +
          (prev !== 0 ? ` (이전 값 ${prev}ms)` : '') +
          (hadFine ? ' 따로 맞춰 둔 입력·화면 오프셋은 0으로 되돌렸어요.' : ''),
      ),
      h('button', { class: 'btn primary', onclick: () => this.beginVisual() }, '2단계: 화면 맞추기 (소리 없음, 추천) · Enter'),
    );
    this.next = () => void this.beginVisual();
  }

  /** 행성 궤도와 탭 자리(X) 그리기. t가 null이면 결과 (X만). */
  private draw(t: number | null): void {
    const cv = this.canvas;
    const g = cv.getContext('2d');
    if (!g) return;
    const W = cv.width;
    const H = cv.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = 70;
    g.clearRect(0, 0, W, H);
    // 배경 원
    g.strokeStyle = 'rgba(200,210,255,0.25)';
    g.lineWidth = 1.5;
    for (const r of [130, 175]) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.stroke();
    }
    // 궤도 (점선) 와 박 자리 (위·아래)
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    // 박이 위(0)·아래(1)에 오도록: 각도 = 박 위치 × 180°
    const at = (phase: number) => {
      const a = -Math.PI / 2 + phase * Math.PI;
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
    };
    // 박 자리 점 (화면 맞추기·확인)
    if (this.mode === 'visual' || this.mode === 'check') {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (const ph of [0, 1]) {
        const p = at(ph);
        g.beginPath();
        g.arc(p.x, p.y, 5, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 탭 자리 X (확인 모드에서는 생략)
    if (this.mode !== 'check') {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      for (const tp of this.taps) {
        const p = at(tp.phase);
        g.beginPath();
        g.moveTo(p.x - 5, p.y - 5);
        g.lineTo(p.x + 5, p.y + 5);
        g.moveTo(p.x + 5, p.y - 5);
        g.lineTo(p.x - 5, p.y + 5);
        g.stroke();
      }
      // 탭들의 평균 방향 (원작의 기울어진 점선)
      if (this.taps.length >= 3) {
        const m = median(this.taps.slice(-WINDOW).map((x) => x.err)) / 1000 / BEAT;
        const a = -Math.PI / 2 + m * Math.PI;
        g.setLineDash([2, 6]);
        g.strokeStyle = 'rgba(255,255,255,0.6)';
        g.beginPath();
        g.moveTo(cx - 170 * Math.cos(a), cy - 170 * Math.sin(a));
        g.lineTo(cx + 170 * Math.cos(a), cy + 170 * Math.sin(a));
        g.stroke();
        g.setLineDash([]);
      }
    } else {
      // 확인: 박 자리 표시
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (const ph of [0, 1]) {
        const p = at(ph);
        g.beginPath();
        g.arc(p.x, p.y, 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 가운데 행성
    g.fillStyle = '#bfe9ff';
    g.beginPath();
    g.arc(cx, cy, 16, 0, Math.PI * 2);
    g.fill();
    if (t === null) return;
    // 도는 행성: 확인 모드는 게임처럼 기기 오프셋·화면 미세를 적용해 그린다
    const tr = this.mode === 'check' ? t + (settings.visualOffset - deviceOffsetMs()) / 1000 : t;
    const p = at(Math.max(0, tr) / BEAT);
    g.fillStyle = '#ff5a5a';
    g.beginPath();
    g.arc(p.x, p.y, 15, 0, Math.PI * 2);
    g.fill();
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

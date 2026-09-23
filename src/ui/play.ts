import { JUDGE_LABEL, type Judgment } from '../core/judge';
import { Game, type GameHud, type GameResult } from '../game/game';
import { settings, submitBest } from '../game/settings';
import type { LevelPackage } from '../levels/package';
import { ambient } from '../render/stage';
import { alertBox, h, show, type Screen } from './dom';

export interface PlayOptions {
  autoplay?: boolean;
  startFloor?: number;
  /** 나가기/목록 버튼이 돌아갈 화면. */
  back: () => Screen;
  /** 에디터 플레이테스트면 결과 화면 없이 바로 복귀. */
  editorTest?: boolean;
}

/** 게임 화면 (HUD, 일시정지, 실패 안내) + 결과 화면. */
export class PlayScreen implements Screen, GameHud {
  private game: Game | null = null;
  private prog!: HTMLDivElement;
  private acc!: HTMLDivElement;
  private count!: HTMLDivElement;
  private failEl!: HTMLDivElement;
  private failMsg!: HTMLParagraphElement;
  private pauseEl: HTMLDivElement | null = null;
  private root!: HTMLElement;
  private lastAcc = '';
  private lastProg = -1;
  private lastCount: string | null = '';

  constructor(
    private readonly pkg: LevelPackage,
    private readonly opts: PlayOptions,
  ) {}

  async enter(root: HTMLElement): Promise<void> {
    this.root = root;
    root.className = 'passthrough';
    this.prog = h('div');
    this.acc = h('div', { class: 'acc' }, '100.00%');
    this.count = h('div', { class: 'count' });
    this.failMsg = h('p');
    this.failEl = h(
      'div',
      { class: 'fail' },
      h('h2', null, '실패'),
      this.failMsg,
      h('p', null, '아무 키나 누르면 다시 시작 · Esc 나가기'),
    );
    root.append(
      h(
        'div',
        { class: 'hud' },
        h('div', { class: 'tl' }, h('div', { class: 'progress' }, this.prog), this.acc),
        h(
          'div',
          { class: 'tr' },
          h('button', { class: 'btn small', onclick: () => this.game?.pause(), title: '일시정지 (Esc)' }, '❚❚'),
        ),
        this.count,
        this.failEl,
        this.opts.autoplay || settings.playbackSpeed !== 1
          ? h('div', { class: 'auto-badge' }, [this.opts.autoplay ? '자동 플레이' : '', settings.playbackSpeed !== 1 ? `속도 ×${settings.playbackSpeed}` : ''].filter(Boolean).join(' · '))
          : null,
        this.opts.editorTest ? h('div', { class: 'auto-badge', style: 'left:auto;right:16px' }, '플레이테스트 · Esc로 에디터 복귀') : null,
      ),
    );
    this.game = new Game({
      pkg: this.pkg,
      hud: this,
      autoplay: this.opts.autoplay,
      startFloor: this.opts.startFloor,
      onClear: (r) => this.onClear(r),
      onQuit: () => void show(this.opts.back()),
    });
    try {
      await this.game.start();
    } catch (e) {
      await alertBox('레벨을 시작할 수 없습니다', [(e as Error).message]);
      void show(this.opts.back());
    }
  }

  exit(): void {
    this.game?.destroy();
    this.game = null;
  }

  // ── GameHud ──
  setProgress(p: number): void {
    const v = Math.round(p * 1000);
    if (v === this.lastProg) return;
    this.lastProg = v;
    this.prog.style.width = `${(p * 100).toFixed(1)}%`;
  }
  setAccuracy(a: number): void {
    const s = `${a.toFixed(2)}%`;
    if (s === this.lastAcc) return;
    this.lastAcc = s;
    this.acc.textContent = s;
  }
  setCountdown(text: string | null): void {
    if (text === this.lastCount) return;
    this.lastCount = text;
    this.count.textContent = text ?? '';
  }
  showFail(reason: string | null): void {
    this.failEl.classList.toggle('on', reason !== null);
    if (reason) {
      this.failMsg.textContent = reason;
      this.failEl.style.opacity = '0';
      setTimeout(() => (this.failEl.style.opacity = ''), 800);
    }
  }
  setPaused(p: boolean): void {
    this.pauseEl?.remove();
    this.pauseEl = null;
    if (!p) return;
    const g = this.game!;
    this.pauseEl = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'box' },
        h('h2', null, '일시정지'),
        h('button', { class: 'btn primary', onclick: () => g.resume() }, '계속'),
        h('button', { class: 'btn', onclick: () => (g.pause(), g.restart(true), this.setPaused(false)) }, '처음부터 다시 시작'),
        h('button', { class: 'btn', onclick: () => g.quit() }, this.opts.editorTest ? '에디터로' : '나가기'),
      ),
    );
    this.root.append(this.pauseEl);
    (this.pauseEl.querySelector('button') as HTMLButtonElement).focus();
  }
  setResumeCountdown(n: number | null): void {
    this.setCountdown(n === null ? null : String(n));
  }

  // ── 결과 ──
  private onClear(r: GameResult): void {
    if (this.opts.editorTest) {
      void show(this.opts.back());
      return;
    }
    const newBest = !r.autoplay && r.speed === 1 && submitBest(this.pkg.id, r.accuracy);
    void show(new ResultScreen(this.pkg, r, newBest, this.opts));
  }
}

const ORDER: Judgment[] = ['perfect', 'earlyPerfect', 'latePerfect', 'early', 'late', 'tooEarly'];

export class ResultScreen implements Screen {
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') void show(this.opts.back());
    else if (e.key === 'Enter' || e.key === 'r' || e.key === 'R') this.retry();
  };
  constructor(
    private readonly pkg: LevelPackage,
    private readonly r: GameResult,
    private readonly newBest: boolean,
    private readonly opts: PlayOptions,
  ) {}

  private retry(): void {
    void show(new PlayScreen(this.pkg, this.opts));
  }

  enter(root: HTMLElement): void {
    ambient(true);
    const r = this.r;
    root.append(
      h(
        'div',
        { class: 'page' },
        h('div', { class: 'page-head' }, h('h1', null, `클리어 — ${this.pkg.level.meta.title}`)),
        h(
          'div',
          { class: 'page-body' },
          h(
            'div',
            { class: 'results' },
            h('div', { class: 'big' }, `${r.accuracy.toFixed(2)}%`),
            h(
              'div',
              { class: 'badges' },
              r.allPerfect && !r.autoplay ? h('span', { class: 'badge perfect' }, '완벽 클리어') : null,
              r.flawless && !r.autoplay ? h('span', { class: 'badge flawless' }, '무결점 클리어') : null,
              this.newBest ? h('span', { class: 'badge newbest' }, '최고 기록!') : null,
              r.speed !== 1 ? h('span', { class: 'badge newbest', style: 'color:var(--dim);border-color:var(--line)' }, `속도 ×${r.speed} (기록 안 됨)`) : null,
              r.autoplay ? h('span', { class: 'badge newbest', style: 'color:var(--dim);border-color:var(--line)' }, '자동 플레이 (기록 안 됨)') : null,
            ),
            h(
              'table',
              null,
              ...ORDER.map((j) => h('tr', null, h('td', null, JUDGE_LABEL[j]), h('td', null, String(r.counts[j])))),
              h('tr', null, h('td', null, '최대 연속 완벽'), h('td', null, String(r.maxStreak))),
              h('tr', null, h('td', null, '체크포인트 사용'), h('td', null, String(r.checkpointUses))),
              h('tr', null, h('td', null, '판정 난이도'), h('td', null, { lenient: '느슨함', normal: '보통', strict: '엄격' }[settings.difficulty])),
            ),
            h(
              'div',
              { class: 'row end' },
              h('button', { class: 'btn', onclick: () => show(this.opts.back()) }, '목록'),
              h('button', { class: 'btn primary', onclick: () => this.retry() }, '재시도'),
            ),
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

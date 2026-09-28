import { beatMs, beatPhaseAt, compileChart, orbiterAngle, resumeTime, type Chart } from '../core/chart';
import { advances, DIFFICULTY_MULT, JUDGE_COLOR, JUDGE_LABEL, judgeError, judgeWindows, OverloadTracker, type Judgment } from '../core/judge';
import { TILE_LEN } from '../core/math';
import { PlayStats } from '../core/stats';
import { VisualTimeline } from '../core/timeline';
import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import { fileUrl, loadPackageAudio, type LevelPackage } from '../levels/package';
import { FxView } from '../render/fx';
import { COLOR_A, COLOR_B, PlanetsView } from '../render/planets';
import { stage } from '../render/stage';
import { TrackView } from '../render/track';
import { InputCollector, type InputEvent } from './input';
import { settings } from './settings';

export type GameState = 'loading' | 'playing' | 'paused' | 'failed' | 'cleared';

export interface GameResult {
  accuracy: number;
  counts: ReturnType<PlayStats['counts']>;
  maxStreak: number;
  checkpointUses: number;
  allPerfect: boolean;
  flawless: boolean;
  autoplay: boolean;
  /** 플레이 속도 배율. */
  speed: number;
}

/** 게임 화면이 구현하는 HUD. */
export interface GameHud {
  setProgress(p: number): void;
  setAccuracy(a: number): void;
  setCountdown(text: string | null): void;
  showFail(reason: string | null): void;
  setPaused(p: boolean): void;
  setResumeCountdown(n: number | null): void;
}

export interface GameOptions {
  pkg: LevelPackage;
  hud: GameHud;
  startFloor?: number;
  autoplay?: boolean;
  onClear: (r: GameResult) => void;
  onQuit: () => void;
}

interface Hold {
  floor: number;
  start: number;
  release: number;
}

const FAIL_LABEL = {
  miss: '놓침',
  overload: '과부하 — 너무 빠르게 연타했습니다',
  holdEarly: '홀드를 너무 일찍 뗐습니다',
  holdLate: '홀드를 너무 늦게 뗐습니다',
} as const;
type FailReason = keyof typeof FAIL_LABEL;

export class Game {
  readonly chart: Chart;
  readonly timeline: VisualTimeline;
  readonly stats = new PlayStats();
  state: GameState = 'loading';
  autoplay: boolean;
  readonly speed: number;

  private readonly eng = audio();
  private readonly sfx = new Sfx(this.eng);
  private readonly input = new InputCollector();
  private readonly overload = new OverloadTracker();
  private track!: TrackView;
  private planets!: PlanetsView;
  private fx!: FxView;
  private buffer: AudioBuffer | null = null;

  /** 현재 축 타일. */
  private cur = 0;
  private startFloor: number;
  private lastCheckpoint = -1;
  private hold: Hold | null = null;
  private held = new Set<string>();
  private schedIdx = 0;
  private beginFloor = 0;
  private failAt = 0;
  private clearAt = 0;
  private resumeAt = 0;
  private orbiterPos = { x: 0, y: 0 };
  private tickerFn = () => this.frame();
  private visHandler = () => {
    if (document.hidden && this.state === 'playing') this.pause();
  };

  constructor(private readonly opts: GameOptions) {
    this.chart = compileChart(opts.pkg.level);
    this.timeline = new VisualTimeline(this.chart);
    this.autoplay = !!opts.autoplay;
    this.speed = settings.playbackSpeed > 0 ? settings.playbackSpeed : 1;
    this.pitch = this.chart.level.settings.pitch * this.speed;
    this.startFloor = Math.max(0, Math.min(opts.startFloor ?? 0, this.chart.finish - 1));
  }

  /** 곡 재생 배율 = 레벨 pitch × 플레이 속도 (게임 중에는 고정). */
  private readonly pitch: number;
  private get mult(): number {
    return DIFFICULTY_MULT[settings.difficulty];
  }

  async start(): Promise<void> {
    this.buffer = await loadPackageAudio(this.opts.pkg);
    await this.eng.resume();
    this.track = new TrackView(this.chart, this.timeline);
    this.planets = new PlanetsView();
    this.fx = new FxView();
    stage.clearWorld();
    stage.world.addChild(this.track.container, this.planets.container, this.fx.container);
    this.input.onEscape = () => this.togglePause();
    this.input.attach();
    document.addEventListener('visibilitychange', this.visHandler);
    stage.app.ticker.add(this.tickerFn);
    this.eng.setMusicVolume(settings.musicVolume);
    this.eng.setSfxVolume(settings.sfxVolume);
    this.begin(this.startFloor, false);
  }

  destroy(): void {
    stage.app.ticker.remove(this.tickerFn);
    document.removeEventListener('visibilitychange', this.visHandler);
    this.input.detach();
    this.eng.stop();
    this.eng.cancelScheduled();
    if (this.eng.ctx.state === 'suspended') void this.eng.ctx.resume();
    stage.clearWorld();
    this.track?.destroy();
    this.planets?.container.destroy({ children: true });
    this.fx?.container.destroy({ children: true });
    stage.setBackgroundImage(null);
  }

  /** floor에서 시작 (체크포인트 재개면 2박 전부터). */
  private begin(floor: number, resume: boolean): void {
    const ch = this.chart;
    if (this.eng.ctx.state === 'suspended') void this.eng.ctx.resume();
    this.resumeAt = 0;
    this.cur = floor;
    this.beginFloor = floor;
    this.hold = null;
    this.held.clear();
    this.input.clear();
    this.overload.reset();
    this.fx.clear();
    this.opts.hud.showFail(null);
    this.planets.setVisible(true);
    this.planets.setAlpha(1, 1);

    const tile = ch.tiles[floor];
    const prevBpm = ch.tiles[Math.max(0, floor - 1)].bpm;
    let songStart: number;
    const ticks: number[] = [];
    if (floor === 0 && !resume) {
      const n = ch.level.settings.countdownTicks;
      const beat = 60 / tile.bpm;
      for (let k = n; k >= 1; k--) ticks.push(tile.time - k * beat);
      songStart = Math.min(0, tile.time - (n + 0.5) * beat);
    } else {
      const beat = 60 / prevBpm;
      songStart = resumeTime(ch, floor, 2) - 0.5 * beat;
      ticks.push(tile.time - 2 * beat, tile.time - beat);
    }
    this.eng.cancelScheduled();
    this.eng.play(this.buffer, songStart, this.pitch, ch.level.settings.volume, 0.15);
    for (const tt of ticks) this.sfx.tick(this.eng.ctxTimeForSong(tt), tt === ticks[ticks.length - 1]);
    this.schedIdx = floor + 1;
    this.timeline.reset();
    this.timeline.update(songStart);
    const p = this.track.pos(floor);
    stage.camera.snap(p.x, p.y, this.timeline.camera.zoom, this.timeline.camera.rotation);
    this.state = 'playing';
  }

  private togglePause(): void {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'failed' || this.state === 'cleared') this.opts.onQuit();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.resumeAt = 0;
    void this.eng.ctx.suspend();
    this.opts.hud.setPaused(true);
  }

  /** 일시정지 해제: 3박자 카운트다운 후 재개. */
  resume(): void {
    if (this.state !== 'paused' || this.resumeAt) return;
    this.opts.hud.setPaused(false);
    this.resumeAt = performance.now() + 1500;
  }

  quit(): void {
    this.opts.onQuit();
  }

  /** 실패 후 재시작 (가장 최근 체크포인트). */
  restart(fromStart = false): void {
    this.eng.stop();
    if (!fromStart && this.lastCheckpoint > this.startFloor) {
      this.stats.truncateAfter(this.lastCheckpoint);
      this.stats.checkpointUses++;
      this.begin(this.lastCheckpoint, true);
    } else {
      this.stats.reset();
      this.lastCheckpoint = -1;
      this.begin(this.startFloor, this.startFloor > 0);
    }
  }

  // ───────────────────────── 판정 ─────────────────────────

  private windowsFor(floor: number) {
    const tiles = this.chart.tiles;
    const cur = tiles[floor].duration;
    const next = tiles[floor + 1]?.duration ?? 0;
    // 앞뒤 음표 간격의 절반 (실제 ms)
    const gap = Math.min(cur, next > 0 ? next : cur) / this.pitch;
    return judgeWindows(beatMs(tiles[floor], this.pitch), this.mult, gap * 500);
  }

  /** 입력의 판정용 곡 시각. */
  private judgeTime(perf: number): number {
    return this.eng.songTimeAtPerf(perf) - (settings.inputOffset / 1000) * this.pitch;
  }

  private handleInput(ev: InputEvent): void {
    if (ev.kind === 'up') {
      this.held.delete(ev.id);
      if (this.state === 'playing' && this.hold && this.held.size === 0 && !this.autoplay) {
        this.judgeRelease(this.judgeTime(ev.ts));
      }
      return;
    }
    this.held.add(ev.id);
    if (this.state === 'failed') {
      if (performance.now() - this.failAt > 800) this.restart();
      return;
    }
    if (this.state !== 'playing' || this.autoplay || this.hold) return;
    if (this.cur >= this.chart.finish) return;
    const ti = this.judgeTime(ev.ts);
    const tile = this.chart.tiles[this.cur];
    const target = this.chart.times[this.cur + 1];
    const e = ((ti - target) / this.pitch) * 1000;
    const w = this.windowsFor(this.cur);
    const tooEarlyLimit = ((tile.duration / this.pitch) * 1000) / 2;
    const j = judgeError(e, w, tooEarlyLimit);
    if (j === null) return;
    if (j === 'tooEarly') {
      this.stats.recordTooEarly(this.cur + 1);
      this.showJudge(this.cur + 1, j);
      if (this.overload.push(ev.ts / 1000)) this.fail('overload');
      return;
    }
    if (j === 'miss') {
      this.fail('miss');
      return;
    }
    this.advance(j);
  }

  private advance(j: Judgment): void {
    this.cur++;
    this.stats.recordHit(this.cur, j);
    this.showJudge(this.cur, j);
    if (!settings.autoHitSound) this.sfx.hit();
    this.onArrive();
  }

  /** 타일 도착 처리 (체크포인트, 홀드, midspin, 클리어). */
  private onArrive(): void {
    const ch = this.chart;
    const now = performance.now();
    this.track.pulseTile(this.cur, now);
    const tile = ch.tiles[this.cur];
    if (tile.checkpoint) this.lastCheckpoint = this.cur;
    if (this.cur >= ch.finish) {
      this.clear();
      return;
    }
    if (tile.holdBeats > 0) {
      this.hold = { floor: this.cur, start: tile.time, release: tile.time + (tile.holdBeats * 60) / tile.bpm };
      if (!this.autoplay && this.held.size === 0) this.judgeRelease(this.hold.start);
      return;
    }
    if (tile.midspin) {
      // 같은 입력으로 즉시 통과
      this.cur++;
      this.track.pulseTile(this.cur, now);
      this.onArrive();
    }
  }

  private judgeRelease(ti: number): void {
    const h = this.hold;
    if (!h) return;
    const e = ((ti - h.release) / this.pitch) * 1000;
    const w = this.windowsFor(h.floor);
    const j = judgeError(e, w, Infinity);
    if (j === null || j === 'tooEarly') {
      this.fail('holdEarly');
      return;
    }
    if (j === 'miss') {
      this.fail('holdLate');
      return;
    }
    this.hold = null;
    this.stats.recordRelease(h.floor, j);
    this.showJudge(h.floor, j);
  }

  private showJudge(floor: number, j: Judgment): void {
    const now = performance.now();
    const p = this.track.pos(floor);
    if (advances(j) && !settings.reduceEffects) this.fx.ring(p.x, p.y, JUDGE_COLOR[j], now);
    if (settings.showJudgeText) this.fx.text(JUDGE_LABEL[j], JUDGE_COLOR[j], p.x, p.y, now);
  }

  private fail(reason: FailReason): void {
    if (this.state !== 'playing') return;
    this.state = 'failed';
    this.failAt = performance.now();
    this.stats.fails++;
    this.hold = null;
    this.eng.cancelScheduled();
    this.eng.stop(true);
    this.sfx.fail();
    const aIsPivot = this.cur % 2 === 0;
    this.fx.explode(this.orbiterPos.x, this.orbiterPos.y, aIsPivot ? COLOR_B : COLOR_A, this.failAt);
    this.planets.setAlpha(aIsPivot ? 1 : 0, aIsPivot ? 0 : 1);
    this.planets.clearTail();
    this.opts.hud.showFail(FAIL_LABEL[reason]);
  }

  private clear(): void {
    this.state = 'cleared';
    this.clearAt = performance.now();
    this.hold = null;
    this.sfx.clear();
    const p = this.track.pos(this.chart.finish);
    if (!settings.reduceEffects) this.fx.explode(p.x, p.y, 0xffffff, this.clearAt, 48);
  }

  private result(): GameResult {
    return {
      accuracy: this.stats.accuracy(),
      counts: this.stats.counts(),
      maxStreak: this.stats.maxStreak,
      checkpointUses: this.stats.checkpointUses,
      allPerfect: this.stats.isAllPerfect() && this.speed >= 1,
      flawless: this.stats.isFlawless() && this.startFloor === 0 && this.speed >= 1,
      autoplay: this.autoplay,
      speed: this.speed,
    };
  }

  // ───────────────────────── 프레임 ─────────────────────────

  private frame(): void {
    const now = performance.now();
    const ch = this.chart;
    const hud = this.opts.hud;

    if (this.state === 'paused' && this.resumeAt) {
      const left = this.resumeAt - now;
      hud.setResumeCountdown(left > 0 ? Math.ceil(left / 500) : null);
      if (left <= 0) {
        this.resumeAt = 0;
        this.input.clear();
        void this.eng.ctx.resume();
        this.state = 'playing';
      }
    }

    // 입력 먼저 처리 (재시작 시 클럭이 바뀌므로 곡 시각은 그 뒤에 읽는다)
    for (const ev of this.input.drain()) this.handleInput(ev);

    const t = this.eng.songTime(now);
    const tj = t - (settings.inputOffset / 1000) * this.pitch;
    const tr = t + (settings.visualOffset / 1000) * this.pitch;

    if (this.state === 'playing') {
      // 자동 플레이
      if (this.autoplay) {
        if (this.hold && tj >= this.hold.release) this.judgeRelease(this.hold.release);
        while (this.state === 'playing' && !this.hold && this.cur < ch.finish && tj >= ch.times[this.cur + 1]) {
          this.advance('perfect');
          const h = this.hold as Hold | null;
          if (h && tj >= h.release) this.judgeRelease(h.release);
        }
      }
      // 홀드 떼기 시간 초과
      if (this.state === 'playing' && this.hold && !this.autoplay) {
        const w = this.windowsFor(this.hold.floor);
        if (tj > this.hold.release + ((w.grace ?? w.far) / 1000) * this.pitch) this.fail('holdLate');
      }
      // 놓침
      if (this.state === 'playing' && !this.hold && this.cur < ch.finish) {
        const w = this.windowsFor(this.cur);
        if (tj > ch.times[this.cur + 1] + ((w.grace ?? w.far) / 1000) * this.pitch) this.fail('miss');
      }
      // 자동 타격음 예약
      if (settings.autoHitSound && this.state === 'playing') {
        while (this.schedIdx <= ch.finish && ch.times[this.schedIdx] < t + 0.35) {
          const i = this.schedIdx++;
          if (i > 0 && ch.times[i] === ch.times[i - 1] && i - 1 > this.beginFloor) continue;
          if (ch.times[i] > t - 0.01) this.sfx.hit(this.eng.ctxTimeForSong(ch.times[i]), true);
        }
      }
    }

    // ── 렌더 ──
    this.timeline.update(tr);
    const tl = this.timeline;
    const reduce = settings.reduceEffects;
    stage.setBackground(tl.bgColor);
    stage.setBackgroundImage(tl.bgImage ? fileUrl(this.opts.pkg, tl.bgImage) : null);

    const tile = ch.tiles[this.cur];
    const pivot = this.track.pos(this.cur);
    const angle = orbiterAngle(tile, tr);
    const tail: number[] = [];
    for (let k = 1; k <= 8; k++) {
      const tt = tr - (k * 0.15) / 8;
      if (tt < tile.time - 0.01) break;
      tail.push(orbiterAngle(tile, tt));
    }
    const holdProgress = this.hold ? (tr - this.hold.start) / (this.hold.release - this.hold.start) : null;
    const aIsPivot = this.cur % 2 === 0;
    if (this.state !== 'failed') {
      this.orbiterPos = this.planets.update(pivot, angle, TILE_LEN, this.state === 'cleared' ? [] : tail, aIsPivot, holdProgress);
    }

    const cam = tl.camera;
    stage.camera.follow(pivot.x + cam.ox, pivot.y - cam.oy, cam.zoom, reduce ? 0 : cam.rotation, stage.tick());
    const phase = beatPhaseAt(ch, tr);
    const frac = phase - Math.floor(phase);
    const pulse = settings.beatPulse && !reduce && this.state === 'playing' ? Math.exp(-frac * 6) : 0;
    this.track.update({ passed: this.cur, pulse, now, view: stage.viewRect() });
    this.track.uprightTexts((stage.camera.rotation * Math.PI) / 180);
    this.fx.rotation = (stage.camera.rotation * Math.PI) / 180;
    this.fx.update(now);
    stage.frame(tl.flashColor, reduce ? 0 : tl.flashAlpha);

    // HUD
    hud.setProgress(ch.finish > 0 ? this.cur / ch.finish : 1);
    hud.setAccuracy(this.stats.accuracy());
    const target = ch.tiles[this.beginFloor];
    const beat = 60 / ch.tiles[Math.max(0, this.beginFloor - 1)].bpm;
    const left = (target.time - tr) / beat;
    hud.setCountdown(this.state === 'playing' && left > 0 && left <= 3 ? String(Math.ceil(left)) : null);

    if (this.state === 'cleared' && now - this.clearAt > 1500) {
      this.state = 'loading';
      this.eng.stop();
      this.opts.onClear(this.result());
    }
  }
}

import { beatMs, beatPhaseAt, compileChart, orbiterAngle, resumeTime, type Chart } from '../core/chart';
import { advances, DIFFICULTY_MULT, JUDGE_COLOR, JUDGE_LABEL, judgeError, judgeWindows, MIN_FAR_MS, OverloadTracker, type Judgment } from '../core/judge';
import { TILE_LEN } from '../core/math';
import { PlayStats } from '../core/stats';
import { cameraCenter, VisualTimeline } from '../core/timeline';
import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import { fileUrl, loadPackageAudio, type LevelPackage } from '../levels/package';
import { DecorationView } from '../render/decorations';
import { FxView } from '../render/fx';
import { ScreenFx } from '../render/screenfx';
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
  private deco!: DecorationView;
  private screenFx!: ScreenFx;
  private buffer: AudioBuffer | null = null;

  /** 현재 축 타일. */
  private cur = 0;
  private startFloor: number;
  private lastCheckpoint = -1;
  private hold: Hold | null = null;
  private held = new Set<string>();
  private schedIdx = 0;
  /** 타일별 타격음 (원작 SetHitsound): 종류 (null = 기본 소리, 'None' = 없음)·크기 */
  private hitKind: (string | null)[] = [];
  private hitVol: Float32Array = new Float32Array(0);
  /** 원작 PlaySound: 곡 시각 순 */
  private plays: { time: number; sound: string; volume: number }[] = [];
  private playIdx = 0;
  /** 일시정지한 곡 시각 (일시정지 중·재개 카운트다운 동안 화면은 이 시각에 멈춘다) */
  private pausedSong: number | null = null;
  private beginFloor = 0;
  private failAt = 0;
  private clearAt = 0;
  private resumeAt = 0;
  private orbiterPos = { x: 0, y: 0 };
  /** 카메라가 따라가는 행성 위치 (화면 좌표) — 이것만 부드럽게 따라가고, 오프셋·줌·회전·타일 기준은 원작 이징 그대로. */
  private camPivot = { x: 0, y: 0 };
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
    // 타격음 바꾸기는 타일 기준, 소리 재생은 시각 기준
    const n = this.chart.tiles.length;
    this.hitKind = new Array(n).fill(null);
    this.hitVol = new Float32Array(n).fill(1);
    const sets = this.chart.level.actions.filter((a) => a.type === 'Sound' && (a.hitsound !== undefined || a.hitVolume !== undefined)).sort((a, b) => a.floor - b.floor);
    let kind: string | null = null;
    let vol = 1;
    let si = 0;
    for (let i = 0; i < n; i++) {
      while (si < sets.length && sets[si].floor <= i) {
        const a = sets[si++];
        if (a.type !== 'Sound') continue;
        if (a.hitsound !== undefined) kind = a.hitsound;
        if (a.hitVolume !== undefined) vol = a.hitVolume;
      }
      this.hitKind[i] = kind;
      this.hitVol[i] = vol;
    }
    this.plays = this.chart.visual
      .filter((v) => v.action.type === 'Sound' && !!v.action.play)
      .map((v) => ({ time: v.time, sound: (v.action as { play: string }).play, volume: (v.action as { volume?: number }).volume ?? 1 }))
      .sort((a, b) => a.time - b.time);
  }

  /** 타격음을 박자에 맞춰 미리 예약하는지 (원작에서 불러온 맵은 원작처럼 항상). */
  private get scheduledHits(): boolean {
    return settings.autoHitSound || this.opts.pkg.imported === 'adofai';
  }

  /** 타일 i의 타격음 (when = ctx 시각). */
  private hitSound(i: number, when?: number, scheduled = false): void {
    const k = this.hitKind[i] ?? null;
    if (k === 'None') return;
    const v = this.hitVol[i] ?? 1;
    if (v <= 0) return;
    this.sfx.hit(when, scheduled, k, v);
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
    this.deco = new DecorationView(this.chart, this.timeline, (name) => fileUrl(this.opts.pkg, name));
    this.screenFx = new ScreenFx();
    stage.clearWorld();
    stage.world.addChild(this.deco.behind, this.track.container, this.planets.container, this.deco.front, this.fx.container);
    stage.screenLayer.addChild(this.screenFx.weather);
    // 카메라가 따라가는 행성 위치 (월드, y 위쪽) — '직전 위치 기준' 카메라가 지금 중심을 계산할 때 쓴다
    this.timeline.playerPos = () => ({ x: this.camPivot.x, y: -this.camPivot.y });
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
    this.deco?.destroy();
    if (this.screenFx) {
      stage.screenLayer.removeChild(this.screenFx.weather);
      this.screenFx.weather.destroy({ children: true });
    }
    stage.setScreenFilters([]);
    stage.setWorldFilters([]);
    stage.setMirrors(false);
    stage.camera.shakeX = 0;
    stage.camera.shakeY = 0;
    stage.setBackgroundImage(null);
    stage.setBackgroundVideo(null);
  }

  /** floor에서 시작 (체크포인트 재개면 2박 전부터). */
  private begin(floor: number, resume: boolean): void {
    const ch = this.chart;
    if (this.eng.ctx.state === 'suspended') void this.eng.ctx.resume();
    this.resumeAt = 0;
    this.pausedSong = null;
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
      // 원작처럼 마지막 째깍 한 박 뒤가 첫 타격 (타일 1)
      const n = ch.level.settings.countdownTicks;
      const beat = 60 / tile.bpm;
      const firstHit = ch.tiles.length > 1 ? ch.tiles[1].time : tile.time;
      for (let k = n; k >= 1; k--) ticks.push(firstHit - k * beat);
      songStart = Math.min(0, firstHit - (n + 0.5) * beat);
    } else {
      // 이 타일에 서서 시작 → 다음 타일이 첫 타격, 째깍 두 번 뒤 한 박에 친다
      const beat = 60 / prevBpm;
      const nextHit = floor + 1 < ch.tiles.length ? ch.tiles[floor + 1].time : tile.time;
      const nb = 60 / tile.bpm;
      songStart = Math.min(resumeTime(ch, floor, 2) - 0.5 * beat, nextHit - 2.5 * nb);
      ticks.push(nextHit - 2 * nb, nextHit - nb);
    }
    this.eng.cancelScheduled();
    this.eng.play(this.buffer, songStart, this.pitch, ch.level.settings.volume, 0.15);
    for (const tt of ticks) this.sfx.tick(this.eng.ctxTimeForSong(tt), tt === ticks[ticks.length - 1]);
    this.schedIdx = floor + 1;
    this.playIdx = 0;
    while (this.playIdx < this.plays.length && this.plays[this.playIdx].time < songStart) this.playIdx++;
    this.timeline.reset();
    this.timeline.update(songStart);
    const p = this.track.pos(floor);
    this.camPivot = { x: p.x, y: p.y };
    const c0 = cameraCenter(this.timeline.camera, { x: p.x, y: -p.y });
    stage.camera.snap(c0.x, -c0.y, this.timeline.camera.zoom, this.timeline.camera.rotation);
    this.state = 'playing';
  }

  private togglePause(): void {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'failed' || this.state === 'cleared') this.opts.onQuit();
  }

  /** 진단 정보 (주소에 ?debug를 붙이면 화면에 표시). */
  /** 장식이나 원작 변환 레벨인지 (일시정지 화면에 그림 현황을 보여줄지) */
  get hasDecorations(): boolean {
    return (this.chart.level.decorations?.length ?? 0) > 0 || !!this.opts.pkg.imported;
  }

  diag(): string[] {
    const lv = this.chart.level;
    const decos = lv.decorations ?? [];
    const st = this.deco?.stats;
    const tl = this.timeline;
    const shown = tl.decos.filter((d) => d.visible && d.opacity * d.calpha > 0.01).length;
    const out = [
      `버전 ${__BUILD__} · 파일 ${this.opts.pkg.files.size}개 · 원작 변환 ${this.opts.pkg.imported ? '예' : '아니오'}`,
      `타일 ${this.chart.tiles.length} · 이벤트 ${lv.actions.length} · 장식 ${decos.length} (지금 보이는 것 ${shown})`,
      `음원 ${this.opts.pkg.synthesized ? '없음(합성 비트)' : '있음'} · 곡 시각 ${this.eng.songTime(performance.now()).toFixed(2)}초`,
    ];
    const adofais = [...this.opts.pkg.files.keys()].filter((n) => n.toLowerCase().endsWith('.adofai'));
    if (adofais.length) out.push(`원작 파일: ${this.opts.pkg.source ?? '?'} (묶음 안 .adofai ${adofais.length}개: ${adofais.slice(0, 4).join(', ')})`);
    if (st) {
      out.push(`그림: 올림 ${st.loaded} · 줄임 ${st.shrunk} · 내림 ${st.unloaded} · 실패 ${st.failed} · 파일 없음 ${st.missing}`);
      if (st.missingNames.length) out.push(`없는 파일: ${st.missingNames.slice(0, 6).join(', ')}`);
      if (st.failedNames.length) out.push(`실패한 파일: ${st.failedNames.slice(0, 6).join(', ')}`);
    }
    out.push(`화질 단계 ${stage.qualityLevel} (0 = 최고, 느리면 자동으로 낮춤) · 화면 해상도 ${stage.app.renderer.resolution}배`);
    out.push(`필터 ${[...tl.filters.keys()].join(', ') || '없음'} · 빛 번짐 ${tl.bloom.intensity.toFixed(2)}`);
    return out;
  }

  /**
   * 일시정지: 오디오 장치를 멈추지(suspend) 않고 노래만 그 지점에서 멈춘다.
   * (휴대폰은 장치를 다시 켤 때 소리 지연이 달라져 재개 후 노래와 타일이 어긋났다)
   */
  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.resumeAt = 0;
    this.pausedSong = this.eng.songTime();
    this.eng.stop();
    this.eng.cancelScheduled();
    this.opts.hud.setPaused(true);
  }

  /** 일시정지 해제: 카운트다운(1.5초)이 끝나는 순간 멈춘 지점부터 다시 들리게 재생을 예약한다. */
  resume(): void {
    if (this.state !== 'paused' || this.resumeAt) return;
    this.opts.hud.setPaused(false);
    const lead = 1.5;
    if (this.eng.ctx.state === 'suspended') void this.eng.ctx.resume();
    this.eng.play(this.buffer, this.pausedSong ?? this.eng.songTime(), this.pitch, this.chart.level.settings.volume, lead);
    this.resumeAt = performance.now() + lead * 1000;
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
    // 빠른 연타 구간도 원작처럼 최소 약 65ms(보통)는 받아준다 — 난이도 배율에 비례
    return judgeWindows(beatMs(tiles[floor], this.pitch), this.mult, gap * 500, (MIN_FAR_MS * this.mult) / DIFFICULTY_MULT.normal);
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
    if (!this.scheduledHits) this.hitSound(this.cur);
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
        this.state = 'playing';
        // 타격음·효과음은 재개 지점부터 다시 예약
        const from = this.pausedSong ?? 0;
        this.pausedSong = null;
        this.schedIdx = this.cur + 1;
        this.playIdx = 0;
        while (this.playIdx < this.plays.length && this.plays[this.playIdx].time < from) this.playIdx++;
      }
    }

    // 입력 먼저 처리 (재시작 시 클럭이 바뀌므로 곡 시각은 그 뒤에 읽는다)
    for (const ev of this.input.drain()) this.handleInput(ev);

    // 일시정지·재개 카운트다운 중에는 멈춘 시각 그대로 (카운트다운 동안 노래 시각은 뒤에서 다가온다)
    const t = this.state === 'paused' && this.pausedSong !== null ? this.pausedSong : this.eng.songTime(now);
    const tj = t - (settings.inputOffset / 1000) * this.pitch;
    let tr = t + (settings.visualOffset / 1000) * this.pitch;
    // 자동 시험용 (화면 비교): 이 시각에서 화면만 멈춘다
    const freeze = (window as unknown as { __orbitFreezeAt?: number }).__orbitFreezeAt;
    let vcur = this.cur; // 화면에 그릴 현재 타일 (멈춤 시험 중에는 그 시각의 타일)
    if (typeof freeze === 'number' && tr > freeze) {
      tr = freeze;
      while (vcur > 0 && ch.tiles[vcur].time > tr) vcur--;
    }

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
      if (this.scheduledHits && this.state === 'playing') {
        while (this.schedIdx <= ch.finish && ch.times[this.schedIdx] < t + 0.35) {
          const i = this.schedIdx++;
          if (i > 0 && ch.times[i] === ch.times[i - 1] && i - 1 > this.beginFloor) continue;
          if (ch.times[i] > t - 0.01) this.hitSound(i, this.eng.ctxTimeForSong(ch.times[i]), true);
        }
      }
      // 원작 PlaySound
      while (this.state === 'playing' && this.playIdx < this.plays.length && this.plays[this.playIdx].time < t + 0.35) {
        const pl = this.plays[this.playIdx++];
        if (pl.time > t - 0.05) this.sfx.hit(this.eng.ctxTimeForSong(pl.time), true, pl.sound, pl.volume);
      }
    }

    // ── 렌더 ──
    // 화면 끊김 (원작 SetFrameRate): 그리는 시각을 초당 fps 단계로 끊는다
    const fpsQ = this.timeline.fps;
    if (fpsQ > 0 && !settings.reduceEffects) tr = Math.floor(tr * fpsQ) / fpsQ;
    (window as unknown as { __orbitSongTime?: number }).__orbitSongTime = tr; // 자동 시험용 (화면 비교)
    this.timeline.update(tr);
    const tl = this.timeline;
    const reduce = settings.reduceEffects;
    stage.setMirrors(tl.mirrors && !reduce);
    this.planets.setSize(tl.planetSize);
    stage.setBackground(tl.bgColor);
    stage.setBackgroundImage(tl.bgImage ? fileUrl(this.opts.pkg, tl.bgImage) : null, { fit: tl.bgFit, tint: tl.bgTint, opacity: tl.bgOpacity });
    stage.setBackgroundVideo(
      tl.bgVideo ? fileUrl(this.opts.pkg, tl.bgVideo) : null,
      this.state === 'playing' || this.state === 'cleared' ? tr - tl.bgVideoOffset : null,
      this.pitch,
      { loop: tl.bgVideoLoop, opacity: Math.max(tl.bgOpacity, tl.bgImage ? 0 : 1) },
    );

    const tile = ch.tiles[vcur];
    const pivot = this.track.pos(vcur);
    const angle = orbiterAngle(tile, tr);
    const tail: number[] = [];
    for (let k = 1; k <= 8; k++) {
      const tt = tr - (k * 0.15) / 8;
      if (tt < tile.time - 0.01) break;
      tail.push(orbiterAngle(tile, tt));
    }
    const holdProgress = this.hold ? (tr - this.hold.start) / (this.hold.release - this.hold.start) : null;
    const aIsPivot = vcur % 2 === 0;
    if (this.state !== 'failed') {
      this.orbiterPos = this.planets.update(pivot, angle, TILE_LEN * tl.planetRadius, this.state === 'cleared' ? [] : tail, aIsPivot, holdProgress);
    }

    const cam = tl.camera;
    // 카메라 중심: 기준점(행성·타일·월드·직전 위치) + 오프셋 — 월드는 y 위쪽, 화면은 y 아래쪽
    const dt = stage.tick();
    const fk = 1 - Math.exp(-8 * dt);
    this.camPivot.x += (pivot.x - this.camPivot.x) * fk;
    this.camPivot.y += (pivot.y - this.camPivot.y) * fk;
    const cc = cameraCenter(cam, { x: this.camPivot.x, y: -this.camPivot.y });
    const px0 = stage.camera.x;
    const py0 = stage.camera.y;
    stage.camera.snap(cc.x, -cc.y, cam.zoom, reduce ? 0 : cam.rotation);
    const sc = stage.baseScale * stage.camera.zoom;
    const motion = dt > 0 ? { x: ((stage.camera.x - px0) * sc) / dt, y: ((stage.camera.y - py0) * sc) / dt } : { x: 0, y: 0 };
    stage.camera.shakeX = reduce ? 0 : tl.shakeX;
    stage.camera.shakeY = reduce ? 0 : -tl.shakeY;
    // 지진 (원작 확장 필터 EarthQuake): 켜져 있는 동안 계속 흔들림
    const quake = tl.filters.get('Quake')?.intensity ?? 0;
    if (quake > 0 && !reduce) {
      stage.camera.shakeX += (Math.random() - 0.5) * 24 * quake;
      stage.camera.shakeY += (Math.random() - 0.5) * 24 * quake;
    }
    this.deco.update(stage.camera.x, stage.camera.y, stage.camera.rotation, tr, stage.camera.zoom);
    this.screenFx.screenH = stage.height;
    const worldFs = this.screenFx.worldFilters(tl.bloom, reduce);
    stage.setWorldFilters(worldFs);
    const scroll: [number, number] = [tl.screenScroll[0] * tr, tl.screenScroll[1] * tr];
    const screenFs = this.screenFx.filters(tl.filters, tl.bloom, tr, reduce, motion, { tile: tl.screenTile, scroll });
    stage.setScreenFilters(screenFs);
    // 느린 기기면 필터 해상도부터 자동으로 낮춘다 (진행 중일 때만 잰다)
    if (this.state === 'playing') stage.adaptQuality(stage.app.ticker.deltaMS, worldFs.length + screenFs.length > 0);
    this.screenFx.drawWeather(tl.filters, stage.width, stage.height, dt, reduce);
    const phase = beatPhaseAt(ch, tr);
    const frac = phase - Math.floor(phase);
    const pulse = settings.beatPulse && !reduce && this.state === 'playing' ? Math.exp(-frac * 6) : 0;
    this.track.update({ passed: vcur, pulse, now, view: stage.viewRect(), time: tr });
    this.track.uprightTexts((stage.camera.rotation * Math.PI) / 180);
    this.fx.rotation = (stage.camera.rotation * Math.PI) / 180;
    this.fx.update(now);
    // 배경 면 플래시는 밝기를 낮추는 용도가 많아 효과 줄이기에서도 유지
    stage.frame(tl.flashColor, reduce ? 0 : tl.flashAlpha, tl.bgFlashColor, tl.bgFlashAlpha);

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

import { audio } from '../audio/engine';
import { Sfx } from '../audio/sfx';
import { compileChart, type Chart } from '../core/chart';
import { toHex } from '../core/color';
import {
  addAction,
  deleteTile,
  fillStraight,
  insertTileAfter,
  truncateAfter,
  recordToAngles,
  removeAction,
  replaceAction,
  setOutAngle,
  type RecordMode,
} from '../core/editorOps';
import { ACTION_TYPES, cloneLevel, emptyLevel, serializeLevel, validateLevel } from '../core/level';
import { normDeg, TILE_LEN } from '../core/math';
import { VisualTimeline } from '../core/timeline';
import { estimateTempo, tapTempo, type TempoEstimate } from '../core/tempo';
import { autoChart, type AutoDifficulty } from '../core/autochart';
import { toMono } from '../audio/mono';
import type { Action, ActionType, LevelData } from '../core/types';
import { settings } from '../game/settings';
import { library } from '../levels/library';
import {
  download,
  exportZip,
  invalidateSynth,
  loadPackageAudio,
  decodeErrorMessage,
  songFromZip,
  SONG_OR_ZIP_ACCEPT,
  type SaveResult,
  newPackageId,
  PACKAGE_ACCEPT,
  packageFromFileList,
  PackageError,
  type LevelPackage,
} from '../levels/package';
import { stage } from '../render/stage';
import { fmtBeats, TrackView } from '../render/track';
import { alertBox, confirmBox, fileButton, h, isTyping, show, toast, warnIfHuge, type Screen } from '../ui/dom';
import { PlayScreen } from '../ui/play';
import { openSongGenerator } from '../ui/songgen';
import { openMp3Converter } from '../ui/convert';
import { TitleScreen } from '../ui/title';
import { ACTION_LABEL, defaultAction, EASE_NAMES, SCHEMA, type Field } from './schema';
import { WaveTimeline } from './waveform';

const KEY_ANGLES: Record<string, number> = {
  KeyD: 0,
  KeyW: 90,
  KeyA: 180,
  KeyS: 270,
  KeyE: 45,
  KeyQ: 135,
  KeyZ: 225,
  KeyC: 315,
};

const AUTOSAVE = 'orbit.editor.autosave.v1';

const clampZoom = (z: number) => Math.max(0.03, Math.min(6, z));

interface Snapshot {
  level: string;
  sel: number;
}

interface Recording {
  base: LevelData;
  baseSel: number;
  presses: number[];
  mode: RecordMode;
}

/** 편집 중인 패키지 (화면 전환 사이 유지). */
let editing: LevelPackage | null = null;

function initialPackage(): LevelPackage {
  if (editing) return editing;
  let level = emptyLevel();
  try {
    const raw = localStorage.getItem(AUTOSAVE);
    if (raw) {
      const r = validateLevel(JSON.parse(raw));
      if (r.ok) level = r.level;
    }
  } catch {
    /* 무시 */
  }
  editing = { id: newPackageId('edit'), level, files: new Map(), builtin: false, warnings: [] };
  return editing;
}

export class EditorScreen implements Screen {
  private pkg = initialPackage();
  private level: LevelData = this.pkg.level;
  private sel = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private chart!: Chart;
  private timeline!: VisualTimeline;
  private track: TrackView | null = null;
  private wave = new WaveTimeline();
  private side!: HTMLElement;
  private info!: HTMLElement;
  private recBadge!: HTMLElement;
  private autoplay = false;
  private recording: Recording | null = null;
  private previewing = false;
  private taps: number[] = [];
  private tapBpm: number | null = null;
  private estimate: TempoEstimate | null = null;
  private estimateMsg = '';
  private autoDiff: AutoDifficulty = 'normal';
  private autoUseCurrent = false;
  private autoSens = 0.55;
  private recMode: RecordMode = 'oneway';
  /** 녹화 재생 속도 (느리게 재생해도 결과는 원래 속도 기준). */
  private recSpeed = 1;
  /** 선택 타일 뒤를 지우고 녹화. */
  private recOverwrite = false;
  private fillCount = 8;
  private fillBpm = 0;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private readonly eng = audio();
  private readonly sfx = new Sfx(this.eng);
  private tickFn = () => this.frame();
  private dirtyTrack = true;
  private camInit = false;
  private offs: (() => void)[] = [];
  private canvasEl: HTMLElement | null = null;
  private zoomLabel: HTMLElement | null = null;

  enter(root: HTMLElement): void {
    stage.clearWorld();
    stage.setBackgroundImage(null);
    this.rebuild(false);
    this.buildDom(root);
    this.bindInput();
    stage.app.ticker.add(this.tickFn);
    if (!this.camInit) {
      stage.camera.zoom = 0.8;
      // 레이아웃이 잡힌 뒤 편집 영역 가운데로
      requestAnimationFrame(() => this.centerOn(this.sel));
      this.camInit = true;
    }
    stage.camera.rotation = 0;
    void loadPackageAudio(this.pkg).then((b) => {
      this.wave.buffer = this.pkg.synthesized ? null : b;
      this.wave.draw();
    });
  }

  exit(): void {
    this.stopRecording(false);
    this.stopPreview();
    stage.app.ticker.remove(this.tickFn);
    for (const f of this.offs.splice(0)) f();
    this.track?.destroy();
    this.track = null;
    this.wave.destroy();
    this.wave = new WaveTimeline();
    stage.clearWorld();
  }

  // ───────────────────────── 상태 ─────────────────────────

  private tilePos(i: number) {
    const t = this.chart.tiles[Math.max(0, Math.min(i, this.chart.tiles.length - 1))];
    return { x: t.x, y: -t.y };
  }

  private rebuild(sidePanel = true): void {
    this.pkg.level = this.level;
    invalidateSynth(this.pkg);
    this.chart = compileChart(this.level);
    this.timeline = new VisualTimeline(this.chart);
    this.sel = Math.max(0, Math.min(this.sel, this.chart.finish));
    this.dirtyTrack = true;
    try {
      localStorage.setItem(AUTOSAVE, serializeLevel(this.level));
    } catch {
      /* 무시 */
    }
    if (sidePanel && this.side) this.renderSide();
    this.wave.chart = this.chart;
    this.wave.selected = this.sel;
    this.wave.focus(this.chart.times[this.sel]);
    this.wave.draw();
  }

  private commit(level: LevelData, sel = this.sel): void {
    this.undoStack.push({ level: JSON.stringify(this.level), sel: this.sel });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.level = level;
    this.sel = sel;
    this.rebuild();
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ level: JSON.stringify(this.level), sel: this.sel });
    this.level = JSON.parse(s.level) as LevelData;
    this.sel = s.sel;
    this.rebuild();
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ level: JSON.stringify(this.level), sel: this.sel });
    this.level = JSON.parse(s.level) as LevelData;
    this.sel = s.sel;
    this.rebuild();
  }

  private select(i: number, focus = true): void {
    this.sel = Math.max(0, Math.min(i, this.chart.finish));
    this.wave.selected = this.sel;
    this.wave.focus(this.chart.times[this.sel]);
    this.wave.draw();
    this.renderSide();
    if (focus) this.ensureVisible();
  }

  /** 선택 타일 뒤에 angle 방향 타일 추가 (키보드·방향 패드 공용). */
  private addTile(angle: number): void {
    const r = insertTileAfter(this.level, this.sel, angle);
    this.commit(r.level, r.sel);
    this.ensureVisible();
  }

  private removeTile(): void {
    const r = deleteTile(this.level, this.sel);
    if (r.level !== this.level) this.commit(r.level, r.sel);
    this.ensureVisible();
  }

  /** 선택 타일의 나가는 각도 ±15°. */
  private nudgeAngle(d: number): void {
    if (this.sel >= this.level.path.length) {
      toast('도착 타일은 방향이 없습니다. 앞 타일을 선택하세요.');
      return;
    }
    this.commit(setOutAngle(this.level, this.sel, this.level.path[this.sel] + d));
  }

  /** 방향 패드 (터치 기기·좁은 화면은 기본으로 표시). */
  private padVisible = (() => {
    try {
      const saved = localStorage.getItem('orbit.editor.pad');
      if (saved !== null) return saved === '1';
    } catch {
      /* 무시 */
    }
    return matchMedia('(hover: none) and (pointer: coarse)').matches || window.innerWidth < 760;
  })();
  private padEl: HTMLElement | null = null;

  private togglePad(): void {
    this.padVisible = !this.padVisible;
    try {
      localStorage.setItem('orbit.editor.pad', this.padVisible ? '1' : '0');
    } catch {
      /* 무시 */
    }
    if (this.padEl) this.padEl.hidden = !this.padVisible;
  }

  private buildPad(): HTMLElement {
    const btn = (label: string, title: string, fn: () => void, cls = '') =>
      h('button', { class: `btn pad-btn ${cls}`, title, 'aria-label': title, onclick: fn }, label);
    // 3×3: 가운데는 삭제. 화살표 방향 = 새 타일이 이어지는 방향
    const dirs: [string, number, string][] = [
      ['↖', 135, '왼쪽 위 (Q)'],
      ['↑', 90, '위 (W)'],
      ['↗', 45, '오른쪽 위 (E)'],
      ['←', 180, '왼쪽 (A)'],
      ['', -1, ''],
      ['→', 0, '오른쪽 (D)'],
      ['↙', 225, '왼쪽 아래 (Z)'],
      ['↓', 270, '아래 (S)'],
      ['↘', 315, '오른쪽 아래 (C)'],
    ];
    const grid = h(
      'div',
      { class: 'pad-grid' },
      ...dirs.map(([l, a, t]) => (a < 0 ? btn('⌫', '선택 타일 삭제 (Backspace)', () => this.removeTile(), 'danger') : btn(l, `${t} 타일 추가`, () => this.addTile(a)))),
    );
    const row = h(
      'div',
      { class: 'pad-row' },
      btn('◀', '이전 타일 선택 (←)', () => this.select(this.sel - 1)),
      btn('▶', '다음 타일 선택 (→)', () => this.select(this.sel + 1)),
      btn('↺', '각도 +15° (Shift+←)', () => this.nudgeAngle(15)),
      btn('↻', '각도 −15° (Shift+→)', () => this.nudgeAngle(-15)),
      btn('🌀', '회전 반전 토글 (T)', () => this.toggleAction('Twirl')),
      btn('↶', '실행 취소 (Ctrl+Z)', () => this.undo()),
    );
    const pad = h('div', { class: 'dir-pad ui-interactive' }, grid, row);
    pad.hidden = !this.padVisible;
    this.padEl = pad;
    return pad;
  }

  /** 화면 좌표(sx, sy) 아래의 지점을 고정한 채 확대/축소. */
  private zoomAt(zoom: number, sx: number, sy: number): void {
    const cam = stage.camera;
    const before = stage.screenToWorld(sx, sy);
    cam.zoom = clampZoom(zoom);
    const s = stage.baseScale * cam.zoom;
    cam.x = before.x - (sx - stage.width / 2) / s;
    cam.y = before.y - (sy - stage.height / 2) / s;
  }

  /** 편집 캔버스 영역 (오른쪽 패널·아래 타임라인 제외). */
  private canvasRect(): { x: number; y: number; w: number; h: number } {
    const el = this.canvasEl;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return { x: 0, y: 0, w: stage.width, h: stage.height };
  }

  private zoomStep(factor: number): void {
    const r = this.canvasRect();
    this.zoomAt(stage.camera.zoom * factor, r.x + r.w / 2, r.y + r.h / 2);
  }

  /** 트랙 전체가 편집 영역에 들어오게. */
  private zoomFit(): void {
    const tiles = this.chart.tiles;
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const p = this.tilePos(i);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const r = this.canvasRect();
    const pad = TILE_LEN * 1.2;
    const s = Math.min(r.w / (x1 - x0 + pad * 2), r.h / (y1 - y0 + pad * 2));
    const cam = stage.camera;
    cam.rotation = 0;
    cam.zoom = clampZoom(s / stage.baseScale);
    const sc = stage.baseScale * cam.zoom;
    // 트랙 중심이 편집 영역 중심에 오도록
    cam.x = (x0 + x1) / 2 - (r.x + r.w / 2 - stage.width / 2) / sc;
    cam.y = (y0 + y1) / 2 - (r.y + r.h / 2 - stage.height / 2) / sc;
  }

  /** 타일 i를 편집 영역(패널 제외) 가운데에 오게. zoom을 주면 배율도 바꾼다. */
  private centerOn(i: number, zoom?: number): void {
    const cam = stage.camera;
    if (zoom !== undefined) cam.zoom = clampZoom(zoom);
    cam.rotation = 0;
    const p = this.tilePos(i);
    const r = this.canvasRect();
    const s = stage.baseScale * cam.zoom;
    cam.x = p.x - (r.x + r.w / 2 - stage.width / 2) / s;
    cam.y = p.y - (r.y + r.h / 2 - stage.height / 2) / s;
  }

  /** 선택 타일이 편집 영역 가장자리 근처나 밖이면 가운데로. */
  private ensureVisible(): void {
    const p = this.tilePos(this.sel);
    const r = this.canvasRect();
    const s = stage.baseScale * stage.camera.zoom;
    // 월드 → 화면 (에디터는 회전 없음)
    const sx = (p.x - stage.camera.x) * s + stage.width / 2;
    const sy = (p.y - stage.camera.y) * s + stage.height / 2;
    const mx = Math.min(80, r.w * 0.2);
    const my = Math.min(80, r.h * 0.2);
    if (sx < r.x + mx || sx > r.x + r.w - mx || sy < r.y + my || sy > r.y + r.h - my) this.centerOn(this.sel);
  }

  // ───────────────────────── 입력 ─────────────────────────

  private bindInput(): void {
    const canvas = stage.app.canvas;
    const kd = (e: KeyboardEvent) => this.onKey(e);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // 트랙패드 핀치는 ctrlKey + wheel로 들어온다 → 더 민감하게
      const k = e.ctrlKey ? 0.01 : 0.0015;
      this.zoomAt(stage.camera.zoom * Math.exp(-e.deltaY * k), e.clientX, e.clientY);
    };
    // 포인터 여러 개(두 손가락 핀치) 추적
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; zoom: number; wx: number; wy: number } | null = null;
    const mid = () => {
      const a = [...pts.values()];
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
    };
    const pd = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (pts.size === 2) {
        const m = mid();
        const w = stage.screenToWorld(m.x, m.y);
        pinch = { dist: Math.max(10, m.d), zoom: stage.camera.zoom, wx: w.x, wy: w.y };
        this.drag = null;
        return;
      }
      if (pts.size === 1) this.drag = { x: e.clientX, y: e.clientY, cx: stage.camera.x, cy: stage.camera.y, moved: false };
    };
    const pm = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const m = mid();
        const cam = stage.camera;
        cam.zoom = clampZoom(pinch.zoom * (m.d / pinch.dist));
        // 손가락 가운데 아래의 월드 지점이 계속 손가락 가운데에 오도록 (확대 + 이동 동시에)
        const s = stage.baseScale * cam.zoom;
        cam.x = pinch.wx - (m.x - stage.width / 2) / s;
        cam.y = pinch.wy - (m.y - stage.height / 2) / s;
        return;
      }
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.hypot(dx, dy) > 5) d.moved = true;
      if (d.moved) {
        const s = stage.baseScale * stage.camera.zoom;
        stage.camera.x = d.cx - dx / s;
        stage.camera.y = d.cy - dy / s;
      }
    };
    const pu = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pinch) {
        if (pts.size < 2) pinch = null;
        // 한 손가락이 남으면 튀지 않게 그 위치에서 드래그를 다시 시작 (선택은 하지 않음)
        const rest = [...pts.values()][0];
        this.drag = rest ? { x: rest.x, y: rest.y, cx: stage.camera.x, cy: stage.camera.y, moved: true } : null;
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved || e.type === 'pointercancel') return;
      const w = stage.screenToWorld(e.clientX, e.clientY);
      let best = -1;
      let bd = TILE_LEN * 0.45;
      // 겹친 타일은 뒤쪽(나중) 타일 우선
      for (let i = this.chart.tiles.length - 1; i >= 0; i--) {
        const p = this.tilePos(i);
        const dd = Math.hypot(p.x - w.x, p.y - w.y);
        if (dd < bd - 1e-6) {
          bd = dd;
          best = i;
        }
      }
      if (best >= 0) this.select(best, false);
    };
    // iOS 사파리의 페이지 확대 제스처 막기 (캔버스 핀치는 위에서 직접 처리)
    const gesture = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', gesture);
    canvas.addEventListener('pointercancel', pu);
    this.offs.push(
      () => document.removeEventListener('gesturestart', gesture),
      () => canvas.removeEventListener('pointercancel', pu),
    );
    window.addEventListener('keydown', kd);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('pointerdown', pd);
    canvas.addEventListener('pointermove', pm);
    canvas.addEventListener('pointerup', pu);
    this.offs.push(
      () => window.removeEventListener('keydown', kd),
      () => canvas.removeEventListener('wheel', wheel),
      () => canvas.removeEventListener('pointerdown', pd),
      () => canvas.removeEventListener('pointermove', pm),
      () => canvas.removeEventListener('pointerup', pu),
    );
    this.wave.onSelect = (i) => this.select(i);
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (isTyping(t)) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (t && t.tagName && t !== document.body && (e.key === ' ' || e.key === 'Enter')) t.blur();
    if (this.previewing) {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        this.stopPreview();
      }
      return;
    }
    if (this.recording) {
      e.preventDefault();
      if (e.key === 'Escape') this.stopRecording(true);
      else if (!e.repeat) this.recordPress(e.timeStamp);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (ctrl && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (ctrl && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void this.saveJson();
      return;
    }
    if (ctrl || e.altKey) return;
    if (e.shiftKey && e.key.startsWith('Arrow')) {
      // 15° 단위 미세 각도: ←/↑ 반시계(+15°), →/↓ 시계(−15°)
      e.preventDefault();
      if (this.sel >= this.level.path.length) return;
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 15 : -15;
      this.commit(setOutAngle(this.level, this.sel, this.level.path[this.sel] + d));
      return;
    }
    if (e.code in KEY_ANGLES) {
      e.preventDefault();
      this.addTile(KEY_ANGLES[e.code]);
      return;
    }
    switch (e.key) {
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        this.removeTile();
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        this.select(this.sel - 1);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        this.select(this.sel + 1);
        break;
      case 'Home':
        this.select(0);
        break;
      case 'End':
        this.select(this.chart.finish);
        break;
      case ' ':
        e.preventDefault();
        this.playtest();
        break;
      case 't':
      case 'T':
        this.toggleAction('Twirl');
        break;
      case '+':
      case '=':
        this.zoomStep(1.25);
        break;
      case '-':
      case '_':
        this.zoomStep(0.8);
        break;
      case '0':
        this.zoomFit();
        break;
      case 'f':
      case 'F':
        this.centerOn(this.sel);
        break;
      case 'Escape':
        void show(new TitleScreen());
        break;
    }
  }

  private toggleAction(type: ActionType): void {
    const idx = this.level.actions.findIndex((a) => a.floor === this.sel && a.type === type);
    if (idx >= 0) this.commit(removeAction(this.level, idx));
    else this.commit(addAction(this.level, defaultAction(type, this.sel, this.chart.finish)));
  }

  // ───────────────────────── 녹화 ─────────────────────────

  private async startRecording(): Promise<void> {
    if (this.recording) return;
    const buf = await loadPackageAudio(this.pkg);
    await this.eng.resume();
    const tile = this.chart.tiles[this.sel];
    const beat = 60 / tile.bpm;
    const songStart = tile.time - 4 * beat;
    this.eng.cancelScheduled();
    // 곡 시각은 재생 속도와 무관하게 계산되므로 느리게 들어도 박 간격은 원래 곡 기준
    this.eng.play(buf, songStart, this.level.settings.pitch * this.recSpeed, this.level.settings.volume, 0.1);
    for (let k = 4; k >= 1; k--) this.sfx.tick(this.eng.ctxTimeForSong(tile.time - k * beat), k === 1);
    this.undoStack.push({ level: JSON.stringify(this.level), sel: this.sel });
    const base = this.recOverwrite && this.sel < this.level.path.length ? truncateAfter(this.level, this.sel) : cloneLevel(this.level);
    if (base !== this.level && this.recOverwrite) {
      this.level = base;
      this.rebuild();
    }
    this.recording = { base, baseSel: this.sel, presses: [], mode: this.recMode };
    this.redoStack = [];
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.renderSide();
  }

  private recordPress(ts: number): void {
    const r = this.recording!;
    const t = this.eng.songTimeAtPerf(ts) - (settings.inputOffset / 1000) * this.eng.currentPitch;
    const base = compileChart(r.base).tiles[r.baseSel];
    const prev = r.presses.length ? r.presses[r.presses.length - 1] : base.time;
    if (t - prev < 0.03) return;
    r.presses.push(t);
    this.sfx.hit();
    const intervals = r.presses.map((p, i) => p - (i === 0 ? base.time : r.presses[i - 1]));
    const res = recordToAngles(intervals, base.bpm, base.start, base.dir, r.mode);
    let lv = r.base;
    let s = r.baseSel;
    for (const a of res.angles) {
      const x = insertTileAfter(lv, s, a);
      lv = x.level;
      s = x.sel;
    }
    for (const k of res.twirls) lv = addAction(lv, { floor: r.baseSel + k, type: 'Twirl' });
    this.level = lv;
    this.sel = s;
    this.rebuild();
    this.ensureVisible();
  }

  // ───────────────────────── 음악 맞추기 ─────────────────────────

  /** 선택 타일 2박 전부터 음악 + 각 hitTime에 타격음. */
  private async startPreview(): Promise<void> {
    if (this.previewing || this.recording) return;
    const buf = await loadPackageAudio(this.pkg);
    await this.eng.resume();
    const tile = this.chart.tiles[this.sel];
    const songStart = tile.time - (2 * 60) / tile.bpm;
    this.eng.cancelScheduled();
    this.eng.play(buf, songStart, this.level.settings.pitch, this.level.settings.volume, 0.1);
    const until = songStart + 120;
    for (let i = this.sel; i <= this.chart.finish && this.chart.times[i] < until; i++) {
      if (i > this.sel && this.chart.times[i] === this.chart.times[i - 1]) continue;
      this.sfx.hit(this.eng.ctxTimeForSong(this.chart.times[i]), true);
    }
    this.previewing = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.renderSide();
  }

  private stopPreview(): void {
    if (!this.previewing) return;
    this.previewing = false;
    this.eng.stop();
    this.eng.cancelScheduled();
    this.wave.playhead = null;
    this.wave.draw();
    this.renderSide();
  }

  private runEstimate(): void {
    const buf = this.pkg.synthesized ? null : this.pkg.buffer;
    if (!buf) {
      this.estimateMsg = '먼저 음원을 선택하세요.';
      this.renderSide();
      return;
    }
    const r = estimateTempo(toMono(buf), buf.sampleRate);
    this.estimate = r;
    this.estimateMsg = r
      ? `추정: ${r.bpm} BPM · 첫 박 ${r.offset.toFixed(3)}s · 신뢰도 ${Math.round(r.confidence * 100)}%`
      : '박을 찾지 못했습니다 (너무 짧거나 조용한 음원).';
    this.renderSide();
  }

  private applyTempo(bpm: number, offset?: number): void {
    const lv = cloneLevel(this.level);
    lv.settings.bpm = bpm;
    if (offset !== undefined) {
      // 카운트다운이 들어갈 여유: 첫 박을 1초 이후로
      const beat = 60 / bpm;
      let off = offset;
      while (off < 1) off += beat;
      lv.settings.offset = Math.round(off * 1000) / 1000;
    }
    this.commit(lv);
  }

  private tap(): void {
    const now = performance.now() / 1000;
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 16) this.taps.shift();
    this.tapBpm = tapTempo(this.taps);
    this.renderSide();
  }

  private nudgeOffset(sec: number): void {
    const lv = cloneLevel(this.level);
    lv.settings.offset = Math.round((lv.settings.offset + sec) * 1000) / 1000;
    this.commit(lv);
  }

  /** 음원 리듬으로 타일 자동 생성 (레벨 설정의 색·제목은 유지, 길·이벤트는 교체). */
  private async generate(ask = true): Promise<void> {
    const buf = this.pkg.synthesized ? null : this.pkg.buffer;
    if (!buf) {
      void alertBox('음원이 없습니다', ['위의 "음원 선택"으로 곡을 먼저 고르세요.']);
      return;
    }
    if (ask && this.level.path.length > 4 && !(await confirmBox('타일 자동 생성', '지금 있는 타일과 이벤트를 모두 바꿉니다. (실행 취소로 되돌릴 수 있습니다)', '생성'))) return;
    const s = this.level.settings;
    const title = this.level.meta.title === '제목 없음' ? s.songFile.replace(/\.[^.]+$/, '') : this.level.meta.title;
    const r = autoChart(toMono(buf), buf.sampleRate, {
      difficulty: this.autoDiff,
      sensitivity: this.autoSens,
      title,
      songFile: s.songFile,
      ...(this.autoUseCurrent ? { bpm: s.bpm, offset: s.offset } : {}),
    });
    if (!r) {
      void alertBox('자동 생성 실패', ['박을 찾지 못했습니다. BPM·offset을 직접 맞춘 뒤 "현재 BPM·첫 박 사용"을 켜고 다시 시도하거나, 녹화 모드를 쓰세요.']);
      return;
    }
    const lv = cloneLevel(this.level);
    lv.path = r.level.path;
    lv.actions = r.level.actions;
    lv.settings.bpm = r.level.settings.bpm;
    lv.settings.offset = r.offset;
    lv.settings.startDirection = r.level.settings.startDirection;
    lv.meta = { ...lv.meta, title, difficulty: r.level.meta.difficulty, previewStart: lv.meta.previewStart || r.level.meta.previewStart };
    this.estimate = { bpm: r.bpm, offset: r.offset, confidence: 1 };
    this.estimateMsg = `자동 생성: ${r.bpm} BPM · 타일 ${r.tiles}개`;
    this.commit(lv, 0);
    this.centerOn(0, 0.6);
    toast(`타일 ${r.tiles}개를 만들었습니다 — Space로 플레이테스트`, 3500);
  }

  private musicSection(): HTMLElement {
    const hasSong = !this.pkg.synthesized && !!this.pkg.buffer;
    const beat = 60 / this.level.settings.bpm;
    const est = this.estimate;
    return h(
      'div',
      { class: 'col' },
      h('h3', null, '음악 맞추기'),
      h(
        'div',
        { class: 'form' },
        h('label', null, '음원'),
        h('span', { class: hasSong ? '' : 'dim', style: 'word-break:break-all' }, hasSong ? this.level.settings.songFile : '없음 — 위의 "음원 선택"'),
        h('label', null, '타일 자동 생성'),
        h(
          'div',
          { class: 'col', style: 'gap:6px' },
          h(
            'div',
            { class: 'row', style: 'flex-wrap:nowrap' },
            (() => {
              const sel = h(
                'select',
                {
                  id: 'auto-diff',
                  onchange: () => {
                    this.autoDiff = sel.value as AutoDifficulty;
                    this.renderSide();
                  },
                },
                h('option', { value: 'easy' }, '쉬움'),
                h('option', { value: 'normal' }, '보통'),
                h('option', { value: 'hard' }, '어려움'),
                h('option', { value: 'expert' }, '매우 어려움 (16분)'),
                h('option', { value: 'master' }, '극한 (16분+셋잇단)'),
                h('option', { value: 'full' }, '원곡 그대로 (모든 소리)'),
              );
              sel.value = this.autoDiff;
              return sel;
            })(),
            (() => {
              const ss = h(
                'select',
                { id: 'auto-sens', onchange: () => (this.autoSens = Number(ss.value)) },
                h('option', { value: '0.3' }, '민감도 낮음'),
                h('option', { value: '0.55' }, '민감도 보통'),
                h('option', { value: '0.85' }, '민감도 높음'),
              );
              ss.value = String(this.autoSens);
              // 항상 보이게 (원곡 그대로일 때만 사용)
              ss.disabled = this.autoDiff !== 'full';
              ss.title = ss.disabled ? '민감도는 "원곡 그대로"에서만 씁니다' : '원곡 그대로 민감도';
              return ss;
            })(),
            h('button', { class: 'btn small cool', disabled: !hasSong, onclick: () => void this.generate() }, '생성'),
          ),
          h(
            'label',
            { class: 'row dim', style: 'font-size:12px' },
            h('input', { type: 'checkbox', id: 'auto-cur', checked: this.autoUseCurrent, onchange: (e: Event) => (this.autoUseCurrent = (e.target as HTMLInputElement).checked) }),
            '현재 BPM·첫 박 사용',
          ),
        ),
        h('label', null, '자동 추정'),
        h('button', { class: 'btn small', disabled: !hasSong, onclick: () => this.runEstimate() }, 'BPM · 첫 박 찾기'),
        this.estimateMsg ? h('label', null, '') : null,
        this.estimateMsg
          ? h(
              'div',
              { class: 'col', style: 'gap:6px' },
              h('span', { class: 'dim' }, this.estimateMsg),
              est ? h('button', { class: 'btn small cool', onclick: () => this.applyTempo(est.bpm, est.offset) }, '적용') : null,
            )
          : null,
        h('label', null, '탭 템포'),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:nowrap' },
          h('button', { class: 'btn small', onclick: () => this.tap(), title: '박에 맞춰 여러 번 클릭' }, `탭 (${this.taps.length})`),
          h('span', { class: 'dim' }, this.tapBpm ? `${this.tapBpm} BPM` : '4번 이상'),
          this.tapBpm ? h('button', { class: 'btn small', onclick: () => this.applyTempo(this.tapBpm!) }, '적용') : null,
        ),
        h('label', null, 'offset 미세'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn small', onclick: () => this.nudgeOffset(-0.01) }, '−10ms'),
          h('button', { class: 'btn small', onclick: () => this.nudgeOffset(0.01) }, '+10ms'),
          h('button', { class: 'btn small', onclick: () => this.nudgeOffset(-beat) }, '−1박'),
          h('button', { class: 'btn small', onclick: () => this.nudgeOffset(beat) }, '+1박'),
        ),
        h('label', null, '박 확인'),
        this.previewing
          ? h('button', { class: 'btn small danger', onclick: () => this.stopPreview() }, '■ 정지 (Esc)')
          : h('button', { class: 'btn small', onclick: () => void this.startPreview() }, '▶ 타격음과 함께 듣기'),
      ),
    );
  }

  private stopRecording(render = true): void {
    if (!this.recording) return;
    this.recording = null;
    this.eng.stop();
    this.eng.cancelScheduled();
    this.wave.playhead = null;
    if (render) {
      this.rebuild();
      this.wave.draw();
    }
  }

  // ───────────────────────── 파일 ─────────────────────────

  private fileBase(): string {
    return (this.level.meta.title || 'level').replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  private async saveJson(): Promise<void> {
    this.reportSave(await download(`${this.fileBase()}.orbit.json`, serializeLevel(this.level), 'application/json'));
  }

  private async exportZipFile(): Promise<void> {
    this.reportSave(await download(`${this.fileBase()}.zip`, exportZip(this.pkg), 'application/zip'));
  }

  private reportSave(r: SaveResult): void {
    if (r === 'failed') void alertBox('저장할 수 없습니다', ['이 화면에서는 파일 저장이 허용되지 않았습니다. 잠시 후 다시 시도하세요.']);
  }

  /** 곡 작곡 + 레벨 생성으로 편집 중인 레벨을 교체. */
  private async generateSongLevel(): Promise<void> {
    if (this.level.path.length > 4 && !(await confirmBox('음악 자동 생성', '지금 레벨을 새 곡과 자동 생성 타일로 바꿉니다. (실행 취소로 레벨은 되돌릴 수 있지만 곡은 새 곡으로 바뀝니다)', '계속'))) return;
    const pkg = await openSongGenerator();
    if (!pkg) return;
    pkg.id = newPackageId('edit');
    editing = pkg;
    this.pkg = pkg;
    this.commit(pkg.level, 0);
    this.wave.buffer = pkg.buffer ?? null;
    this.wave.draw();
    this.centerOn(0, 0.6);
  }

  private async loadFiles(files: FileList | File[]): Promise<void> {
    try {
      const pkg = await packageFromFileList(files);
      pkg.id = newPackageId('edit');
      editing = pkg;
      this.pkg = pkg;
      this.undoStack.push({ level: JSON.stringify(this.level), sel: this.sel });
      this.level = pkg.level;
      this.sel = 0;
      this.rebuild();
      const b = await loadPackageAudio(pkg);
      this.wave.buffer = pkg.synthesized ? null : b;
      this.wave.draw();
      this.centerOn(0, 0.8);
      if (pkg.warnings.length) await alertBox('불러오기 경고', pkg.warnings);
    } catch (e) {
      await alertBox('불러올 수 없습니다', e instanceof PackageError ? e.details : [(e as Error).message]);
    }
  }

  private async loadSong(files: FileList | File[]): Promise<void> {
    let f = files[0];
    if (!f) return;
    warnIfHuge(f);
    try {
      const inner = await songFromZip(f);
      if (inner) f = inner;
      else if (f.name.toLowerCase().endsWith('.zip')) {
        await this.loadFiles([f]);
        return;
      }
    } catch (e) {
      await alertBox('파일을 열 수 없습니다', e instanceof PackageError ? e.details : [(e as Error).message]);
      return;
    }
    const data = new Uint8Array(await f.arrayBuffer());
    try {
      const buf = await this.eng.decode(data.buffer.slice(0) as ArrayBuffer);
      this.pkg.files.set(f.name, data);
      const lv = cloneLevel(this.level);
      lv.settings.songFile = f.name;
      this.pkg.buffer = buf;
      this.pkg.synthesized = false;
      this.commit(lv);
      this.pkg.buffer = buf;
      this.pkg.synthesized = false;
      this.wave.buffer = buf;
      this.wave.draw();
      this.estimate = null;
      if (this.level.path.length <= 4 && this.level.actions.length === 0) {
        this.generate(false);
      } else this.runEstimate();
    } catch {
      await alertBox('음원을 읽을 수 없습니다', [decodeErrorMessage(f.name)]);
    }
  }

  private async addImage(files: FileList): Promise<void> {
    const f = files[0];
    this.pkg.files.set(f.name, new Uint8Array(await f.arrayBuffer()));
    this.commit(addAction(this.level, { floor: this.sel, type: 'Background', image: f.name }));
  }

  private async newLevel(): Promise<void> {
    if (!(await confirmBox('새 레벨', '새 레벨을 만들까요? 지금 내용은 실행 취소로 되돌릴 수 있습니다.', '새로 만들기'))) return;
    editing = { id: newPackageId('edit'), level: emptyLevel(), files: new Map(), builtin: false, warnings: [] };
    this.pkg = editing;
    this.wave.buffer = null;
    this.commit(this.pkg.level, 0);
    this.centerOn(0, 0.8);
  }

  private playtest(): void {
    const r = validateLevel(this.level);
    if (!r.ok) {
      void alertBox('레벨 오류', r.errors);
      return;
    }
    this.stopRecording(false);
    const back = () => this;
    void show(new PlayScreen(this.pkg, { startFloor: Math.min(this.sel, this.chart.finish - 1), autoplay: this.autoplay, editorTest: true, back }));
  }

  private addToLibrary(): void {
    const r = validateLevel(this.level);
    if (!r.ok) {
      void alertBox('레벨 오류', r.errors);
      return;
    }
    library.add({ ...this.pkg, id: this.pkg.id.replace(/^edit/, 'user'), level: cloneLevel(this.level), buffer: this.pkg.synthesized ? undefined : this.pkg.buffer });
    void alertBox('추가됨', ['레벨 선택 화면에 추가했습니다 (이번 세션 동안 유지).']);
  }

  // ───────────────────────── DOM ─────────────────────────

  private buildDom(root: HTMLElement): void {
    const pickLevel = fileButton('불러오기', { accept: PACKAGE_ACCEPT, multiple: true, cls: 'small' }, (f) => this.loadFiles(f));
    const pickSong = fileButton('음원 선택 (음악·동영상)', { accept: SONG_OR_ZIP_ACCEPT, cls: 'small' }, (f) => this.loadSong(f));
    const pickImg = fileButton('배경 이미지', { accept: 'image/*', cls: 'small' }, (f) => this.addImage(f));
    this.info = h('div', { class: 'info' });
    this.recBadge = h('span', { class: 'rec-badge' });
    this.side = h('div', { class: 'ed-side' });
    const bottom = h('div', { class: 'ed-bottom' }, this.wave.canvas);
    root.append(
      h(
        'div',
        { class: 'editor' },
        h(
          'div',
          { class: 'ed-top' },
          h('button', { class: 'btn small', onclick: () => show(new TitleScreen()) }, '← 타이틀'),
          h('span', { class: 'title' }, '레벨 에디터'),
          h('button', { class: 'btn small', onclick: () => void this.newLevel() }, '새로 만들기'),
          pickLevel,
          h('button', { class: 'btn small', onclick: () => void this.saveJson() }, '.orbit.json 저장'),
          h('button', { class: 'btn small', onclick: () => void this.exportZipFile() }, 'zip 내보내기'),
          pickSong,
          h('button', { class: 'btn small cool', onclick: () => void this.generateSongLevel() }, '음악 자동 생성'),
          h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                const f = await openMp3Converter();
                if (f) void this.loadSong([f]);
              },
            },
            '동영상 → mp3',
          ),
          pickImg,
          h('button', { class: 'btn small', onclick: () => this.addToLibrary() }, '목록에 추가'),
          h('span', { class: 'grow' }),
          this.recBadge,
          h('button', { class: 'btn small', onclick: () => this.undo(), title: 'Ctrl+Z' }, '↶'),
          h('button', { class: 'btn small', onclick: () => this.redo(), title: 'Ctrl+Y' }, '↷'),
          h('button', { class: 'btn small primary', onclick: () => this.playtest(), title: 'Space' }, '▶ 플레이테스트'),
        ),
        (this.canvasEl = h(
          'div',
          { class: 'ed-canvas' },
          this.info,
          h(
            'div',
            { class: 'zoom-ctl ui-interactive' },
            h('button', { class: 'btn small', title: '확대 (+)', 'aria-label': '확대', onclick: () => this.zoomStep(1.25) }, '+'),
            (this.zoomLabel = h('span', { class: 'zoom-val' }, '')),
            h('button', { class: 'btn small', title: '축소 (−)', 'aria-label': '축소', onclick: () => this.zoomStep(0.8) }, '−'),
            h('button', { class: 'btn small', title: '트랙 전체 보기 (0)', onclick: () => this.zoomFit() }, '전체'),
            h('button', { class: 'btn small', title: '방향 패드 보이기/숨기기', onclick: () => this.togglePad() }, '패드'),
          ),
          this.buildPad(),
          h(
            'div',
            { class: 'hint' },
            'D/W/A/S = 0°/90°/180°/270° · E/Q/Z/C = 45°/135°/225°/315° 타일 추가',
            h('br'),
            'Shift+방향키 = 15° 미세 조정 · ←/→ 선택 이동 · Backspace 삭제 · T 회전 반전',
            h('br'),
            'Ctrl+Z/Y 실행 취소/다시 실행 · Space 플레이테스트 · F 선택 타일로',
            h('br'),
            '줌: 마우스 휠 · 두 손가락 핀치 · +/− 키 · 0 전체 보기 · 드래그로 이동',
          ),
        )),
        this.side,
        bottom,
      ),
    );
    this.renderSide();
    requestAnimationFrame(() => this.wave.draw());
  }

  private renderSide(): void {
    const side = this.side;
    if (!side) return;
    const scroll = side.scrollTop;
    side.innerHTML = '';
    side.append(this.tileSection(), this.musicSection(), this.toolsSection(), this.levelSection());
    side.scrollTop = scroll;
  }

  private tileSection(): HTMLElement {
    const tile = this.chart.tiles[this.sel];
    const isFinish = this.sel >= this.level.path.length;
    const angle = h('input', {
      type: 'number',
      step: 15,
      value: isFinish ? '' : String(this.level.path[this.sel]),
      disabled: isFinish,
      onchange: () => {
        const v = Number(angle.value);
        if (Number.isFinite(v)) this.commit(setOutAngle(this.level, this.sel, v));
      },
    });
    const events = this.level.actions
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.floor === this.sel)
      .map(({ a, i }) => this.eventEditor(a, i));
    const typeSel = h('select', null, ...ACTION_TYPES.map((t) => h('option', { value: t }, `${ACTION_LABEL[t]} (${t})`)));
    return h(
      'div',
      { class: 'col' },
      h('h3', null, `타일 ${this.sel}${this.sel === 0 ? ' (시작)' : isFinish ? ' (도착)' : ''}`),
      h(
        'div',
        { class: 'form' },
        h('label', null, '나가는 각도'),
        angle,
        h('label', null, '박 수'),
        h('span', null, `${fmtBeats(tile.beats)}박 (θ ${Math.round(tile.theta)}°, ${tile.dir === 'CW' ? '시계' : '반시계'})`),
        h('label', null, 'BPM / 시각'),
        h('span', null, `${+tile.bpm.toFixed(3)} · ${tile.time.toFixed(3)}s`),
      ),
      ...events,
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, typeSel),
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => this.commit(addAction(this.level, defaultAction(typeSel.value as ActionType, this.sel, this.chart.finish))),
          },
          '이벤트 추가',
        ),
      ),
    );
  }

  private eventEditor(a: Action, index: number): HTMLElement {
    const fields = SCHEMA[a.type];
    const update = (k: string, v: unknown) => {
      const next = { ...a } as Record<string, unknown>;
      if (v === undefined) delete next[k];
      else next[k] = v;
      this.commit(replaceAction(this.level, index, next as unknown as Action));
    };
    const rec = a as unknown as Record<string, unknown>;
    const inputs = fields.map((f) => [h('label', null, f.label), this.fieldInput(f, rec[f.k], (v) => update(f.k, v))]).flat();
    return h(
      'div',
      { class: 'ev' },
      h(
        'div',
        { class: 'head' },
        h('span', { class: 'grow' }, `${ACTION_LABEL[a.type]}`, h('span', { class: 'dim', style: 'font-weight:400' }, ` ${a.type}`)),
        h('button', { class: 'btn small danger', onclick: () => this.commit(removeAction(this.level, index)) }, '삭제'),
      ),
      fields.length ? h('div', { class: 'form' }, ...inputs) : null,
    );
  }

  private fieldInput(f: Field, value: unknown, set: (v: unknown) => void): HTMLElement {
    const opt = (s: string) => (f.optional && s.trim() === '' ? undefined : s);
    switch (f.kind) {
      case 'num':
      case 'int': {
        const inp = h('input', {
          type: 'number',
          step: f.step ?? (f.kind === 'int' ? 1 : 0.1),
          value: value === undefined ? '' : String(value),
          placeholder: f.optional ? '(유지)' : '',
          onchange: () => {
            const s = opt(inp.value);
            if (s === undefined) return set(undefined);
            const n = Number(s);
            if (Number.isFinite(n)) set(f.kind === 'int' ? Math.round(n) : n);
          },
        });
        return inp;
      }
      case 'color': {
        const on = h('input', {
          type: 'checkbox',
          checked: value !== undefined || !f.optional,
          disabled: !f.optional,
          onchange: () => set(on.checked ? col.value : undefined),
        });
        const col = h('input', {
          type: 'color',
          value: typeof value === 'string' ? toHex(parseInt(value.replace('#', '').padEnd(6, '0'), 16)) : '#ffffff',
          onchange: () => set(col.value),
        });
        return h('div', { class: 'row' }, f.optional ? on : null, col);
      }
      case 'vec': {
        const v = Array.isArray(value) ? (value as number[]) : null;
        const mk = (i: number) =>
          h('input', {
            type: 'number',
            step: 10,
            value: v ? String(v[i]) : '',
            placeholder: i === 0 ? 'x' : 'y',
            onchange: () => {
              if (x.value === '' && y.value === '' && f.optional) return set(undefined);
              set([Number(x.value) || 0, Number(y.value) || 0]);
            },
          });
        const x = mk(0);
        const y = mk(1);
        return h('div', { class: 'row', style: 'flex-wrap:nowrap' }, x, y);
      }
      case 'ease': {
        const s = h(
          'select',
          { onchange: () => set(s.value || undefined) },
          h('option', { value: '' }, '(linear)'),
          ...EASE_NAMES.map((e) => h('option', { value: e }, e)),
        );
        s.value = typeof value === 'string' ? value : '';
        return s;
      }
      case 'text': {
        const inp = h('input', {
          type: 'text',
          value: typeof value === 'string' ? value : '',
          onchange: () => set(opt(inp.value) ?? (f.optional ? undefined : '')),
        });
        return inp;
      }
    }
  }

  private toolsSection(): HTMLElement {
    const modeSel = h(
      'select',
      { onchange: () => (this.recMode = modeSel.value as RecordMode) },
      h('option', { value: 'oneway' }, '한 방향 회전'),
      h('option', { value: 'zigzag' }, '지그재그'),
      h('option', { value: 'straight' }, '직진 우선'),
    );
    modeSel.value = this.recMode;
    const cnt = h('input', { type: 'number', min: 1, max: 1000, value: this.fillCount, onchange: () => (this.fillCount = Math.max(1, Math.round(Number(cnt.value) || 1))) });
    const bpm = h('input', {
      type: 'number',
      min: 0,
      value: this.fillBpm || '',
      placeholder: '현재 BPM 유지',
      onchange: () => (this.fillBpm = Math.max(0, Number(bpm.value) || 0)),
    });
    const auto = h('input', { type: 'checkbox', checked: this.autoplay, onchange: () => (this.autoplay = auto.checked) });
    return h(
      'div',
      { class: 'col' },
      h('h3', null, '도구'),
      h(
        'div',
        { class: 'form' },
        h('label', null, '녹화 방향'),
        modeSel,
        h('label', { for: 'rec-speed' }, '녹화 속도'),
        (() => {
          const sp = h(
            'select',
            { id: 'rec-speed', onchange: () => (this.recSpeed = Number(sp.value) || 1) },
            h('option', { value: '1' }, '×1 (원래 속도)'),
            h('option', { value: '0.75' }, '×0.75'),
            h('option', { value: '0.5' }, '×0.5 (절반 — 빠른 구간 연습)'),
          );
          sp.value = String(this.recSpeed);
          return sp;
        })(),
        h('label', null, ''),
        h(
          'label',
          { class: 'row dim', style: 'font-size:12px' },
          h('input', { type: 'checkbox', id: 'rec-over', checked: this.recOverwrite, onchange: (e: Event) => (this.recOverwrite = (e.target as HTMLInputElement).checked) }),
          '선택 타일 뒤를 지우고 녹화 (덮어쓰기)',
        ),
        h('label', null, '녹화'),
        this.recording
          ? h('button', { class: 'btn small danger', onclick: () => this.stopRecording(true) }, '■ 녹화 중지 (Esc)')
          : h('button', { class: 'btn small', onclick: () => void this.startRecording() }, '● 선택 타일부터 녹화'),
        h('label', null, '직진 채우기'),
        h('div', { class: 'row', style: 'flex-wrap:nowrap' }, cnt, bpm),
        h('label', null, ''),
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => {
              const r = fillStraight(this.level, this.sel, this.fillCount, this.fillBpm || undefined);
              this.commit(r.level, r.sel);
            },
          },
          '1박 직진 타일 채우기',
        ),
        h('label', null, '자동 플레이'),
        h('label', { class: 'row' }, auto, h('span', { class: 'dim' }, '플레이테스트에 적용')),
      ),
    );
  }

  private levelSection(): HTMLElement {
    const lv = this.level;
    const setMeta = (k: keyof LevelData['meta'], v: string | number) => {
      const n = cloneLevel(this.level);
      (n.meta as unknown as Record<string, unknown>)[k] = v;
      this.commit(n);
    };
    const setSet = (k: keyof LevelData['settings'], v: string | number) => {
      const n = cloneLevel(this.level);
      (n.settings as unknown as Record<string, unknown>)[k] = v;
      this.commit(n);
    };
    const txt = (v: string, on: (s: string) => void) => {
      const i = h('input', { type: 'text', value: v, onchange: () => on(i.value) });
      return i;
    };
    const num = (v: number, step: number, on: (n: number) => void) => {
      const i = h('input', {
        type: 'number',
        step,
        value: String(v),
        onchange: () => {
          const n = Number(i.value);
          if (Number.isFinite(n)) on(n);
        },
      });
      return i;
    };
    const color = (v: string, on: (s: string) => void) => {
      const i = h('input', { type: 'color', value: v.length === 7 ? v : '#000000', onchange: () => on(i.value) });
      return i;
    };
    const dir = h(
      'select',
      { onchange: () => setSet('startDirection', dir.value) },
      h('option', { value: 'CW' }, '시계 (CW)'),
      h('option', { value: 'CCW' }, '반시계 (CCW)'),
    );
    dir.value = lv.settings.startDirection;
    const s = lv.settings;
    return h(
      'div',
      { class: 'col' },
      h('h3', null, '레벨 설정'),
      h(
        'div',
        { class: 'form' },
        h('label', null, '제목'),
        txt(lv.meta.title, (v) => setMeta('title', v)),
        h('label', null, '아티스트'),
        txt(lv.meta.artist, (v) => setMeta('artist', v)),
        h('label', null, '제작자'),
        txt(lv.meta.author, (v) => setMeta('author', v)),
        h('label', null, '난이도'),
        num(lv.meta.difficulty, 1, (v) => setMeta('difficulty', Math.max(1, Math.min(10, Math.round(v))))),
        h('label', null, '미리듣기(초)'),
        num(lv.meta.previewStart, 0.5, (v) => setMeta('previewStart', Math.max(0, v))),
        h('label', null, '음원'),
        h('span', { class: 'dim', style: 'word-break:break-all' }, s.songFile || '(없음 — 합성 비트)'),
        h('label', null, 'BPM'),
        num(s.bpm, 1, (v) => v > 0 && setSet('bpm', v)),
        h('label', null, 'offset(초)'),
        num(s.offset, 0.01, (v) => setSet('offset', v)),
        h('label', null, 'pitch'),
        num(s.pitch, 0.05, (v) => setSet('pitch', Math.max(0.25, Math.min(4, v)))),
        h('label', null, '볼륨'),
        num(s.volume, 0.05, (v) => setSet('volume', Math.max(0, Math.min(1, v)))),
        h('label', null, '카운트다운'),
        num(s.countdownTicks, 1, (v) => setSet('countdownTicks', Math.max(0, Math.min(16, Math.round(v))))),
        h('label', null, '트랙 색'),
        color(s.trackColor, (v) => setSet('trackColor', v)),
        h('label', null, '배경 색'),
        color(s.bgColor, (v) => setSet('bgColor', v)),
        h('label', null, '시작 방향'),
        dir,
      ),
    );
  }

  // ───────────────────────── 프레임 ─────────────────────────

  private frame(): void {
    if (this.dirtyTrack) {
      this.track?.destroy();
      this.track = new TrackView(this.chart, this.timeline, { editor: true });
      stage.clearWorld();
      stage.world.addChild(this.track.container);
      this.dirtyTrack = false;
    }
    const tile = this.chart.tiles[this.sel];
    this.timeline.update(tile.time);
    stage.setBackground(this.timeline.bgColor);
    stage.tick();
    this.track!.update({
      passed: 0,
      pulse: 0,
      now: performance.now(),
      view: stage.viewRect(),
      selected: this.sel,
      showBeats: stage.camera.zoom > 0.35,
    });
    stage.frame(0, 0);
    if (this.previewing) {
      this.wave.playhead = this.eng.songTime();
      this.wave.focus(this.wave.playhead);
      this.wave.draw();
      // 재생 위치의 타일을 따라 선택 표시
      const t = this.wave.playhead;
      let i = this.sel;
      while (i < this.chart.finish && this.chart.times[i + 1] <= t) i++;
      if (i !== this.sel) {
        this.sel = i;
        this.wave.selected = i;
        this.ensureVisible();
      }
      this.recBadge.textContent = '▶ 박 확인 중 — Esc 또는 Space로 정지';
    } else if (this.recording) {
      this.wave.playhead = this.eng.songTime();
      this.wave.focus(this.wave.playhead);
      this.wave.draw();
      this.recBadge.textContent = `● 녹화 중 — 박에 맞춰 아무 키 · Esc 중지 (${this.recording.presses.length})`;
    } else if (this.recBadge.textContent) this.recBadge.textContent = '';
    if (this.zoomLabel) {
      const z = `${Math.round(stage.camera.zoom * 100)}%`;
      if (this.zoomLabel.textContent !== z) this.zoomLabel.textContent = z;
    }
    const out = this.sel < this.level.path.length ? `${+normDeg(this.level.path[this.sel]).toFixed(2)}°` : '—';
    this.info.textContent = `타일 ${this.sel} / ${this.chart.finish} · 방향 ${out} · ${fmtBeats(tile.beats)}박 · ${+tile.bpm.toFixed(2)} BPM · ${tile.time.toFixed(3)}s`;
  }
}

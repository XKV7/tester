import type { Chart, TimedAction } from './chart';
import { lerpColor, parseColor } from './color';
import { ease } from './ease';
import { lerp } from './math';
import type { Decoration, EaseName, TrackAppear, TrackDisappear } from './types';

/** 카메라 기준점 (월드 좌표, y 위쪽). player = 현재 행성 타일을 따라감. */
export type CameraAnchor = { kind: 'player' } | { kind: 'fixed'; x: number; y: number };

export interface CameraState {
  zoom: number;
  rotation: number;
  /** 기준점에서의 오프셋 (월드 단위, y 위쪽). */
  ox: number;
  oy: number;
  anchor: CameraAnchor;
  /** 기준이 바뀌는 중이면 이전 기준 (mix 0 → 1로 옮겨 감). */
  prevAnchor: CameraAnchor;
  mix: number;
}

export interface FilterState {
  intensity: number;
}

export interface BloomState {
  intensity: number;
  threshold: number;
  color: number;
}

/** 장식의 현재 상태 (원래 값 + MoveDecorations로 바뀐 값). */
export interface DecoState {
  def: Decoration;
  tags: string[];
  ox: number;
  oy: number;
  rot: number;
  sx: number;
  sy: number;
  color: number;
  opacity: number;
  visible: boolean;
  image: string | null;
}

/** 타일 등장·퇴장 설정 (타일마다, 그 타일 이전의 마지막 TrackAnim 기준). */
export interface TileAnimCfg {
  appear: TrackAppear;
  ahead: number;
  disappear: TrackDisappear;
  behind: number;
}

/** 타일 하나의 등장·퇴장 결과. */
export interface TileAnimResult {
  alpha: number;
  scale: number;
  dx: number;
  dy: number;
  rot: number;
}

const PLAYER: CameraAnchor = { kind: 'player' };

interface ActiveAnim {
  ev: TimedAction;
  apply: (p: number) => void;
}

/**
 * 연출 이벤트(Camera, Flash, RecolorTrack, MoveTrack, Background) 상태를
 * 곡 시각 기준으로 계산한다. 순수 로직 — 렌더러는 상태 배열을 읽기만 한다.
 * 시간이 뒤로 가면(체크포인트 재개) 처음부터 다시 재생한다.
 */
export class VisualTimeline {
  camera: CameraState = { zoom: 1, rotation: 0, ox: 0, oy: 0, anchor: PLAYER, prevAnchor: PLAYER, mix: 1 };
  flashColor = 0xffffff;
  flashAlpha = 0;
  bgColor: number;
  bgImage: string | null = null;
  bgFit: 'cover' | 'contain' | 'unscaled' | 'tile' = 'cover';
  bgTint = 0xffffff;
  bgOpacity = 0.55;
  /** 켜진 필터 (원작 이름 → 세기). */
  readonly filters = new Map<string, FilterState>();
  bloom: BloomState = { intensity: 0, threshold: 0.5, color: 0xffffff };
  /** 화면 흔들림 (월드 단위, 매 update에서 계산). */
  shakeX = 0;
  shakeY = 0;
  private shakes: { t0: number; dur: number; strength: number; freq: number; fade: boolean }[] = [];
  readonly decos: DecoState[];
  /** 'last' 기준 카메라가 시작할 때 현재 카메라 중심(월드, y 위쪽)을 묻는다. 없으면 이전 기준 유지. */
  resolveCenter: (() => { x: number; y: number }) | null = null;
  readonly tileScale: Float32Array;
  /** 타일별 등장·퇴장 설정 (없으면 null = 항상 보임). */
  readonly tileAnim: (TileAnimCfg | null)[];
  readonly tileColor: Uint32Array;
  readonly tileOffX: Float32Array;
  readonly tileOffY: Float32Array;
  readonly tileRot: Float32Array;
  readonly tileAlpha: Float32Array;
  /** 상태가 바뀔 때마다 증가 (렌더러 캐시 무효화용). */
  version = 0;

  private idx = 0;
  private active: ActiveAnim[] = [];
  private lastT = -Infinity;
  private readonly baseTrack: number;
  private readonly baseBg: number;

  constructor(private readonly chart: Chart) {
    const n = chart.tiles.length;
    this.baseTrack = parseColor(chart.level.settings.trackColor, 0x3a3f55);
    this.baseBg = parseColor(chart.level.settings.bgColor, 0x0e0f16);
    this.bgColor = this.baseBg;
    this.tileColor = new Uint32Array(n);
    this.tileOffX = new Float32Array(n);
    this.tileOffY = new Float32Array(n);
    this.tileRot = new Float32Array(n);
    this.tileAlpha = new Float32Array(n);
    this.tileScale = new Float32Array(n);
    this.decos = (chart.level.decorations ?? []).map((def) => ({
      def,
      tags: (def.tag ?? '').split(/\s+/).filter(Boolean),
      ox: 0,
      oy: 0,
      rot: 0,
      sx: 1,
      sy: 1,
      color: 0xffffff,
      opacity: 1,
      visible: true,
      image: null,
    }));
    // TrackAnim은 그 타일부터 뒤로 적용 (시간이 아니라 타일 기준 — 미리 계산)
    this.tileAnim = new Array(n).fill(null);
    const anims = chart.level.actions.filter((a) => a.type === 'TrackAnim').sort((a, b) => a.floor - b.floor);
    let cur: TileAnimCfg | null = null;
    let ai = 0;
    for (let i = 0; i < n; i++) {
      while (ai < anims.length && anims[ai].floor <= i) {
        const a = anims[ai++];
        if (a.type !== 'TrackAnim') continue;
        const next: TileAnimCfg = {
          appear: a.appear ?? cur?.appear ?? 'none',
          ahead: a.beatsAhead ?? cur?.ahead ?? 3,
          disappear: a.disappear ?? cur?.disappear ?? 'none',
          behind: a.beatsBehind ?? cur?.behind ?? 4,
        };
        cur = next.appear === 'none' && next.disappear === 'none' ? null : next;
      }
      this.tileAnim[i] = cur;
    }
    this.reset();
  }

  reset(): void {
    this.camera = { zoom: 1, rotation: 0, ox: 0, oy: 0, anchor: PLAYER, prevAnchor: PLAYER, mix: 1 };
    this.flashAlpha = 0;
    this.bgColor = this.baseBg;
    this.bgImage = null;
    this.bgFit = 'cover';
    this.bgTint = 0xffffff;
    this.bgOpacity = 0.55;
    this.filters.clear();
    this.bloom = { intensity: 0, threshold: 0.5, color: 0xffffff };
    this.shakes = [];
    this.shakeX = 0;
    this.shakeY = 0;
    this.tileScale.fill(1);
    for (const d of this.decos) {
      d.ox = 0;
      d.oy = 0;
      d.rot = 0;
      d.sx = 1;
      d.sy = 1;
      d.color = parseColor(d.def.color, 0xffffff);
      d.opacity = d.def.opacity ?? 1;
      d.visible = d.def.visible !== false;
      d.image = d.def.image ?? null;
    }
    this.tileColor.fill(this.baseTrack);
    this.tileOffX.fill(0);
    this.tileOffY.fill(0);
    this.tileRot.fill(0);
    this.tileAlpha.fill(1);
    this.idx = 0;
    this.active = [];
    this.lastT = -Infinity;
    this.version++;
  }

  update(t: number): void {
    if (t < this.lastT - 1e-9) this.reset();
    const evs = this.chart.visual;
    while (this.idx < evs.length && evs[this.idx].time <= t) {
      const ev = evs[this.idx++];
      this.advance(ev.time);
      const anim = this.start(ev);
      if (anim) this.active.push(anim);
    }
    this.advance(t);
    this.updateShake(t);
    this.lastT = t;
  }

  private updateShake(t: number): void {
    this.shakeX = 0;
    this.shakeY = 0;
    if (!this.shakes.length) return;
    this.shakes = this.shakes.filter((s) => t < s.t0 + s.dur);
    for (const s of this.shakes) {
      const p = (t - s.t0) / Math.max(1e-6, s.dur);
      if (p < 0) continue;
      const amp = s.strength * (s.fade ? 1 - p : 1);
      // 결정적인 흔들림 (같은 시각이면 같은 위치 — 되감기해도 같음)
      const w = t * s.freq * Math.PI * 2;
      this.shakeX += amp * (Math.sin(w * 1.0) * 0.6 + Math.sin(w * 2.3 + 1.7) * 0.4);
      this.shakeY += amp * (Math.sin(w * 1.3 + 0.5) * 0.6 + Math.sin(w * 2.9 + 2.1) * 0.4);
    }
  }

  /**
   * 타일 i의 등장·퇴장 상태 (곡 시각 t). 설정이 없으면 null (항상 보임).
   * beatsAhead 박 전부터 짧게 나타나고, 친 뒤 beatsBehind 박이 지나면 사라진다.
   */
  tileAnimAt(i: number, t: number): TileAnimResult | null {
    const cfg = this.tileAnim[i];
    if (!cfg) return null;
    const tile = this.chart.tiles[i];
    const beat = 60 / tile.bpm;
    const out: TileAnimResult = { alpha: 1, scale: 1, dx: 0, dy: 0, rot: 0 };
    const len = Math.min(0.35, beat); // 애니메이션 길이 (초)
    const seed = Math.sin(i * 12.9898) * 43758.5453;
    const rx = (seed - Math.floor(seed)) * 2 - 1;
    const ry = ((seed * 7.13) % 1 + 1) % 1 * 2 - 1;
    if (cfg.appear !== 'none') {
      const t0 = tile.time - cfg.ahead * beat;
      const p = (t - t0) / len;
      if (p <= 0) return { ...out, alpha: 0 };
      if (p < 1) {
        const k = ease('outSine', p);
        switch (cfg.appear) {
          case 'fade':
            out.alpha = k;
            break;
          case 'grow':
          case 'extend':
            out.scale = k;
            out.alpha = Math.min(1, p * 3);
            break;
          case 'spin':
            out.scale = k;
            out.rot = (1 - k) * 180;
            break;
          case 'drop':
            out.dy = (1 - k) * 150;
            out.alpha = k;
            break;
          case 'rise':
            out.dy = -(1 - k) * 150;
            out.alpha = k;
            break;
          case 'scatter':
            out.dx = (1 - k) * rx * 400;
            out.dy = (1 - k) * ry * 400;
            out.alpha = k;
            break;
        }
      }
    }
    if (cfg.disappear !== 'none') {
      const t1 = tile.time + cfg.behind * beat;
      const p = (t - t1) / len;
      if (p >= 1) return { ...out, alpha: 0 };
      if (p > 0) {
        const k = ease('inSine', p);
        switch (cfg.disappear) {
          case 'fade':
            out.alpha *= 1 - k;
            break;
          case 'shrink':
          case 'retract':
            out.scale *= 1 - k;
            break;
          case 'spin':
            out.scale *= 1 - k;
            out.rot += k * 180;
            break;
          case 'scatter':
            out.dx += k * rx * 400;
            out.dy += k * ry * 400;
            out.alpha *= 1 - k;
            break;
        }
      }
    }
    return out;
  }

  private advance(t: number): void {
    if (this.active.length === 0) return;
    this.active = this.active.filter((a) => {
      const p = a.ev.duration > 0 ? (t - a.ev.time) / a.ev.duration : 1;
      const c = p < 0 ? 0 : p > 1 ? 1 : p;
      a.apply(c);
      return c < 1;
    });
    this.version++;
  }

  private start(ev: TimedAction): ActiveAnim | null {
    const a = ev.action;
    const n = this.chart.tiles.length;
    switch (a.type) {
      case 'Camera': {
        const from = { ...this.camera };
        // 새 기준점: 지정이 없으면 그대로
        let anchor = from.anchor;
        let ox0 = from.ox;
        let oy0 = from.oy;
        const rel = a.relativeTo;
        if (rel === 'player') anchor = PLAYER;
        else if (rel === 'global') anchor = { kind: 'fixed', x: 0, y: 0 };
        else if (rel === 'tile') {
          const ti = this.chart.tiles[Math.max(0, Math.min(n - 1, a.tile ?? a.floor))];
          anchor = { kind: 'fixed', x: ti.x, y: ti.y };
        } else if (rel === 'last' && this.resolveCenter) {
          // 직전 카메라 위치에 고정: 기준을 그 자리로 옮기고 오프셋은 0에서 시작
          const c = this.resolveCenter();
          anchor = { kind: 'fixed', x: c.x, y: c.y };
          ox0 = 0;
          oy0 = 0;
          from.anchor = anchor;
        }
        const changed = rel !== undefined && rel !== 'last' && !sameAnchor(anchor, from.anchor);
        const to = {
          zoom: a.zoom ?? from.zoom,
          rotation: a.rotation ?? from.rotation,
          ox: a.offset ? a.offset[0] : rel && rel !== 'last' ? 0 : ox0,
          oy: a.offset ? a.offset[1] : rel && rel !== 'last' ? 0 : oy0,
        };
        const prev = changed ? from.anchor : anchor;
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            this.camera = {
              zoom: lerp(from.zoom, to.zoom, k),
              rotation: lerp(from.rotation, to.rotation, k),
              ox: lerp(ox0, to.ox, k),
              oy: lerp(oy0, to.oy, k),
              anchor,
              prevAnchor: prev,
              mix: changed ? k : 1,
            };
          },
        };
      }
      case 'Flash': {
        const color = parseColor(a.color, 0xffffff);
        const op = a.opacity ?? 0.6;
        this.flashColor = color;
        return {
          ev: ev.duration > 0 ? ev : { ...ev, duration: 0.25 },
          apply: (p) => {
            if (this.flashColor === color) this.flashAlpha = op * (1 - p);
          },
        };
      }
      case 'Background': {
        if (a.color) this.bgColor = parseColor(a.color, this.bgColor);
        if (a.image !== undefined) this.bgImage = a.image || null;
        if (a.fit) this.bgFit = a.fit;
        if (a.tint) this.bgTint = parseColor(a.tint, 0xffffff);
        if (a.opacity !== undefined) this.bgOpacity = a.opacity;
        this.version++;
        return null;
      }
      case 'RecolorTrack': {
        const lo = Math.max(0, a.from);
        const hi = Math.min(n - 1, a.to);
        if (hi < lo) return null;
        const target = parseColor(a.color, this.baseTrack);
        const from = this.tileColor.slice(lo, hi + 1);
        return {
          ev,
          apply: (p) => {
            for (let i = lo; i <= hi; i++) this.tileColor[i] = p >= 1 ? target : lerpColor(from[i - lo], target, p);
          },
        };
      }
      case 'MoveTrack': {
        const lo = Math.max(0, a.from);
        const hi = Math.min(n - 1, a.to);
        if (hi < lo) return null;
        const fx = this.tileOffX.slice(lo, hi + 1);
        const fy = this.tileOffY.slice(lo, hi + 1);
        const fr = this.tileRot.slice(lo, hi + 1);
        const fa = this.tileAlpha.slice(lo, hi + 1);
        const fs = this.tileScale.slice(lo, hi + 1);
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            for (let i = lo; i <= hi; i++) {
              const j = i - lo;
              if (a.offset) {
                this.tileOffX[i] = lerp(fx[j], a.offset[0], k);
                this.tileOffY[i] = lerp(fy[j], a.offset[1], k);
              }
              if (a.rotation !== undefined) this.tileRot[i] = lerp(fr[j], a.rotation, k);
              if (a.opacity !== undefined) this.tileAlpha[i] = lerp(fa[j], a.opacity, k);
              if (a.scale !== undefined) this.tileScale[i] = lerp(fs[j], a.scale, k);
            }
          },
        };
      }
      case 'Filter': {
        if (a.exclusive) for (const k of [...this.filters.keys()]) if (k !== a.filter) this.filters.delete(k);
        const cur = this.filters.get(a.filter)?.intensity ?? 0;
        const target = a.enabled ? (a.intensity ?? 1) : 0;
        return {
          ev,
          apply: (p) => {
            const v = lerp(cur, target, p);
            if (p >= 1 && target <= 0) this.filters.delete(a.filter);
            else this.filters.set(a.filter, { intensity: v });
          },
        };
      }
      case 'Bloom': {
        this.bloom = a.enabled
          ? { intensity: a.intensity ?? 1, threshold: a.threshold ?? 0.5, color: parseColor(a.color, 0xffffff) }
          : { ...this.bloom, intensity: 0 };
        this.version++;
        return null;
      }
      case 'Shake': {
        this.shakes.push({ t0: ev.time, dur: ev.duration, strength: (a.strength ?? 1) * 30, freq: a.frequency ?? 15, fade: a.fadeOut !== false });
        return null;
      }
      case 'MoveDecorations': {
        const tags = a.tag.split(/\s+/).filter(Boolean);
        const targets = this.decos.filter((d) => d.tags.some((t) => tags.includes(t)));
        if (!targets.length) return null;
        const col = a.color !== undefined ? parseColor(a.color, 0xffffff) : null;
        const from = targets.map((d) => ({ ox: d.ox, oy: d.oy, rot: d.rot, sx: d.sx, sy: d.sy, color: d.color, opacity: d.opacity }));
        for (const d of targets) {
          if (a.visible !== undefined) d.visible = a.visible;
          if (a.image !== undefined) d.image = a.image || null;
        }
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            targets.forEach((d, j) => {
              const f = from[j];
              if (a.offset) {
                d.ox = lerp(f.ox, a.offset[0], k);
                d.oy = lerp(f.oy, a.offset[1], k);
              }
              if (a.rotation !== undefined) d.rot = lerp(f.rot, a.rotation, k);
              if (a.scale) {
                d.sx = lerp(f.sx, a.scale[0], k);
                d.sy = lerp(f.sy, a.scale[1], k);
              }
              if (col !== null) d.color = p >= 1 ? col : lerpColor(f.color, col, p);
              if (a.opacity !== undefined) d.opacity = lerp(f.opacity, a.opacity, k);
            });
          },
        };
      }
      default:
        return null;
    }
  }
}

function sameAnchor(a: CameraAnchor, b: CameraAnchor): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'player' || (b.kind === 'fixed' && a.x === b.x && a.y === b.y);
}

/** 카메라 중심 (월드, y 위쪽): 기준점 사이를 섞고 오프셋을 더한다. player = 현재 행성 타일 위치. */
export function cameraCenter(cam: CameraState, player: { x: number; y: number }): { x: number; y: number } {
  const at = (a: CameraAnchor) => (a.kind === 'player' ? player : a);
  const p = at(cam.prevAnchor);
  const q = at(cam.anchor);
  return { x: lerp(p.x, q.x, cam.mix) + cam.ox, y: lerp(p.y, q.y, cam.mix) + cam.oy };
}

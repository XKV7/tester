import type { Chart, TimedAction } from './chart';
import { lerpColor, parseColor } from './color';
import { ease } from './ease';
import { lerp } from './math';
import type { EaseName } from './types';

export interface CameraState {
  zoom: number;
  rotation: number;
  ox: number;
  oy: number;
}

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
  camera: CameraState = { zoom: 1, rotation: 0, ox: 0, oy: 0 };
  flashColor = 0xffffff;
  flashAlpha = 0;
  bgColor: number;
  bgImage: string | null = null;
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
    this.reset();
  }

  reset(): void {
    this.camera = { zoom: 1, rotation: 0, ox: 0, oy: 0 };
    this.flashAlpha = 0;
    this.bgColor = this.baseBg;
    this.bgImage = null;
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
    this.lastT = t;
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
        const to: CameraState = {
          zoom: a.zoom ?? from.zoom,
          rotation: a.rotation ?? from.rotation,
          ox: a.offset ? a.offset[0] : from.ox,
          oy: a.offset ? a.offset[1] : from.oy,
        };
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            this.camera = {
              zoom: lerp(from.zoom, to.zoom, k),
              rotation: lerp(from.rotation, to.rotation, k),
              ox: lerp(from.ox, to.ox, k),
              oy: lerp(from.oy, to.oy, k),
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
            }
          },
        };
      }
      default:
        return null;
    }
  }
}

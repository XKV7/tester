import type { Chart, TimedAction } from './chart';
import { lerpColor, parseColor } from './color';
import { ease } from './ease';
import { lerp } from './math';
import { FILTER_NEUTRAL_ONE } from './level';
import type { DecoMask, Decoration, EaseName, TrackAppear, TrackDisappear, TrackStyle } from './types';

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
  /** 색의 불투명도 (원작 8자리 색) */
  calpha: number;
  /** 카메라 따라가기 비율·기준점 이동 */
  parx: number;
  pary: number;
  pox: number;
  poy: number;
  visible: boolean;
  image: string | null;
  /** 가리기 (없으면 null) */
  mask: DecoMask | null;
  /** 깊이 (작을수록 앞) */
  depth: number;
  /** 글자 장식의 지금 글자 (null = 처음 글자) */
  text: string | null;
  /** 입자: 방출 중인지, 방출 시작 시각 (초) */
  emitting: boolean;
  emitSince: number;
  /** 입자: 아직 뿜지 않은 한 번에 뿜기 수 (렌더러가 가져가며 0으로) */
  burst: number;
  /** 입자: 지우기 요청 번호 (바뀌면 렌더러가 모두 지움) */
  clearSerial: number;
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

/** 타일 모양 번호 ↔ 이름. */
export const TRACK_STYLES: TrackStyle[] = ['orbit', 'standard', 'neon', 'basic', 'neonlight'];

interface ActiveAnim {
  ev: TimedAction;
  apply: (p: number) => void;
  /** 같은 채널의 새 이벤트가 오면 이전 것은 멈춘다 (원작: 새 카메라 이동이 이전 이동을 대체). */
  chan?: string;
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
  /** 배경 쪽 플래시 (트랙 뒤) */
  bgFlashColor = 0x000000;
  bgFlashAlpha = 0;
  bgColor: number;
  bgImage: string | null = null;
  bgVideo: string | null = null;
  bgVideoOffset = 0;
  bgVideoLoop = false;
  bgFit: 'cover' | 'contain' | 'unscaled' | 'tile' = 'cover';
  bgTint = 0xffffff;
  bgOpacity = 0.55;
  /** 켜진 필터 (원작 이름 → 세기). */
  readonly filters = new Map<string, FilterState>();
  bloom: BloomState = { intensity: 0, threshold: 0.5, color: 0xffffff };
  /** 행성 공전 반지름·크기 배율 (원작 ScaleRadius·ScalePlanets) */
  planetRadius = 1;
  planetSize = 1;
  /** 화면 반복 (가로·세로 횟수, 음수 = 뒤집기)·흐름 (초당 화면 수)·잔상·끊김(초당 장면, 0 = 끔) */
  screenTile: [number, number] = [1, 1];
  screenScroll: [number, number] = [0, 0];
  mirrors = false;
  fps = 0;
  /** 화면 흔들림 (월드 단위, 매 update에서 계산). */
  shakeX = 0;
  shakeY = 0;
  private shakes: { t0: number; dur: number; strength: number; freq: number; fade: boolean }[] = [];
  readonly decos: DecoState[];
  /**
   * 카메라가 따라가는 행성 위치 (월드, y 위쪽). '직전 위치' 카메라는 이걸로 지금 중심을 바로 계산한다
   * (같은 순간의 앞 이벤트까지 반영 — 지난 프레임 값이면 같은 타일의 '타일로 순간 이동'을 놓친다). 없으면 이전 기준 유지.
   */
  playerPos: (() => { x: number; y: number }) | null = null;
  private currentCenter(): { x: number; y: number } | null {
    return this.playerPos ? cameraCenter(this.camera, this.playerPos()) : null;
  }
  readonly tileScale: Float32Array;
  /** 타일 모양 (TRACK_STYLES 번호). */
  readonly tileStyle: Uint8Array;
  /** 물결(원작 Glow) 두 번째 색 — 0xff000000 비트가 있으면 없음. */
  readonly tileColor2: Float64Array;
  readonly tileGlowDur: Float32Array;
  /** 지나간 타일이 하얗게 빛나는 정도 (0~1) */
  readonly tileLit: Float32Array;
  readonly tilePulseLen: Float32Array;
  /** 색 움직임: 0 물결, 1 번갈아(blink), 2 무지개. 물결 뒤쪽이면 +4 */
  readonly tileColorMode: Uint8Array;
  /** 타일별 등장·퇴장 설정 (없으면 null = 항상 보임). */
  readonly tileAnim: (TileAnimCfg | null)[];
  readonly tileColor: Uint32Array;
  readonly tileOffX: Float32Array;
  readonly tileOffY: Float32Array;
  readonly tileRot: Float32Array;
  readonly tileAlpha: Float32Array;
  /**
   * 트랙 이동(MoveTrack)이 이 타일의 불투명도를 처음 정한 시각 (없으면 NaN).
   * 원작처럼 불투명도는 하나의 값이라, 등장 애니메이션보다 먼저 이동 이벤트가 정했으면 그 값을 따른다.
   */
  private readonly tileOpSet: Float64Array;
  /** 타일·속성별로 지금 값을 정하는 이동 이벤트 번호 (나중 이벤트가 앞 이벤트를 끊는다) */
  private readonly claimPos: Int32Array;
  private readonly claimRot: Int32Array;
  private readonly claimAlpha: Int32Array;
  private readonly claimScale: Int32Array;
  private moveSerial = 0;
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
    this.tileOpSet = new Float64Array(n).fill(NaN);
    this.claimPos = new Int32Array(n);
    this.claimRot = new Int32Array(n);
    this.claimAlpha = new Int32Array(n);
    this.claimScale = new Int32Array(n);
    this.tileScale = new Float32Array(n);
    this.tileStyle = new Uint8Array(n);
    this.tileColor2 = new Float64Array(n);
    this.tileGlowDur = new Float32Array(n);
    this.tileLit = new Float32Array(n);
    this.tilePulseLen = new Float32Array(n);
    this.tileColorMode = new Uint8Array(n);
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
      calpha: 1,
      parx: 0,
      pary: 0,
      pox: 0,
      poy: 0,
      visible: true,
      image: null,
      mask: null,
      depth: -1,
      text: null,
      emitting: false,
      emitSince: 0,
      burst: 0,
      clearSerial: 0,
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
    this.bgFlashAlpha = 0;
    this.bgColor = this.baseBg;
    this.bgImage = null;
    this.bgVideo = null;
    this.bgVideoOffset = 0;
    this.bgVideoLoop = false;
    this.bgFit = 'cover';
    this.bgTint = 0xffffff;
    this.bgOpacity = 0.55;
    this.filters.clear();
    this.bloom = { intensity: 0, threshold: 0.5, color: 0xffffff };
    this.shakes = [];
    this.shakeX = 0;
    this.shakeY = 0;
    this.tileScale.fill(1);
    this.tileStyle.fill(0);
    this.tileColor2.fill(-1);
    this.tileGlowDur.fill(0);
    this.tileLit.fill(1);
    this.tilePulseLen.fill(0);
    this.tileColorMode.fill(0);
    for (const d of this.decos) {
      d.ox = 0;
      d.oy = 0;
      d.rot = 0;
      // 크기는 절대값 (장식 정의의 크기에서 시작)
      d.sx = d.def.scale?.[0] ?? 1;
      d.sy = d.def.scale?.[1] ?? 1;
      d.color = parseColor(d.def.color, 0xffffff);
      d.opacity = d.def.opacity ?? 1;
      d.calpha = d.def.alpha ?? 1;
      d.parx = d.def.parallax?.[0] ?? 0;
      d.pary = d.def.parallax?.[1] ?? 0;
      d.pox = d.def.parallaxOffset?.[0] ?? 0;
      d.poy = d.def.parallaxOffset?.[1] ?? 0;
      d.visible = d.def.visible !== false;
      d.image = d.def.image ?? null;
      d.mask = d.def.mask ?? null;
      d.depth = d.def.depth ?? -1;
      d.text = null;
      d.emitting = !!d.def.particle?.autoPlay;
      d.emitSince = 0;
      d.burst = 0;
      d.clearSerial++;
    }
    this.planetRadius = 1;
    this.planetSize = 1;
    this.screenTile = [1, 1];
    this.screenScroll = [0, 0];
    this.mirrors = false;
    this.fps = 0;
    this.tileColor.fill(this.baseTrack);
    this.tileOffX.fill(0);
    this.tileOffY.fill(0);
    this.tileRot.fill(0);
    this.tileAlpha.fill(1);
    this.tileOpSet.fill(NaN);
    this.claimPos.fill(0);
    this.claimRot.fill(0);
    this.claimAlpha.fill(0);
    this.claimScale.fill(0);
    this.moveSerial = 0;
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
    // 등장 전에 이동 이벤트가 불투명도를 정했으면 그 값이 우선 (등장 애니메이션 없음)
    const opSet = this.tileOpSet[i];
    if (cfg.appear !== 'none' && !(opSet <= tile.time - cfg.ahead * beat)) {
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
      // 흩어지기는 원작처럼 천천히 멀리 떠다니다 사라진다
      const p = (t - t1) / (cfg.disappear === 'scatter' ? 1.8 : len);
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
          case 'scatter': {
            const q = ease('outSine', p);
            out.dx += q * rx * 700;
            out.dy += q * ry * 700;
            out.rot += q * rx * 120;
            out.alpha *= 1 - p * p;
            break;
          }
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
        const setsPos = a.relativeTo !== undefined || a.offset !== undefined;
        const setsZoom = a.zoom !== undefined;
        const setsRot = a.rotation !== undefined;
        // 이 이벤트가 정하는 속성의 이전 이동은 멈춘다 (지금 값에서 이어서 시작)
        this.active = this.active.filter(
          (x) => !((setsPos && x.chan === 'cam.pos') || (setsZoom && x.chan === 'cam.zoom') || (setsRot && x.chan === 'cam.rot')),
        );
        // 새 기준점: 지정이 없으면 그대로
        let anchor = from.anchor;
        let ox0 = from.ox;
        let oy0 = from.oy;
        const rel = a.relativeTo;
        if (rel === 'player') anchor = PLAYER;
        else if (rel === 'global') anchor = { kind: 'fixed', x: 0, y: 0 };
        else if (rel === 'tile') {
          // 그 타일의 지금 위치 (트랙 위치 이동 포함)
          const idx = Math.max(0, Math.min(n - 1, a.tile ?? a.floor));
          const ti = this.chart.tiles[idx];
          anchor = { kind: 'fixed', x: ti.x + this.tileOffX[idx], y: ti.y + this.tileOffY[idx] };
        } else if (rel === 'last' && this.playerPos) {
          // 직전 카메라 위치에 고정: 기준을 그 자리로 옮기고 오프셋은 0에서 시작
          const c = this.currentCenter()!;
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
        // 기준이 바뀌는 도중에 또 바뀌면: 지금 보이는 자리(오프셋 뺀 것)를 이전 기준으로 삼아 끊김 없이
        let prevEff = from.anchor;
        if (from.mix < 1 && this.playerPos) {
          const c = this.currentCenter()!;
          prevEff = { kind: 'fixed', x: c.x - from.ox, y: c.y - from.oy };
        }
        const prev = changed ? prevEff : anchor;
        const mid = rel === 'last' || changed || from.mix >= 1 ? null : { prevAnchor: from.prevAnchor, mix: from.mix };
        const k0 = (p: number) => ease(a.ease as EaseName | undefined, p);
        if (setsPos)
          this.active.push({
            ev,
            chan: 'cam.pos',
            apply: (p) => {
              const k = k0(p);
              const c = this.camera;
              c.ox = lerp(ox0, to.ox, k);
              c.oy = lerp(oy0, to.oy, k);
              c.anchor = anchor;
              if (changed) {
                c.prevAnchor = prev;
                c.mix = k;
              } else if (mid) {
                // 이전 전환이 끝나지 않았으면 그 섞임을 마저 끝낸다
                c.prevAnchor = mid.prevAnchor;
                c.mix = lerp(mid.mix, 1, k);
              } else {
                c.prevAnchor = anchor;
                c.mix = 1;
              }
            },
          });
        if (setsZoom)
          this.active.push({ ev, chan: 'cam.zoom', apply: (p) => (this.camera.zoom = lerp(from.zoom, to.zoom, k0(p))) });
        if (setsRot)
          this.active.push({ ev, chan: 'cam.rot', apply: (p) => (this.camera.rotation = lerp(from.rotation, to.rotation, k0(p))) });
        return null;
      }
      case 'Flash': {
        const c0 = parseColor(a.color, 0xffffff);
        const c1 = parseColor(a.endColor, c0);
        const op0 = a.opacity ?? 0.6;
        const op1 = a.endOpacity ?? 0;
        const bg = a.plane === 'bg';
        // 같은 면의 이전 플래시는 멈춘다
        const chan = bg ? 'flash:bg' : 'flash:fg';
        this.active = this.active.filter((x) => x.chan !== chan);
        return {
          ev: ev.duration > 0 ? ev : { ...ev, duration: 0.25 },
          chan,
          apply: (p) => {
            const col = p >= 1 ? c1 : lerpColor(c0, c1, p);
            const al = lerp(op0, op1, Math.min(1, p));
            if (bg) {
              this.bgFlashColor = col;
              this.bgFlashAlpha = al;
            } else {
              this.flashColor = col;
              this.flashAlpha = al;
            }
          },
        };
      }
      case 'Background': {
        if (a.color) this.bgColor = parseColor(a.color, this.bgColor);
        if (a.image !== undefined) this.bgImage = a.image || null;
        if (a.video !== undefined) this.bgVideo = a.video || null;
        if (a.videoOffset !== undefined) this.bgVideoOffset = a.videoOffset;
        if (a.videoLoop !== undefined) this.bgVideoLoop = a.videoLoop;
        if (a.fit) this.bgFit = a.fit;
        // 이미지를 새로 지정하면 색조도 함께 정해진다 (생략 = 흰색)
        if (a.tint) this.bgTint = parseColor(a.tint, 0xffffff);
        else if (a.image) this.bgTint = 0xffffff;
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
        // 원작 gapLength: 이만큼 건너뛰며 적용
        const step = Math.max(1, Math.round((a.gap ?? 0) + 1));
        const c2 = a.color2 !== undefined ? parseColor(a.color2, target) : -1;
        // 모양·물결은 바로 바뀐다
        for (let i = lo; i <= hi; i += step) {
          if (a.style !== undefined) this.tileStyle[i] = TRACK_STYLES.indexOf(a.style);
          if (a.lit !== undefined) this.tileLit[i] = a.lit;
          if (a.color2 !== undefined || a.style !== undefined) {
            this.tileColor2[i] = c2;
            this.tileGlowDur[i] = a.glowDuration ?? 2;
            this.tilePulseLen[i] = a.pulseLength ?? 0;
            this.tileColorMode[i] = (a.colorMode === 'blink' ? 1 : a.colorMode === 'rainbow' ? 2 : 0) + (a.pulseBack ? 4 : 0);
          }
        }
        return {
          ev,
          apply: (p) => {
            for (let i = lo; i <= hi; i += step) this.tileColor[i] = p >= 1 ? target : lerpColor(from[i - lo], target, p);
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
        // 같은 타일·속성을 움직이던 앞 이벤트는 여기서 끊긴다 (지금 값에서 이어서)
        const id = ++this.moveSerial;
        const step = Math.max(1, Math.round((a.gap ?? 0) + 1));
        for (let i = lo; i <= hi; i += step) {
          if (a.offset) this.claimPos[i] = id;
          if (a.rotation !== undefined) this.claimRot[i] = id;
          if (a.scale !== undefined) this.claimScale[i] = id;
          if (a.opacity !== undefined) {
            this.claimAlpha[i] = id;
            if (Number.isNaN(this.tileOpSet[i])) this.tileOpSet[i] = ev.time;
          }
        }
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            for (let i = lo; i <= hi; i += step) {
              const j = i - lo;
              if (a.offset && this.claimPos[i] === id) {
                // null인 축은 그대로
                if (a.offset[0] !== null) this.tileOffX[i] = lerp(fx[j], a.offset[0], k);
                if (a.offset[1] !== null) this.tileOffY[i] = lerp(fy[j], a.offset[1], k);
              }
              if (a.rotation !== undefined && this.claimRot[i] === id) this.tileRot[i] = lerp(fr[j], a.rotation, k);
              if (a.opacity !== undefined && this.claimAlpha[i] === id) this.tileAlpha[i] = lerp(fa[j], a.opacity, k);
              if (a.scale !== undefined && this.claimScale[i] === id) this.tileScale[i] = lerp(fs[j], a.scale, k);
            }
          },
        };
      }
      case 'Filter': {
        // 배경 층 필터는 'bg:' 이름으로 따로 (화면 전체 필터와 겹치지 않게)
        const key = a.plane === 'back' ? 'bg:' + a.filter : a.filter;
        if (a.exclusive) for (const k of [...this.filters.keys()]) if (k !== key) this.filters.delete(k);
        const chan = 'filter:' + key;
        this.active = this.active.filter((x) => x.chan !== chan);
        // 밝기는 1이 '변화 없음'
        const neutral = FILTER_NEUTRAL_ONE.has(a.filter) ? 1 : 0;
        const cur = this.filters.get(key)?.intensity ?? neutral;
        const target = a.enabled ? (a.intensity ?? 1) : neutral;
        return {
          ev,
          chan,
          apply: (p) => {
            const v = lerp(cur, target, ease(a.ease as EaseName | undefined, p));
            if (p >= 1 && target === neutral) this.filters.delete(key);
            else this.filters.set(key, { intensity: v });
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
        const from = targets.map((d) => ({ ox: d.ox, oy: d.oy, rot: d.rot, sx: d.sx, sy: d.sy, color: d.color, opacity: d.opacity, calpha: d.calpha, parx: d.parx, pary: d.pary, pox: d.pox, poy: d.poy }));
        // null인 축은 지금 값 그대로
        const to = (v: number | null | undefined, cur: number, k: number) => (v === null || v === undefined ? cur : lerp(cur, v, k));
        for (const d of targets) {
          if (a.visible !== undefined) d.visible = a.visible;
          if (a.image !== undefined) d.image = a.image || null;
          if (a.mask !== undefined) d.mask = a.mask === 'none' ? null : a.mask;
          if (a.depth !== undefined) d.depth = a.depth;
          if (a.text !== undefined) d.text = a.text;
          if (a.particle === 'start') {
            d.emitting = true;
            d.emitSince = ev.time;
          } else if (a.particle === 'stop') d.emitting = false;
          else if (a.particle === 'clear') {
            d.emitting = false;
            d.burst = 0;
            d.clearSerial++;
          }
          if (a.emit) d.burst += a.emit;
        }
        return {
          ev,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            targets.forEach((d, j) => {
              const f = from[j];
              if (a.offset) {
                d.ox = to(a.offset[0], f.ox, k);
                d.oy = to(a.offset[1], f.oy, k);
              }
              if (a.rotation !== undefined) d.rot = lerp(f.rot, a.rotation, k);
              if (a.scale) {
                d.sx = to(a.scale[0], f.sx, k);
                d.sy = to(a.scale[1], f.sy, k);
              }
              if (a.parallax) {
                d.parx = to(a.parallax[0], f.parx, k);
                d.pary = to(a.parallax[1], f.pary, k);
              }
              if (a.parallaxOffset) {
                d.pox = to(a.parallaxOffset[0], f.pox, k);
                d.poy = to(a.parallaxOffset[1], f.poy, k);
              }
              if (a.alpha !== undefined) d.calpha = lerp(f.calpha, a.alpha, k);
              if (col !== null) d.color = p >= 1 ? col : lerpColor(f.color, col, p);
              if (a.opacity !== undefined) d.opacity = lerp(f.opacity, a.opacity, k);
            });
          },
        };
      }
      case 'Planets': {
        const r0 = this.planetRadius;
        const s0 = this.planetSize;
        const chan = 'planets';
        this.active = this.active.filter((x) => x.chan !== chan);
        return {
          ev,
          chan,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            if (a.radius !== undefined) this.planetRadius = lerp(r0, a.radius, k);
            if (a.size !== undefined) this.planetSize = lerp(s0, a.size, k);
          },
        };
      }
      case 'Screen': {
        if (a.scroll) this.screenScroll = [a.scroll[0], a.scroll[1]];
        if (a.mirrors !== undefined) this.mirrors = a.mirrors;
        if (a.fps !== undefined) this.fps = a.fps;
        if (!a.tile) return null;
        const t0: [number, number] = [this.screenTile[0], this.screenTile[1]];
        const t1 = a.tile;
        const chan = 'screen.tile';
        this.active = this.active.filter((x) => x.chan !== chan);
        return {
          ev,
          chan,
          apply: (p) => {
            const k = ease(a.ease as EaseName | undefined, p);
            this.screenTile = [lerp(t0[0], t1[0], k), lerp(t0[1], t1[1], k)];
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

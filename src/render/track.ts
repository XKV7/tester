import { BitmapText, Container, Graphics, Text } from 'pixi.js';
import { VISUAL_TYPES, type Chart } from '../core/chart';
import { hueColor, lerpColor, scaleColor } from '../core/color';
import { degToRad, TILE_LEN } from '../core/math';
import type { VisualTimeline } from '../core/timeline';
import { BAND_W, bandContext, blockContexts, iconContext, sv, type IconKind } from './shapes';

interface TileObj {
  root: Container;
  band: Graphics;
  /** 블록 모양의 안쪽 (orbit 모양이면 없음). */
  inner?: Graphics;
  style: number;
  hold?: Graphics;
  label?: BitmapText;
  icons: { kind: IconKind; g: Graphics; dx: number; dy: number }[];
  text?: Text;
}

export interface ViewRect {
  cx: number;
  cy: number;
  radius: number;
}

export interface TrackUpdate {
  /** 이 번호 미만 타일은 통과(어둡게). */
  passed: number;
  /** 비트 펄스 0~1. */
  pulse: number;
  /** 현재 실제 시각 (ms, 펄스 애니메이션). */
  now: number;
  view: ViewRect;
  /** 에디터 선택 타일. */
  selected?: number;
  /** 에디터: 박 수 표시. */
  showBeats?: boolean;
  /** 곡 시각 (초) — 타일 등장·퇴장 애니메이션용. 없으면 애니메이션 없이 모두 보임. */
  time?: number;
}

/**
 * 트랙 렌더링. 타일 객체는 화면에 들어올 때 지연 생성하고 화면 밖은 숨긴다(컬링).
 */
export class TrackView {
  readonly container = new Container();
  private readonly tileLayer = new Container();
  private readonly iconLayer = new Container();
  private readonly textLayer = new Container();
  private readonly selGfx = new Graphics();
  private objs: (TileObj | undefined)[];
  private visible = new Set<number>();
  private pulses = new Map<number, number>();
  private readonly editorMode: boolean;
  /** floor → 아이콘 종류 (객체는 화면에 들어올 때 생성). */
  private readonly iconKinds: IconKind[][];
  private readonly editorFloors: Set<number>;
  private uprightRot = 0;

  constructor(
    readonly chart: Chart,
    private readonly timeline: VisualTimeline | null,
    opts: { editor?: boolean; outline?: boolean } = {},
  ) {
    this.editorMode = !!opts.editor;
    this.outline = !!opts.outline;
    this.objs = new Array(chart.tiles.length);
    this.tileLayer.sortableChildren = true;
    this.container.addChild(this.tileLayer, this.selGfx, this.iconLayer, this.textLayer);
    this.iconKinds = Array.from({ length: chart.tiles.length }, () => []);
    this.editorFloors = new Set(
      chart.level.actions
        .filter((a) => VISUAL_TYPES.has(a.type))
        .map((a) => a.floor),
    );
    this.buildIcons();
  }

  private buildIcons(): void {
    let twirled = false;
    for (const t of this.chart.tiles) {
      const kinds = this.iconKinds[t.floor];
      if (t.twirl) twirled = true;
      if (t.twirl) kinds.push('twirl');
      // 원작처럼: 빨라지면 토끼, 느려지면 달팽이 (2배 이상 바뀌면 두 마리)
      if (t.speed) {
        const prev = this.chart.tiles[Math.max(0, t.floor - 1)].bpm;
        const ratio = t.bpm / prev;
        if (t.speed === 'up') kinds.push(ratio >= 2 - 1e-9 ? 'speedUp2' : 'speedUp');
        else kinds.push(ratio <= 0.5 + 1e-9 ? 'speedDown2' : 'speedDown');
      }
      if (t.checkpoint) kinds.push('checkpoint');
      if (t.midspin) kinds.push('midspin');
      if (t.pauseBeats > 0) kinds.push('pause');
      if (t.floor === this.chart.finish) kinds.push('finish');
      if (this.editorMode && this.editorFloors.has(t.floor)) kinds.push('editorEvent');
      // Twirl 이후 구간: 회전 방향 화살표를 옅게
      if (kinds.length === 0 && twirled) kinds.push(t.dir === 'CW' ? 'dirCW' : 'dirCCW');
    }
  }

  /** 타일의 화면(월드) 좌표 — MoveTrack 오프셋 포함, y 반전. */
  pos(i: number): { x: number; y: number } {
    const k = Math.max(0, Math.min(i, this.chart.tiles.length - 1));
    return { x: this.px(k), y: this.py(k) };
  }
  private px(i: number): number {
    return this.chart.tiles[i].x + (this.timeline ? this.timeline.tileOffX[i] : 0);
  }
  private py(i: number): number {
    return -(this.chart.tiles[i].y + (this.timeline ? this.timeline.tileOffY[i] : 0));
  }

  pulseTile(i: number, now: number): void {
    this.pulses.set(i, now);
  }

  /** 트랙 강조: 타일 밑에 어두운 그림자 테두리를 깔아 복잡한 배경 위에서도 또렷하게 */
  private readonly outline: boolean;

  private make(i: number): TileObj {
    const t = this.chart.tiles[i];
    const root = new Container();
    const style = this.timeline ? this.timeline.tileStyle[i] : 0;
    let band: Graphics;
    let inner: Graphics | undefined;
    if (this.outline) {
      const sh = new Graphics(style === 0 ? bandContext(t.angleIn, t.angleOut, t.midspin) : blockContexts(t.angleIn, t.angleOut, t.midspin).outer);
      sh.tint = 0x000000;
      sh.alpha = 0.55;
      sh.scale.set(1.16);
      root.addChild(sh);
    }
    if (style === 0) {
      band = new Graphics(bandContext(t.angleIn, t.angleOut, t.midspin));
      root.addChild(band);
    } else {
      const bc = blockContexts(t.angleIn, t.angleOut, t.midspin);
      band = new Graphics(bc.outer);
      inner = new Graphics(bc.inner);
      root.addChild(band, inner);
    }
    const o: TileObj = { root, band, inner, style, icons: [] };
    const kinds = this.iconKinds[i];
    kinds.forEach((k, j) => {
      const g = new Graphics(iconContext(k));
      g.scale.set(1.25);
      const spread = (j - (kinds.length - 1) / 2) * 20;
      o.icons.push({ kind: k, g, dx: spread, dy: k === 'editorEvent' ? -26 : 0 });
      this.iconLayer.addChild(g);
    });
    if (t.text) {
      const txt = new Text({
        text: t.text,
        style: { fontFamily: 'system-ui, sans-serif', fontSize: 20, fill: 0xe8ecff, fontWeight: '600', align: 'center' },
      });
      txt.anchor.set(0.5, 1);
      txt.alpha = 0.85;
      o.text = txt;
      this.textLayer.addChild(txt);
    }
    if (t.holdBeats > 0 && t.angleOut !== null) {
      // 긴 캡슐형 홀드 타일
      const h = new Graphics();
      const f = sv(t.angleOut, TILE_LEN * 0.5);
      h.moveTo(0, 0).lineTo(f.x, f.y).stroke({ width: BAND_W + 10, color: 0xffd36b, alpha: 0.35, cap: 'round' });
      h.moveTo(0, 0).lineTo(f.x, f.y).stroke({ width: BAND_W - 14, color: 0xffd36b, alpha: 0.8, cap: 'round' });
      root.addChildAt(h, 0);
      o.hold = h;
    }
    if (this.editorMode) {
      const label = new BitmapText({
        text: fmtBeats(t.beats),
        style: { fontFamily: 'Arial', fontSize: 13, fill: 0xa8b0d8 },
      });
      label.anchor.set(0.5);
      o.label = label;
      this.textLayer.addChild(label);
    }
    // 원작처럼 앞 타일이 위에 그려진다 (겹친 뒤쪽 타일은 가려짐)
    root.zIndex = -i;
    this.tileLayer.addChild(root);
    this.objs[i] = o;
    return o;
  }

  update(u: TrackUpdate): void {
    const tiles = this.chart.tiles;
    const tl = this.timeline;
    const r2 = (u.view.radius + TILE_LEN) ** 2;
    const nowVisible = new Set<number>();
    const bright = 1 + 0.18 * u.pulse;
    for (let i = 0; i < tiles.length; i++) {
      const x = this.px(i);
      const y = this.py(i);
      const dx = x - u.view.cx;
      const dy = y - u.view.cy;
      if (dx * dx + dy * dy > r2) continue;
      const anim = tl && u.time !== undefined ? tl.tileAnimAt(i, u.time) : null;
      const alpha = (tl ? tl.tileAlpha[i] : 1) * (anim ? anim.alpha : 1);
      if (alpha <= 0.001) continue;
      nowVisible.add(i);
      let o = this.objs[i] ?? this.make(i);
      // 모양이 바뀌었으면 다시 만든다 (RecolorTrack style)
      if (tl && o.style !== tl.tileStyle[i]) {
        this.dispose(o);
        o = this.make(i);
      }
      this.setVisible(o, true, !!u.showBeats);
      o.root.position.set(x + (anim ? anim.dx : 0), y - (anim ? anim.dy : 0));
      o.root.rotation = (tl ? -degToRad(tl.tileRot[i]) : 0) - (anim ? degToRad(anim.rot) : 0);
      o.root.alpha = alpha;
      let base = tl ? tl.tileColor[i] : 0x3a3f55;
      // 물결 (원작 Glow): 두 색 사이를 오간다, 트랙을 따라 퍼지는 모양
      if (tl && tl.tileColor2[i] >= 0) {
        const tt = u.time ?? u.now / 1000;
        const len = tl.tilePulseLen[i];
        const mode = tl.tileColorMode[i];
        const ph = tt / Math.max(0.05, tl.tileGlowDur[i]) - (len > 0 ? ((mode & 4 ? -1 : 1) * i) / len : 0);
        const m = mode & 3;
        if (m === 2) base = hueColor(ph - Math.floor(ph));
        else if (m === 1) base = ph - Math.floor(ph) < 0.5 ? base : tl.tileColor2[i];
        else base = lerpColor(base, tl.tileColor2[i], 0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
      }
      const passed = i < u.passed;
      const ps = this.pulses.get(i);
      let s = 1;
      let flash = 0; // 막 친 타일은 잠깐 하얗게
      if (ps !== undefined) {
        const k = (u.now - ps) / 250;
        if (k >= 1) this.pulses.delete(i);
        else {
          s = 1 + 0.12 * Math.sin(Math.PI * k);
          flash = Math.max(0, Math.min(1, 1 - k));
        }
      }
      const W = 0xffffff;
      switch (o.style) {
        case 1: {
          // standard: 채움 + 어두운 테두리, 지나간 타일은 하얗게 빛난다 (원작 트랙 글로우)
          const lit = passed ? (tl ? tl.tileLit[i] : 1) : 0;
          const wOuter = Math.max(flash * 0.8, lit * 0.6);
          const wInner = Math.max(flash * 0.85, lit * 0.85);
          o.band.tint = lerpColor(scaleColor(base, 0.55), W, wOuter);
          o.inner!.tint = lerpColor(scaleColor(base, bright), W, wInner);
          break;
        }
        case 2: {
          // neon: 어두운 속 + 색 테두리, 지나간 타일은 테두리가 하얗게 빛난다 (막 친 순간은 속도 잠깐 밝게)
          const lit = passed ? (tl ? tl.tileLit[i] : 1) : 0;
          o.band.tint = lerpColor(scaleColor(base, bright), W, Math.max(lit, flash));
          o.inner!.tint = lerpColor(scaleColor(base, 0.12), W, Math.max(flash * 0.7, lit * 0.3));
          break;
        }
        case 4: {
          // neonlight: 밝은 속 + 흰 빛 테두리 (원작 NeonLight)
          const lit = passed ? (tl ? tl.tileLit[i] : 1) : 0;
          o.band.tint = lerpColor(base, W, 0.7 + 0.3 * Math.max(lit, flash));
          o.inner!.tint = lerpColor(scaleColor(base, bright), W, Math.max(flash * 0.7, lit * 0.5));
          break;
        }
        case 3: {
          // basic: 단색, 지나간 타일은 하얗게
          const lit = passed ? (tl ? tl.tileLit[i] : 1) : 0;
          const w = Math.max(flash * 0.8, lit * 0.8);
          o.band.tint = lerpColor(base, W, w);
          o.inner!.tint = lerpColor(base, W, w);
          break;
        }
        default: // orbit: 지나간 타일은 어둡게, 막 친 타일은 하얗게 번쩍
          o.band.tint = lerpColor(scaleColor(base, passed ? 0.55 : 1.25 * bright), W, flash * 0.75);
      }
      o.root.scale.set(s * (tl ? tl.tileScale[i] : 1) * (anim ? anim.scale : 1));
      if (o.label) o.label.position.set(x + 22, y + 22);
      for (const ic of o.icons) {
        ic.g.position.set(x + ic.dx, y + ic.dy);
        ic.g.rotation = -this.uprightRot;
        ic.g.alpha = alpha * (passed && ic.kind !== 'finish' ? 0.4 : 1);
      }
      if (o.text) {
        o.text.visible = i >= u.passed - 3;
        o.text.position.set(x, y - 44);
        o.text.rotation = -this.uprightRot;
      }
    }
    for (const i of this.visible) {
      if (!nowVisible.has(i)) {
        const o = this.objs[i];
        if (o) this.setVisible(o, false, false);
      }
    }
    this.visible = nowVisible;

    this.selGfx.clear();
    if (u.selected !== undefined && u.selected >= 0 && u.selected < tiles.length) {
      const p = this.pos(u.selected);
      this.selGfx.circle(p.x, p.y, BAND_W * 0.9).stroke({ width: 3, color: 0x7ad1ff, alpha: 0.95 });
    }
  }

  private dispose(o: TileObj): void {
    o.root.destroy({ children: true });
    for (const ic of o.icons) ic.g.destroy();
    o.label?.destroy();
    o.text?.destroy();
  }

  private setVisible(o: TileObj, v: boolean, label: boolean): void {
    o.root.visible = v;
    if (o.label) o.label.visible = v && label;
    for (const ic of o.icons) ic.g.visible = v;
    if (o.text) o.text.visible = v;
  }

  /** 아이콘·문구를 카메라 회전과 반대로 돌려 똑바로 보이게 (다음 update에 적용). */
  uprightTexts(rotation: number): void {
    this.uprightRot = rotation;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

export function fmtBeats(b: number): string {
  if (Math.abs(b - Math.round(b)) < 1e-6) return String(Math.round(b));
  return (Math.round(b * 100) / 100).toString();
}

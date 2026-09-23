import { BitmapText, Container, Graphics, Text } from 'pixi.js';
import type { Chart } from '../core/chart';
import { scaleColor } from '../core/color';
import { degToRad, TILE_LEN } from '../core/math';
import type { VisualTimeline } from '../core/timeline';
import { BAND_W, bandContext, iconContext, sv, type IconKind } from './shapes';

interface TileObj {
  root: Container;
  band: Graphics;
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
    opts: { editor?: boolean } = {},
  ) {
    this.editorMode = !!opts.editor;
    this.objs = new Array(chart.tiles.length);
    this.container.addChild(this.tileLayer, this.selGfx, this.iconLayer, this.textLayer);
    this.iconKinds = Array.from({ length: chart.tiles.length }, () => []);
    this.editorFloors = new Set(
      chart.level.actions
        .filter((a) => ['Camera', 'Flash', 'RecolorTrack', 'MoveTrack', 'Background'].includes(a.type))
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
      if (t.speed === 'up') kinds.push('speedUp');
      if (t.speed === 'down') kinds.push('speedDown');
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

  private make(i: number): TileObj {
    const t = this.chart.tiles[i];
    const root = new Container();
    const band = new Graphics(bandContext(t.angleIn, t.angleOut, t.midspin));
    root.addChild(band);
    const o: TileObj = { root, band, icons: [] };
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
      const alpha = tl ? tl.tileAlpha[i] : 1;
      if (dx * dx + dy * dy > r2 || alpha <= 0.001) continue;
      nowVisible.add(i);
      const o = this.objs[i] ?? this.make(i);
      this.setVisible(o, true, !!u.showBeats);
      o.root.position.set(x, y);
      o.root.rotation = tl ? -degToRad(tl.tileRot[i]) : 0;
      o.root.alpha = alpha;
      const base = tl ? tl.tileColor[i] : 0x3a3f55;
      const passed = i < u.passed;
      o.band.tint = scaleColor(base, passed ? 0.55 : 1.25 * bright);
      const ps = this.pulses.get(i);
      let s = 1;
      if (ps !== undefined) {
        const k = (u.now - ps) / 200;
        if (k >= 1) this.pulses.delete(i);
        else s = 1 + 0.15 * Math.sin(Math.PI * k);
      }
      o.root.scale.set(s);
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

import { Container, Sprite, Text, Texture } from 'pixi.js';
import type { Chart } from '../core/chart';
import { degToRad, TILE_LEN } from '../core/math';
import type { DecoState, VisualTimeline } from '../core/timeline';

/** 원작 장식 이미지 1px의 월드 크기 (원작: 100px = 1 유닛, 타일 간격 = 1.5 유닛). */
export const DECO_PX = TILE_LEN / 150;

interface Obj {
  node: Sprite | Text;
  image: string | null;
}

/**
 * 장식(이미지·글자) 렌더링. depth 0 이상은 트랙 뒤(behind), 음수는 앞(front).
 * 좌표는 월드(y 위쪽)를 화면용(y 아래쪽)으로 뒤집어 그린다.
 */
export class DecorationView {
  readonly behind = new Container();
  readonly front = new Container();
  private readonly objs: Obj[] = [];
  private readonly tex = new Map<string, Texture | 'loading' | null>();

  constructor(
    private readonly chart: Chart,
    private readonly tl: VisualTimeline,
    private readonly urlOf: (name: string) => string | null,
  ) {
    this.behind.sortableChildren = true;
    this.front.sortableChildren = true;
    for (const d of tl.decos) {
      const node = d.def.text !== undefined ? this.makeText(d) : new Sprite(Texture.EMPTY);
      if (node instanceof Sprite) node.anchor.set(0.5);
      const depth = d.def.depth ?? -1;
      node.zIndex = -depth;
      (depth >= 0 ? this.behind : this.front).addChild(node);
      this.objs.push({ node, image: null });
    }
  }

  get count(): number {
    return this.objs.length;
  }

  private makeText(d: DecoState): Text {
    const t = new Text({
      text: d.def.text ?? '',
      style: { fontFamily: 'system-ui, sans-serif', fontSize: d.def.fontSize ?? 40, fill: 0xffffff, align: 'center' },
    });
    t.anchor.set(0.5);
    return t;
  }

  private texture(name: string): Texture | null {
    const c = this.tex.get(name);
    if (c === 'loading') return null;
    if (c !== undefined) return c;
    const url = this.urlOf(name);
    if (!url) {
      this.tex.set(name, null);
      return null;
    }
    this.tex.set(name, 'loading');
    const img = new Image();
    img.onload = () => this.tex.set(name, Texture.from(img));
    img.onerror = () => this.tex.set(name, null);
    img.src = url;
    return null;
  }

  /**
   * camX, camY: 카메라 중심 (화면 좌표, y 아래쪽). camRot: 카메라 회전 (도).
   */
  update(camX: number, camY: number, camRot: number): void {
    const decos = this.tl.decos;
    const rc = degToRad(camRot);
    const cos = Math.cos(-rc);
    const sin = Math.sin(-rc);
    for (let i = 0; i < decos.length; i++) {
      const d = decos[i];
      const o = this.objs[i];
      const node = o.node;
      node.visible = d.visible && d.opacity > 0.001;
      if (!node.visible) continue;
      const def = d.def;
      // 이미지 교체·지연 로드
      if (node instanceof Sprite && d.image !== o.image) {
        const t = d.image ? this.texture(d.image) : null;
        if (t || !d.image) {
          node.texture = t ?? Texture.EMPTY;
          o.image = d.image;
        }
      }
      const px = (def.position?.[0] ?? 0) + d.ox;
      const py = (def.position?.[1] ?? 0) + d.oy;
      const sx = (def.scale?.[0] ?? 1) * d.sx;
      const sy = (def.scale?.[1] ?? 1) * d.sy;
      const rot = (def.rotation ?? 0) + d.rot;
      const rel = def.relativeTo ?? 'tile';
      let x: number;
      let y: number;
      let r = -degToRad(rot);
      if (rel === 'camera') {
        // 화면에 붙음: 카메라 회전만큼 되돌려 월드에 놓는다
        const vx = px;
        const vy = -py;
        x = camX + vx * cos - vy * sin;
        y = camY + vx * sin + vy * cos;
        r -= rc;
      } else {
        const tile = rel === 'tile' ? this.chart.tiles[Math.min(this.chart.tiles.length - 1, def.floor ?? 0)] : null;
        const bx = tile ? tile.x : 0;
        const by = tile ? -tile.y : 0;
        const par = def.parallax ?? [0, 0];
        x = bx + px + camX * par[0];
        y = by - py + camY * par[1];
      }
      node.position.set(x, y);
      node.rotation = r;
      node.alpha = d.opacity;
      node.tint = d.color;
      if (node instanceof Sprite) {
        const tw = node.texture.width || 1;
        const th = node.texture.height || 1;
        node.scale.set(DECO_PX * sx, DECO_PX * sy);
        if (def.pivot) node.anchor.set(0.5 - def.pivot[0] / (tw * DECO_PX), 0.5 + def.pivot[1] / (th * DECO_PX));
      } else {
        node.scale.set(sx, sy);
      }
    }
  }

  destroy(): void {
    this.behind.destroy({ children: true });
    this.front.destroy({ children: true });
    for (const t of this.tex.values()) if (t && t !== 'loading') t.destroy(true);
  }
}

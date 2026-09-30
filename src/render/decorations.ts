import { Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import type { Chart } from '../core/chart';
import { lerpColor, parseColor } from '../core/color';
import { degToRad, TILE_LEN } from '../core/math';
import type { DecoState, VisualTimeline } from '../core/timeline';
import type { ParticleDef } from '../core/types';
import { BLOCK_W, PLANET_R } from './shapes';

/** 원작 장식 이미지 1px의 월드 크기 (원작: 100px = 1 유닛, 타일 간격 = 1.5 유닛). */
export const DECO_PX = TILE_LEN / 150;

/** 한 장식의 입자들 (방출 장소 기준 좌표). */
interface Particle {
  s: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  size: number;
  age: number;
  life: number;
}

interface PSys {
  def: ParticleDef;
  layer: Container;
  live: Particle[];
  pool: Sprite[];
  /** 아직 내보내지 못한 방출량 (소수 누적) */
  debt: number;
  rate: number;
  clearSerial: number;
  c0: number;
  c1: number;
}

interface Obj {
  node: Sprite | TilingSprite | Text | Graphics | Container;
  image: string | null;
  ps?: PSys;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** GPU에 올릴 그림 최대 크기 (넘으면 줄여서 올린다). 휴대폰은 그림이 수백 장이면 메모리가 모자라 더 작게 */
const MAX_TEX = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 2048 : 4096;

/** 불투명도 키 사이를 선형으로 (키가 없으면 1). */
function alphaAt(keys: [number, number][] | undefined, t: number): number {
  if (!keys || keys.length === 0) return 1;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, a0] = keys[i - 1];
      const [t1, a1] = keys[i];
      return t1 > t0 ? a0 + ((a1 - a0) * (t - t0)) / (t1 - t0) : a1;
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * 장식(이미지·글자·도형·입자) 렌더링. depth 0 이상은 트랙 뒤(behind), 음수는 앞(front).
 * 좌표는 월드(y 위쪽)를 화면용(y 아래쪽)으로 뒤집어 그린다.
 */
export class DecorationView {
  readonly behind = new Container();
  readonly front = new Container();
  private readonly objs: Obj[] = [];
  private readonly tex = new Map<string, Texture | 'loading' | null>();
  /** 줄여서 올린 그림: 원래 크기 / 줄인 크기 */
  private readonly texFactor = new Map<Texture, number>();
  /** 그림 불러오기 현황 (진단용) */
  readonly stats = { loaded: 0, failed: 0, missing: 0, shrunk: 0, failedNames: [] as string[], missingNames: [] as string[] };
  private lastTime: number | null = null;

  constructor(
    private readonly chart: Chart,
    private readonly tl: VisualTimeline,
    private readonly urlOf: (name: string) => string | null,
  ) {
    this.behind.sortableChildren = true;
    this.front.sortableChildren = true;
    for (const d of tl.decos) {
      const o = this.makeObj(d);
      const depth = d.def.depth ?? -1;
      o.node.zIndex = -depth;
      (depth >= 0 ? this.behind : this.front).addChild(o.node);
      this.objs.push(o);
    }
  }

  get count(): number {
    return this.objs.length;
  }

  private makeObj(d: DecoState): Obj {
    const def = d.def;
    if (def.particle) {
      const layer = new Container();
      const p = def.particle;
      const c0 = parseColor(p.colors?.[0], 0xffffff);
      const c1 = parseColor(p.colors?.[1], c0);
      return { node: layer, image: null, ps: { def: p, layer, live: [], pool: [], debt: 0, rate: rand(p.rate[0], p.rate[1]), clearSerial: d.clearSerial, c0, c1 } };
    }
    if (def.shape === 'planet') {
      // 흰색으로 그려 두고 색은 tint로 (색 바꾸기 이벤트가 그대로 먹게)
      const g = new Graphics().circle(0, 0, PLANET_R).fill({ color: 0xffffff });
      return { node: g, image: null };
    }
    if (def.shape === 'tile') {
      const w = TILE_LEN;
      const g = new Graphics()
        .rect(-w / 2, -BLOCK_W / 2, w, BLOCK_W)
        .fill({ color: 0xffffff })
        .rect(-w / 2 + 5, -BLOCK_W / 2 + 5, w - 10, BLOCK_W - 10)
        .fill({ color: 0xffffff, alpha: 0.35 });
      return { node: g, image: null };
    }
    if (def.text !== undefined) return { node: this.makeText(d), image: null };
    // 이어 붙인 그림 (원작 tile)
    const s = def.tile ? new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 }) : new Sprite(Texture.EMPTY);
    s.anchor.set(0.5);
    if (def.blend) s.blendMode = def.blend;
    return { node: s, image: null };
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
      this.stats.missing++;
      if (this.stats.missingNames.length < 20) this.stats.missingNames.push(name);
      return null;
    }
    this.tex.set(name, 'loading');
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const k = Math.min(1, MAX_TEX / Math.max(w, h, 1));
      let t: Texture;
      if (k < 1) {
        // 너무 큰 그림은 휴대폰에서 안 보이므로 줄여서 올리고, 그리는 크기는 원래대로
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * k));
        cv.height = Math.max(1, Math.round(h * k));
        cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
        t = Texture.from(cv);
        this.texFactor.set(t, w / cv.width);
        this.stats.shrunk++;
      } else t = Texture.from(img);
      this.tex.set(name, t);
      this.stats.loaded++;
    };
    img.onerror = () => {
      this.tex.set(name, null);
      this.stats.failed++;
      if (this.stats.failedNames.length < 20) this.stats.failedNames.push(name);
    };
    img.src = url;
    return null;
  }

  /**
   * camX, camY: 카메라 중심 (화면 좌표, y 아래쪽). camRot: 카메라 회전 (도). time: 곡 시각 (초, 입자 시뮬레이션용).
   */
  update(camX: number, camY: number, camRot: number, time?: number, camZoom = 1): void {
    const decos = this.tl.decos;
    const rc = degToRad(camRot);
    const cos = Math.cos(-rc);
    const sin = Math.sin(-rc);
    // 입자는 곡 시각 차이로 움직인다 (뒤로 가면 = 재시작, 모두 지움)
    let dt = 0;
    let rewound = false;
    if (time !== undefined) {
      if (this.lastTime !== null) {
        dt = time - this.lastTime;
        if (dt < 0) rewound = true;
        dt = Math.max(0, Math.min(0.1, dt));
      }
      this.lastTime = time;
    }
    for (let i = 0; i < decos.length; i++) {
      const d = decos[i];
      const o = this.objs[i];
      const node = o.node;
      const def = d.def;
      if (o.ps) this.stepParticles(o.ps, d, dt, rewound, time ?? 0);
      node.visible = d.visible && d.opacity * d.calpha > 0.001 && (!o.ps || o.ps.live.length > 0);
      if (!node.visible) continue;
      // 이미지 교체·지연 로드
      if ((node instanceof Sprite || node instanceof TilingSprite) && d.image !== o.image) {
        const t = d.image ? this.texture(d.image) : null;
        if (t || !d.image) {
          node.texture = t ?? Texture.EMPTY;
          o.image = d.image;
          if (node instanceof TilingSprite && t) {
            node.width = t.width * (def.tile?.[0] ?? 1);
            node.height = t.height * (def.tile?.[1] ?? 1);
          }
        }
      }
      // 글자 바꾸기 (원작 SetText)
      if (node instanceof Text) {
        const want = d.text ?? def.text ?? '';
        if (node.text !== want) node.text = want;
      }
      const px = (def.position?.[0] ?? 0) + d.ox;
      const py = (def.position?.[1] ?? 0) + d.oy;
      // 크기는 절대값 (타임라인이 장식 정의 크기에서 시작)
      let sx = d.sx;
      let sy = d.sy;
      if (def.lockScale && camZoom > 0) {
        sx /= camZoom;
        sy /= camZoom;
      }
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
        // 카메라 따라가기 (원작 parallax): 기준 타일(+기준점 이동)과 카메라 사이를 비율만큼
        // 100%면 카메라와 함께 움직여 화면에 고정된다
        x = bx + px + (camX - (bx + d.pox)) * d.parx;
        y = by - py + (camY - (by - d.poy)) * d.pary;
        if (def.lockRotation) r -= rc;
      }
      node.position.set(x, y);
      node.rotation = r;
      node.alpha = d.opacity * d.calpha;
      if (o.ps) {
        // 입자 묶음: 색은 입자마다, 크기 배율은 장식 크기
        node.scale.set(d.sx, d.sy);
        continue;
      }
      if (node instanceof Sprite || node instanceof TilingSprite || node instanceof Text || node instanceof Graphics) node.tint = d.color;
      if (node instanceof Sprite || node instanceof TilingSprite) {
        const f = this.texFactor.get(node.texture) ?? 1;
        const tw = (node.texture.width || 1) * f;
        const th = (node.texture.height || 1) * f;
        node.scale.set(DECO_PX * sx * f, DECO_PX * sy * f);
        if (def.pivot) node.anchor.set(0.5 - def.pivot[0] / (tw * DECO_PX), 0.5 + def.pivot[1] / (th * DECO_PX));
      } else {
        node.scale.set(sx, sy);
      }
    }
  }

  /** 입자 한 묶음 진행: 방출·이동·수명. */
  private stepParticles(ps: PSys, d: DecoState, dt: number, rewound: boolean, time: number): void {
    const p = ps.def;
    if (rewound || ps.clearSerial !== d.clearSerial) {
      for (const q of ps.live) this.release(ps, q);
      ps.live = [];
      ps.debt = 0;
      ps.clearSerial = d.clearSerial;
    }
    const k = p.speed ?? 1;
    const sdt = dt * k;
    const max = p.max ?? 1000;
    // 방출: 켜져 있고 (반복이 아니면) 방출 시간 안
    let emitting = d.emitting && d.visible;
    if (emitting && !p.loop && p.duration && time - d.emitSince > p.duration) emitting = false;
    let n = 0;
    if (emitting && sdt > 0) {
      ps.debt += ps.rate * sdt;
      n = Math.floor(ps.debt);
      ps.debt -= n;
    }
    if (d.burst > 0) {
      n += d.burst;
      d.burst = 0;
    }
    n = Math.min(n, max - ps.live.length);
    if (n > 0) {
      const tex = d.image ? this.texture(d.image) : null;
      for (let j = 0; j < n; j++) this.spawn(ps, tex);
    }
    // 이동·수명
    const keep: Particle[] = [];
    for (const q of ps.live) {
      q.age += sdt;
      if (q.age >= q.life) {
        this.release(ps, q);
        continue;
      }
      q.x += q.vx * sdt;
      q.y += q.vy * sdt;
      q.rot += q.spin * sdt;
      const f = q.age / q.life;
      q.s.position.set(q.x, -q.y);
      q.s.rotation = -degToRad(q.rot);
      q.s.alpha = alphaAt(p.alphaKeys, f);
      q.s.tint = ps.c0 === ps.c1 ? ps.c0 : lerpColor(ps.c0, ps.c1, f);
      keep.push(q);
    }
    ps.live = keep;
  }

  private spawn(ps: PSys, tex: Texture | null): void {
    const p = ps.def;
    const s = ps.pool.pop() ?? new Sprite(Texture.EMPTY);
    s.anchor.set(0.5);
    s.texture = tex ?? Texture.WHITE;
    const size = rand(p.size[0], p.size[1]);
    // 그림이 없으면 작은 흰 사각형
    const base = tex ? DECO_PX : TILE_LEN * 0.08;
    s.scale.set(base * size * (tex ? (this.texFactor.get(tex) ?? 1) : 1 / Math.max(1, s.texture.width)));
    const area = p.area ?? [0, 0];
    const q: Particle = {
      s,
      x: (Math.random() - 0.5) * area[0],
      y: (Math.random() - 0.5) * area[1],
      vx: rand(p.velocity[0][0], p.velocity[1][0]),
      vy: rand(p.velocity[0][1], p.velocity[1][1]),
      rot: 0,
      spin: p.spin ? rand(p.spin[0], p.spin[1]) : 0,
      size,
      age: 0,
      life: Math.max(0.05, rand(p.lifetime[0], p.lifetime[1])),
    };
    s.visible = true;
    ps.layer.addChild(s);
    ps.live.push(q);
  }

  private release(ps: PSys, q: Particle): void {
    q.s.visible = false;
    ps.layer.removeChild(q.s);
    if (ps.pool.length < 500) ps.pool.push(q.s);
    else q.s.destroy();
  }

  destroy(): void {
    this.behind.destroy({ children: true });
    this.front.destroy({ children: true });
    for (const t of this.tex.values()) if (t && t !== 'loading') t.destroy(true);
  }
}

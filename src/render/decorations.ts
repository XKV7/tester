import { Container, Graphics, Rectangle, RenderTexture, Sprite, Text, Texture, TilingSprite, type Matrix, type Renderer } from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
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
  /** 처음 크기 (수명 동안 크기 배율을 곱한다) */
  bx: number;
  by: number;
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
  /** 지난 프레임 방출 장소 위치 (world 모드에서 입자를 제자리에 두려고) */
  lx: number | null;
  ly: number | null;
}

interface Obj {
  node: Sprite | TilingSprite | Text | Graphics | Container;
  image: string | null;
  ps?: PSys;
  /** 지금 걸린 가리기 (inside/outside) */
  masked: 'inside' | 'outside' | null;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

const MOBILE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/**
 * GPU에 올릴 그림 최대 크기 (넘으면 줄여서 올린다). 휴대폰은 큰 그림 수십 장이 한꺼번에 보이면
 * GPU 메모리가 모자라 그림이 통째로 안 그려지거나 화면이 꺼지므로 작게.
 */
const MAX_TEX = MOBILE ? (lowGpu() ? 512 : 1024) : 4096;
/** 화면을 크게 덮는 배경 그림은 휴대폰에서도 조금 크게 (흐릿하지 않게) — 동시에 이만큼까지만 */
const MAX_TEX_BIG = MOBILE ? (lowGpu() ? 1024 : 2048) : 4096;
const MAX_BIG = 6;

/** 한 번 그래픽 메모리가 바닥나 화면이 꺼졌던 기기면 그림을 더 작게 */
function lowGpu(): boolean {
  try {
    return localStorage.getItem('orbit.lowgpu') === '1';
  } catch {
    return false;
  }
}
/** 한꺼번에 해독하는 그림 수 (휴대폰에서 수십 장을 동시에 풀면 메모리가 튄다) */
const MAX_LOADING = MOBILE ? 3 : 8;
/** 이만큼(ms) 안 보인 그림은 GPU에서 내린다 (다시 보이면 새로 불러온다) */
const UNLOAD_AFTER_MS = MOBILE ? 4000 : 20000;

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
  /** 그림 이름 → 마지막으로 화면에 쓴 시각 (performance.now) */
  private readonly lastUsed = new Map<string, number>();
  private readonly queue: string[] = [];
  private loading = 0;
  private lastSweep = 0;
  /** 그림 불러오기 현황 (진단용) */
  readonly stats = { loaded: 0, failed: 0, missing: 0, shrunk: 0, unloaded: 0, failedNames: [] as string[], missingNames: [] as string[] };
  private lastTime: number | null = null;
  private destroyed = false;
  /** 가림막 장식들 (화면에 그리지 않고, 매 프레임 가림막 그림으로만 그린다) */
  private readonly maskLayer = new Container();
  private maskRT: RenderTexture | null = null;
  /** 가림막 그림을 화면 전체에 까는 스프라이트 (가려질 장식들의 mask) */
  private readonly maskSprite = new Sprite(Texture.EMPTY);
  /** 이번 프레임에 가림막·가려질 장식이 보이는지 */
  private maskUsed = false;
  /** 픽셀 그대로 그릴 그림 이름 (원작 imageSmoothing 끔) */
  private readonly nearest = new Set<string>();
  /** 배경처럼 크게 쓰는 그림 이름 · 지금 크게 올라가 있는 그림 */
  private readonly bigNames = new Set<string>();
  private readonly bigLoaded = new Set<string>();

  constructor(
    private readonly chart: Chart,
    private readonly tl: VisualTimeline,
    private readonly urlOf: (name: string) => string | null,
  ) {
    this.behind.sortableChildren = true;
    this.front.sortableChildren = true;
    for (const d of tl.decos) {
      const o = this.makeObj(d);
      this.place(o, d.def.mask ?? null, d.def.depth ?? -1);
      this.objs.push(o);
      if (d.def.smooth === false && d.def.image) this.nearest.add(d.def.image);
      // 크게 늘려 쓰는 그림 (배경): 원작 크기 300% 이상이거나 화면에 고정된 큰 그림
      const sc = Math.max(Math.abs(d.def.scale?.[0] ?? 1), Math.abs(d.def.scale?.[1] ?? 1));
      if (d.def.image && (sc >= 3 || (d.def.parallax && Math.min(d.def.parallax[0], d.def.parallax[1]) >= 0.5 && sc >= 1.5))) this.bigNames.add(d.def.image);
    }
  }

  /** 깊이·가리기에 맞는 층에 둔다 (가림막은 화면에 안 그리는 층). */
  private place(o: Obj, mask: string | null, depth: number): void {
    const want = mask === 'mask' ? this.maskLayer : depth >= 0 ? this.behind : this.front;
    o.node.zIndex = -depth;
    if (o.node.parent !== want) want.addChild(o.node);
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
      return { node: layer, image: null, masked: null, ps: { def: p, layer, live: [], pool: [], debt: 0, rate: rand(p.rate[0], p.rate[1]), clearSerial: d.clearSerial, c0, c1, lx: null, ly: null } };
    }
    if (def.shape === 'planet') {
      // 흰색으로 그려 두고 색은 tint로 (색 바꾸기 이벤트가 그대로 먹게)
      const g = new Graphics().circle(0, 0, PLANET_R).fill({ color: 0xffffff });
      return { node: g, image: null, masked: null };
    }
    if (def.shape === 'tile') {
      const w = TILE_LEN;
      const g = new Graphics()
        .rect(-w / 2, -BLOCK_W / 2, w, BLOCK_W)
        .fill({ color: 0xffffff })
        .rect(-w / 2 + 5, -BLOCK_W / 2 + 5, w - 10, BLOCK_W - 10)
        .fill({ color: 0xffffff, alpha: 0.35 });
      return { node: g, image: null, masked: null };
    }
    if (def.text !== undefined) return { node: this.makeText(d), image: null, masked: null };
    // 이어 붙인 그림 (원작 tile)
    const s = def.tile ? new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 }) : new Sprite(Texture.EMPTY);
    s.anchor.set(0.5);
    if (def.blend) s.blendMode = def.blend;
    return { node: s, image: null, masked: null };
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
    this.lastUsed.set(name, performance.now());
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
    this.queue.push(name);
    this.pump();
    return null;
  }

  /** 대기 중인 그림을 몇 장씩 해독해 올린다. */
  private pump(): void {
    while (this.loading < MAX_LOADING && this.queue.length) {
      const name = this.queue.shift()!;
      const url = this.urlOf(name);
      if (!url || this.tex.get(name) !== 'loading') continue;
      this.loading++;
      const img = new Image();
      const done = () => {
        this.loading--;
        this.pump();
      };
      img.onload = () => {
        if (this.destroyed || this.tex.get(name) !== 'loading') return done();
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const big = this.bigNames.has(name) && this.bigLoaded.size < MAX_BIG;
        if (big) this.bigLoaded.add(name);
        const k = Math.min(1, (big ? MAX_TEX_BIG : MAX_TEX) / Math.max(w, h, 1));
        let t: Texture;
        if (k < 1) {
          // 너무 큰 그림은 줄여서 올리고, 그리는 크기는 원래대로
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * k));
          cv.height = Math.max(1, Math.round(h * k));
          cv.getContext('2d')?.drawImage(img, 0, 0, cv.width, cv.height);
          t = Texture.from(cv);
          if (this.nearest.has(name)) t.source.scaleMode = 'nearest';
          this.texFactor.set(t, w / cv.width);
          this.stats.shrunk++;
        } else {
          t = Texture.from(img);
          if (this.nearest.has(name)) t.source.scaleMode = 'nearest';
        }
        this.tex.set(name, t);
        this.stats.loaded++;
        done();
      };
      img.onerror = () => {
        this.tex.set(name, null);
        this.stats.failed++;
        if (this.stats.failedNames.length < 20) this.stats.failedNames.push(name);
        done();
      };
      img.src = url;
    }
  }

  /** 한동안 안 쓴 그림을 GPU에서 내린다 (그 그림을 쓰던 장식은 다시 보일 때 새로 불러온다). */
  private sweep(now: number): void {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    let dropped: Set<string> | null = null;
    for (const [name, t] of this.tex) {
      if (!t || t === 'loading') continue;
      if (now - (this.lastUsed.get(name) ?? 0) < UNLOAD_AFTER_MS) continue;
      (dropped ??= new Set()).add(name);
    }
    if (!dropped) return;
    for (const o of this.objs) {
      if (o.image && dropped.has(o.image) && (o.node instanceof Sprite || o.node instanceof TilingSprite)) {
        o.node.texture = Texture.EMPTY;
        o.image = null;
      }
    }
    for (const name of dropped) {
      const t = this.tex.get(name) as Texture;
      this.texFactor.delete(t);
      const cl = this.cells.get(t);
      if (cl) {
        for (const c of cl) c.destroy();
        this.cells.delete(t);
      }
      t.destroy(true);
      this.tex.delete(name);
      this.bigLoaded.delete(name);
      this.stats.loaded--;
      this.stats.unloaded++;
    }
  }

  /**
   * camX, camY: 카메라 중심 (화면 좌표, y 아래쪽). camRot: 카메라 회전 (도). time: 곡 시각 (초, 입자 시뮬레이션용).
   */
  update(camX: number, camY: number, camRot: number, time?: number, camZoom = 1): void {
    const decos = this.tl.decos;
    const now = performance.now();
    this.sweep(now);
    this.maskUsed = false;
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
      // 깊이·가리기 바뀜 (원작 MoveDecorations)
      if (node.zIndex !== -d.depth || (d.mask === 'mask') !== (node.parent === this.maskLayer)) this.place(o, d.mask, d.depth);
      const isMask = d.mask === 'mask';
      // 가림막은 투명도와 상관없이 모양만 쓴다 (원작 SpriteMask)
      node.visible = d.visible && (isMask || d.opacity * d.calpha > 0.001) && (!o.ps || o.ps.live.length > 0);
      const want = d.mask === 'inside' || d.mask === 'outside' ? d.mask : null;
      if (want !== o.masked) {
        o.masked = want;
        // 원작 가림막은 모양(알파)만 본다 — 빨강 채널을 쓰면 검게 칠한 가림막이 없는 것처럼 돼 화면이 까매진다
        if (want) node.setMask({ mask: this.maskSprite, inverse: want === 'outside', channel: 'alpha' });
        else node.mask = null;
      }
      if (!node.visible) continue;
      if (isMask || want) this.maskUsed = true;
      // 이미지 교체·지연 로드
      if (o.image) this.lastUsed.set(o.image, now);
      if ((node instanceof Sprite || node instanceof TilingSprite) && d.image !== o.image) {
        const t = d.image ? this.texture(d.image) : null;
        if (t || !d.image) {
          node.texture = t ?? Texture.EMPTY;
          o.image = d.image;
          if (node instanceof TilingSprite && t) {
            // 원작 tile은 크기는 그대로 두고 그 안에 그림을 여러 번 (BIKE 산: 6번 반복, 한 칸 = 흐름 거리)
            node.width = t.width;
            node.height = t.height;
            node.tileScale.set(1 / (def.tile?.[0] ?? 1), 1 / (def.tile?.[1] ?? 1));
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
        // 카메라 따라가기 (원작 parallax): 장식 자신의 자리에서 카메라가 벗어난 만큼 비율로 따라가고,
        // parallaxOffset은 그 위에 그대로 더한다 (BIKE 산 장식: 위·아래로 벌려 두는 값 — 비율을 곱하면 화면 가운데를 덮었다).
        // 100%면 화면 가운데에 고정. 기준을 장식이 붙은 타일로 잡으면 멀리 놓인 큰 배경(Hello (BPM) 2025의 하늘)이 화면 밖으로 나갔다
        const ax = bx + px;
        const ay = by - py;
        x = ax + (camX - ax) * d.parx + d.pox;
        y = ay + (camY - ay) * d.pary - d.poy;
        if (def.lockRotation) r -= rc;
      }
      node.position.set(x, y);
      node.rotation = r;
      node.alpha = isMask ? 1 : d.opacity * d.calpha;
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
    // 살아 있는 입자가 쓰는 그림은 내리지 않는다
    if (ps.live.length && d.image) this.lastUsed.set(d.image, performance.now());
    // world: 방출 장소가 움직인 만큼 입자를 반대로 옮겨 제자리에 둔다 (회전은 무시)
    const L = ps.layer;
    if (p.world && ps.lx !== null && ps.ly !== null && L.scale.x && L.scale.y) {
      const dx = (L.x - ps.lx) / L.scale.x;
      const dy = (L.y - ps.ly) / L.scale.y;
      if (dx || dy)
        for (const q of ps.live) {
          q.x -= dx;
          q.y += dy;
        }
    }
    ps.lx = L.x;
    ps.ly = L.y;
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
      if (p.sizeLife) {
        const m = p.sizeLife[0] + (p.sizeLife[1] - p.sizeLife[0]) * f;
        q.s.scale.set(q.bx * m, q.by * m);
      }
      q.s.tint = ps.c0 === ps.c1 ? ps.c0 : lerpColor(ps.c0, ps.c1, f);
      keep.push(q);
    }
    ps.live = keep;
  }

  /** 그림을 cols×rows 칸으로 나눈 한 칸 (칸 그림은 원래 그림이 바뀌기 전까지 재사용) */
  private readonly cells = new Map<Texture, Texture[]>();
  private cell(tex: Texture, cols: number, rows: number): Texture {
    let list = this.cells.get(tex);
    if (!list) {
      list = [];
      const w = tex.width / cols;
      const h = tex.height / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) list.push(new Texture({ source: tex.source, frame: new Rectangle(tex.frame.x + c * w, tex.frame.y + r * h, w, h) }));
      this.cells.set(tex, list);
    }
    return list[Math.floor(Math.random() * list.length)];
  }

  private spawn(ps: PSys, tex: Texture | null): void {
    const p = ps.def;
    const s = ps.pool.pop() ?? new Sprite(Texture.EMPTY);
    s.anchor.set(0.5);
    const sheet = tex && p.sheet && (p.sheet[0] > 1 || p.sheet[1] > 1) ? p.sheet : null;
    s.texture = tex ? (sheet ? this.cell(tex, sheet[0], sheet[1]) : tex) : Texture.WHITE;
    const size = rand(p.size[0], p.size[1]);
    // 그림이 없으면 작은 흰 사각형. 칸으로 나눈 그림은 한 칸이 원래 그림 크기로 보이게
    const base = tex ? DECO_PX : TILE_LEN * 0.08;
    const k = base * size * (tex ? (this.texFactor.get(tex) ?? 1) : 1 / Math.max(1, s.texture.width));
    const bx = k * (sheet ? sheet[0] : 1);
    const by = k * (sheet ? sheet[1] : 1);
    s.scale.set(bx, by);
    const area = p.area ?? [0, 0];
    let x = (Math.random() - 0.5) * area[0];
    let y = (Math.random() - 0.5) * area[1];
    if (p.circle) {
      // 원 안 (arc가 있으면 그 각도 범위만)
      const a = degToRad(Math.random() * (p.arc ?? 360));
      const r = Math.sqrt(Math.random()) * 0.5;
      x = Math.cos(a) * r * area[0];
      y = Math.sin(a) * r * area[1];
    }
    const q: Particle = {
      s,
      x,
      y,
      bx,
      by,
      vx: rand(p.velocity[0][0], p.velocity[1][0]),
      vy: rand(p.velocity[0][1], p.velocity[1][1]),
      rot: p.rot0 ? rand(p.rot0[0], p.rot0[1]) : 0,
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

  /**
   * 가림막 장식들을 화면 크기 그림으로 그려 둔다 (가려질 장식의 mask). 카메라 변환이 정해진 뒤, 화면 그리기 전에.
   * worldTransform: 월드 → 화면 변환.
   */
  renderMask(renderer: Renderer, worldTransform: Matrix, width: number, height: number): void {
    if (!this.maskUsed) return;
    const res = renderer.resolution;
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    if (!this.maskRT || this.maskRT.width !== w || this.maskRT.height !== h || this.maskRT.source.resolution !== res) {
      this.maskRT?.destroy(true);
      this.maskRT = RenderTexture.create({ width: w, height: h, resolution: res });
      this.maskSprite.texture = this.maskRT;
    }
    renderer.render({ container: this.maskLayer, target: this.maskRT, clear: true, clearColor: [0, 0, 0, 0], transform: worldTransform });
  }

  destroy(): void {
    this.destroyed = true;
    for (const list of this.cells.values()) for (const t of list) t.destroy();
    this.maskLayer.destroy({ children: true });
    this.maskSprite.destroy();
    this.maskRT?.destroy(true);
    this.behind.destroy({ children: true });
    this.front.destroy({ children: true });
    for (const t of this.tex.values()) if (t && t !== 'loading') t.destroy(true);
  }
}

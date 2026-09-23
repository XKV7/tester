import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { TILE_LEN } from '../core/math';

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
}

/** 카메라 상태 (월드 좌표, y 반전된 화면 기준). */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0; // 도
  /** 목표를 지수 감쇠로 따라감. dt: 초 (시각 보간 전용). */
  follow(tx: number, ty: number, tzoom: number, trot: number, dt: number, k = 6): void {
    const f = 1 - Math.exp(-k * dt);
    this.x += (tx - this.x) * f;
    this.y += (ty - this.y) * f;
    this.zoom += (tzoom - this.zoom) * (1 - Math.exp(-10 * dt));
    this.rotation += (trot - this.rotation) * (1 - Math.exp(-10 * dt));
  }
  snap(x: number, y: number, zoom = this.zoom, rot = this.rotation): void {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.rotation = rot;
  }
}

/** Pixi 앱 + 공통 레이어 (배경 입자, 월드, 플래시). 게임·에디터·타이틀이 공유한다. */
export class Stage {
  app!: Application;
  readonly bg = new Container();
  readonly world = new Container();
  readonly overlay = new Container();
  private readonly flash = new Graphics();
  private bgSprite: Sprite | null = null;
  private bgImageUrl: string | null = null;
  private motes: Mote[] = [];
  private readonly moteGfx = new Graphics();
  readonly camera = new Camera();
  private lastFrame = performance.now();
  private dt = 0.016;
  private bgColor = 0x0e0f16;

  async init(host: HTMLElement): Promise<void> {
    this.app = new Application();
    await this.app.init({
      resizeTo: host,
      background: this.bgColor,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
    });
    host.appendChild(this.app.canvas);
    this.bg.addChild(this.moteGfx);
    this.app.stage.addChild(this.bg, this.world, this.overlay);
    this.overlay.addChild(this.flash);
    for (let i = 0; i < 70; i++) {
      this.motes.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.004,
        vy: (Math.random() - 0.5) * 0.004 - 0.002,
        r: 0.6 + Math.random() * 1.6,
        a: 0.05 + Math.random() * 0.18,
      });
    }
  }

  get width(): number {
    return this.app.screen.width;
  }
  get height(): number {
    return this.app.screen.height;
  }

  /** 기본 배율: 화면 짧은 변에 약 7타일. */
  get baseScale(): number {
    return Math.min(this.width, this.height) / (TILE_LEN * 7);
  }

  setBackground(color: number): void {
    if (color === this.bgColor) return;
    this.bgColor = color;
    this.app.renderer.background.color = color;
  }

  setBackgroundImage(url: string | null): void {
    if (url === this.bgImageUrl) return;
    this.bgImageUrl = url;
    if (this.bgSprite) {
      this.bgSprite.destroy();
      this.bgSprite = null;
    }
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (this.bgImageUrl !== url) return;
      const s = new Sprite(Texture.from(img));
      s.alpha = 0.55;
      this.bgSprite = s;
      this.bg.addChildAt(s, 0);
      this.layoutBg();
    };
    img.src = url;
  }

  private layoutBg(): void {
    const s = this.bgSprite;
    if (!s) return;
    const k = Math.max(this.width / s.texture.width, this.height / s.texture.height);
    s.scale.set(k);
    s.position.set((this.width - s.texture.width * k) / 2, (this.height - s.texture.height * k) / 2);
  }

  /** 프레임 간격 (초). 카메라·입자 보간 전용 — 게임 시간에는 쓰지 않는다. */
  tick(): number {
    const now = performance.now();
    this.dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    return this.dt;
  }

  /** 매 프레임: 카메라 적용, 배경 입자, 플래시. tick() 뒤에 호출. */
  frame(flashColor: number, flashAlpha: number): void {
    const dt = this.dt;
    const w = this.width;
    const h = this.height;
    const c = this.camera;
    this.world.position.set(w / 2, h / 2);
    this.world.pivot.set(c.x, c.y);
    this.world.scale.set(this.baseScale * c.zoom);
    this.world.rotation = (c.rotation * Math.PI) / 180;

    const g = this.moteGfx;
    g.clear();
    for (const m of this.motes) {
      m.x = (m.x + m.vx * dt + 1) % 1;
      m.y = (m.y + m.vy * dt + 1) % 1;
      g.circle(m.x * w, m.y * h, m.r).fill({ color: 0xaab4ff, alpha: m.a });
    }
    this.layoutBg();

    this.flash.clear();
    if (flashAlpha > 0.001) this.flash.rect(0, 0, w, h).fill({ color: flashColor, alpha: flashAlpha });
  }

  /** 월드에서 보이는 영역 (컬링용, 회전 고려해 원으로 근사). */
  viewRect(): { cx: number; cy: number; radius: number } {
    const s = this.baseScale * this.camera.zoom;
    return { cx: this.camera.x, cy: this.camera.y, radius: Math.hypot(this.width, this.height) / 2 / s };
  }

  /** 화면 좌표 → 월드 좌표. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const p = this.world.toLocal({ x: sx, y: sy });
    return { x: p.x, y: p.y };
  }

  clearWorld(): void {
    for (const ch of [...this.world.children]) {
      this.world.removeChild(ch);
    }
  }
}

export const stage = new Stage();

let ambientFn: (() => void) | null = null;
/** 메뉴 화면용: 월드를 비우고 배경 입자만 움직인다. */
export function ambient(on: boolean): void {
  if (ambientFn) {
    stage.app.ticker.remove(ambientFn);
    ambientFn = null;
  }
  if (!on) return;
  stage.clearWorld();
  stage.setBackground(0x0e0f16);
  stage.setBackgroundImage(null);
  ambientFn = () => {
    stage.tick();
    stage.frame(0, 0);
  };
  stage.app.ticker.add(ambientFn);
}

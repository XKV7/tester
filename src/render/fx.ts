import { Container, Graphics, Text } from 'pixi.js';

interface Particle {
  g: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  kind: 'dot' | 'ring';
  size: number;
  color: number;
}

interface FloatText {
  t: Text;
  x: number;
  y: number;
  born: number;
}

/** 파티클(링·폭발)과 떠오르는 판정 텍스트. 실제 시각(ms) 기준 애니메이션. */
export class FxView {
  readonly container = new Container();
  private parts: Particle[] = [];
  private pool: Graphics[] = [];
  private texts: FloatText[] = [];
  private textPool: Text[] = [];
  rotation = 0;

  private gfx(): Graphics {
    const g = this.pool.pop() ?? new Graphics();
    g.visible = true;
    this.container.addChild(g);
    return g;
  }

  ring(x: number, y: number, color: number, now: number): void {
    const g = this.gfx();
    this.parts.push({ g, x, y, vx: 0, vy: 0, born: now, life: 380, kind: 'ring', size: 18, color });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 0.09 + Math.random() * 0.06;
      this.parts.push({
        g: this.gfx(),
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        born: now,
        life: 320,
        kind: 'dot',
        size: 3,
        color,
      });
    }
  }

  explode(x: number, y: number, color: number, now: number, count = 36): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.05 + Math.random() * 0.25;
      this.parts.push({
        g: this.gfx(),
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        born: now,
        life: 600 + Math.random() * 500,
        kind: 'dot',
        size: 2 + Math.random() * 4,
        color,
      });
    }
  }

  text(label: string, color: number, x: number, y: number, now: number): void {
    const t =
      this.textPool.pop() ??
      new Text({
        text: '',
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: 22,
          fontWeight: '700',
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 4 },
        },
      });
    t.text = label;
    t.style.fill = color;
    t.anchor.set(0.5);
    t.visible = true;
    this.container.addChild(t);
    this.texts.push({ t, x, y, born: now });
  }

  update(now: number): void {
    this.parts = this.parts.filter((p) => {
      const age = now - p.born;
      if (age >= p.life) {
        p.g.clear();
        p.g.visible = false;
        this.container.removeChild(p.g);
        this.pool.push(p.g);
        return false;
      }
      const k = age / p.life;
      p.g.clear();
      if (p.kind === 'ring') {
        p.g.circle(p.x, p.y, p.size + 42 * Math.sqrt(k)).stroke({ width: 4 * (1 - k) + 1, color: p.color, alpha: 1 - k });
      } else {
        const damp = 1 - k * 0.5;
        p.g.circle(p.x + p.vx * age * damp, p.y + p.vy * age * damp, p.size * (1 - k * 0.7)).fill({
          color: p.color,
          alpha: 1 - k,
        });
      }
      return true;
    });
    this.texts = this.texts.filter((f) => {
      const k = (now - f.born) / 400;
      if (k >= 1) {
        f.t.visible = false;
        this.container.removeChild(f.t);
        this.textPool.push(f.t);
        return false;
      }
      // 화면 기준 위쪽으로 떠오르도록 카메라 회전 보정
      const up = 30 * k + 30;
      f.t.position.set(f.x - Math.sin(this.rotation) * up, f.y - Math.cos(this.rotation) * up);
      f.t.rotation = -this.rotation;
      f.t.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      return true;
    });
  }

  clear(): void {
    for (const p of this.parts) {
      p.g.clear();
      this.container.removeChild(p.g);
      this.pool.push(p.g);
    }
    this.parts = [];
    for (const f of this.texts) {
      this.container.removeChild(f.t);
      this.textPool.push(f.t);
    }
    this.texts = [];
  }
}

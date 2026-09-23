import { Container, Graphics } from 'pixi.js';
import { planetContext, PLANET_R, sv } from './shapes';

export const COLOR_A = 0xff8a3d;
export const COLOR_B = 0x3de0d0;

/** 두 행성 + 공전 행성 꼬리 + 홀드 진행 호. */
export class PlanetsView {
  readonly container = new Container();
  readonly a = new Graphics(planetContext(COLOR_A));
  readonly b = new Graphics(planetContext(COLOR_B));
  private readonly tail = new Graphics();
  private readonly arc = new Graphics();

  constructor() {
    this.container.addChild(this.tail, this.arc, this.a, this.b);
  }

  /**
   * @param pivot 축 행성 화면 좌표
   * @param angle 공전 행성 각도 (도, 수학 좌표)
   * @param tailAngles 꼬리 각도 (최근 → 과거)
   * @param aIsPivot 행성 A가 축인지
   */
  update(
    pivot: { x: number; y: number },
    angle: number,
    radius: number,
    tailAngles: number[],
    aIsPivot: boolean,
    holdProgress: number | null,
  ): { x: number; y: number } {
    const v = sv(angle, radius);
    const orb = { x: pivot.x + v.x, y: pivot.y + v.y };
    const pv = aIsPivot ? this.a : this.b;
    const ob = aIsPivot ? this.b : this.a;
    pv.position.set(pivot.x, pivot.y);
    ob.position.set(orb.x, orb.y);
    this.container.setChildIndex(ob, this.container.children.length - 1);

    this.tail.clear();
    const col = aIsPivot ? COLOR_B : COLOR_A;
    for (let k = 0; k < tailAngles.length; k++) {
      const tv = sv(tailAngles[k], radius);
      const f = 1 - (k + 1) / (tailAngles.length + 1);
      this.tail.circle(pivot.x + tv.x, pivot.y + tv.y, PLANET_R * (0.35 + 0.55 * f)).fill({ color: col, alpha: 0.28 * f });
    }

    this.arc.clear();
    if (holdProgress !== null) {
      const p = Math.max(0, Math.min(1, holdProgress));
      this.arc.circle(pivot.x, pivot.y, PLANET_R + 10).stroke({ width: 3, color: 0xffffff, alpha: 0.18 });
      if (p > 0) {
        this.arc
          .arc(pivot.x, pivot.y, PLANET_R + 10, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2)
          .stroke({ width: 4, color: 0xffd36b, alpha: 0.95, cap: 'round' });
      }
    }
    return orb;
  }

  clearTail(): void {
    this.tail.clear();
    this.arc.clear();
  }

  setVisible(v: boolean): void {
    this.container.visible = v;
  }

  setAlpha(a: number, b: number): void {
    this.a.alpha = a;
    this.b.alpha = b;
  }
}

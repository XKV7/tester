import { GraphicsContext } from 'pixi.js';
import { degToRad, TILE_LEN } from '../core/math';

export const BAND_W = 34;
export const PLANET_R = 15;

/** 수학 각도 → 화면 벡터 (y 반전). */
export function sv(deg: number, len = 1): { x: number; y: number } {
  const r = degToRad(deg);
  return { x: Math.cos(r) * len, y: -Math.sin(r) * len };
}

const bandCache = new Map<string, GraphicsContext>();

/** 타일 띠: 이전 방향 반쪽 + 다음 방향 반쪽, 꺾이는 곳은 둥근 이음. 흰색으로 그려 tint로 색칠. */
export function bandContext(angleIn: number | null, angleOut: number | null, midspin: boolean): GraphicsContext {
  const key = `${angleIn === null ? 'n' : angleIn.toFixed(2)}|${angleOut === null ? 'n' : angleOut.toFixed(2)}|${midspin}`;
  let c = bandCache.get(key);
  if (c) return c;
  c = new GraphicsContext();
  const half = TILE_LEN / 2;
  const drawPath = () => {
    const back = angleIn !== null ? sv(angleIn + 180, half) : null;
    const fwd = angleOut !== null && !midspin ? sv(angleOut, half) : null;
    if (back && fwd) c!.moveTo(back.x, back.y).lineTo(0, 0).lineTo(fwd.x, fwd.y);
    else if (back) c!.moveTo(back.x, back.y).lineTo(0, 0);
    else if (fwd) c!.moveTo(0, 0).lineTo(fwd.x, fwd.y);
    return { back, fwd };
  };
  drawPath();
  c.stroke({ width: BAND_W, color: 0xffffff, cap: 'butt', join: 'round' });
  // 끝단(시작·도착·midspin)과 이음부를 둥글게
  c.circle(0, 0, BAND_W / 2).fill({ color: 0xffffff });
  // 안쪽 어두운 띠 (입체감)
  drawPath();
  c.stroke({ width: BAND_W * 0.5, color: 0x000000, alpha: 0.16, cap: 'butt', join: 'round' });
  c.circle(0, 0, BAND_W * 0.25).fill({ color: 0x000000, alpha: 0.16 });
  bandCache.set(key, c);
  return c;
}

export type IconKind =
  | 'twirl'
  | 'speedUp'
  | 'speedDown'
  | 'checkpoint'
  | 'midspin'
  | 'pause'
  | 'finish'
  | 'dirCW'
  | 'dirCCW'
  | 'editorEvent';

const iconCache = new Map<IconKind, GraphicsContext>();

export function iconContext(kind: IconKind): GraphicsContext {
  let c = iconCache.get(kind);
  if (c) return c;
  c = new GraphicsContext();
  switch (kind) {
    case 'twirl': {
      // 소용돌이: 반지름이 줄어드는 나선 + 화살촉
      const pts: number[] = [];
      for (let k = 0; k <= 40; k++) {
        const a = (k / 40) * Math.PI * 3.2;
        const r = 11 - k * 0.22;
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      c.poly(pts, false).stroke({ width: 2.6, color: 0xb98cff, cap: 'round', join: 'round' });
      c.poly([11, -5, 15, 3, 7, 3]).fill({ color: 0xb98cff });
      break;
    }
    case 'speedUp':
      // 겹화살표
      for (const dx of [-6, 3]) c.poly([dx - 4, -8, dx + 5, 0, dx - 4, 8, dx - 1, 0]).fill({ color: 0xff5a5a });
      break;
    case 'speedDown':
      // 느린 화살표: 얇은 화살 하나 + 꼬리
      c.moveTo(-9, 0).lineTo(4, 0).stroke({ width: 2.5, color: 0x5aa8ff, cap: 'round' });
      c.poly([2, -6, 9, 0, 2, 6]).fill({ color: 0x5aa8ff });
      break;
    case 'checkpoint':
      c.moveTo(-5, 10).lineTo(-5, -11).stroke({ width: 2.4, color: 0xffffff, cap: 'round' });
      c.poly([-5, -11, 9, -6, -5, -1]).fill({ color: 0x5cf07a });
      break;
    case 'midspin':
      c.circle(0, 0, 5).fill({ color: 0xffffff, alpha: 0.9 });
      break;
    case 'pause':
      // 모래시계
      c.poly([-7, -10, 7, -10, 0, 0]).fill({ color: 0xffd36b });
      c.poly([-7, 10, 7, 10, 0, 0]).fill({ color: 0xffd36b, alpha: 0.7 });
      c.moveTo(-8, -10).lineTo(8, -10).moveTo(-8, 10).lineTo(8, 10).stroke({ width: 2, color: 0xffffff });
      break;
    case 'finish':
      c.circle(0, 0, 13).stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
      c.circle(0, 0, 6).fill({ color: 0xffffff, alpha: 0.9 });
      break;
    case 'dirCW':
    case 'dirCCW': {
      const s = kind === 'dirCW' ? -1 : 1;
      const pts: number[] = [];
      for (let k = 0; k <= 12; k++) {
        const a = (-0.9 + (k / 12) * 1.8) * s;
        pts.push(Math.cos(a) * 9, -Math.sin(a) * 9);
      }
      c.poly(pts, false).stroke({ width: 1.6, color: 0xffffff, alpha: 0.35, cap: 'round' });
      const ea = 0.9 * s;
      const ex = Math.cos(ea) * 9;
      const ey = -Math.sin(ea) * 9;
      c.poly([ex - 3, ey - 3 * s, ex + 3, ey - 1 * s, ex - 1, ey + 3 * s]).fill({ color: 0xffffff, alpha: 0.35 });
      break;
    }
    case 'editorEvent':
      c.roundRect(-4, -4, 8, 8, 2).fill({ color: 0x7ad1ff });
      break;
  }
  iconCache.set(kind, c);
  return c;
}

const planetCache = new Map<number, GraphicsContext>();
export function planetContext(color: number): GraphicsContext {
  let c = planetCache.get(color);
  if (c) return c;
  c = new GraphicsContext();
  for (let k = 6; k >= 1; k--) c.circle(0, 0, PLANET_R + k * 4).fill({ color, alpha: 0.035 * (7 - k) });
  c.circle(0, 0, PLANET_R).fill({ color });
  c.circle(-PLANET_R * 0.3, -PLANET_R * 0.3, PLANET_R * 0.45).fill({ color: 0xffffff, alpha: 0.35 });
  planetCache.set(color, c);
  return c;
}

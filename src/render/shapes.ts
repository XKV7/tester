import { GraphicsContext } from 'pixi.js';
import { degToRad, TILE_LEN } from '../core/math';

export const BAND_W = 42;
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

/** 원작식 블록 타일 굵기와 테두리 두께. */
export const BLOCK_W = 58;
export const BLOCK_BORDER = 6;
const blockCache = new Map<string, { outer: GraphicsContext; inner: GraphicsContext }>();

/**
 * 원작식 사각 블록 타일: 바깥(테두리 색) + 안쪽(속 색) 두 겹. 모서리는 각지게, 흰색으로 그려 tint로 색칠.
 */
export function blockContexts(angleIn: number | null, angleOut: number | null, midspin: boolean): { outer: GraphicsContext; inner: GraphicsContext } {
  const key = `${angleIn === null ? 'n' : angleIn.toFixed(2)}|${angleOut === null ? 'n' : angleOut.toFixed(2)}|${midspin}`;
  const hit = blockCache.get(key);
  if (hit) return hit;
  const half = TILE_LEN / 2;
  const back = angleIn !== null ? sv(angleIn + 180, half) : null;
  const fwd = angleOut !== null && !midspin ? sv(angleOut, half) : null;
  const draw = (c: GraphicsContext, w: number, trim: number) => {
    // 끝을 조금 줄여 이웃 타일과 경계가 보이게
    const shorten = (v: { x: number; y: number }) => {
      const l = Math.hypot(v.x, v.y) || 1;
      return { x: (v.x * (l - trim)) / l, y: (v.y * (l - trim)) / l };
    };
    const b = back ? shorten(back) : null;
    const f = fwd ? shorten(fwd) : null;
    if (b && f) c.moveTo(b.x, b.y).lineTo(0, 0).lineTo(f.x, f.y);
    else if (b) c.moveTo(b.x, b.y).lineTo(0, 0);
    else if (f) c.moveTo(0, 0).lineTo(f.x, f.y);
    else c.moveTo(-1, 0).lineTo(1, 0);
    c.stroke({ width: w, color: 0xffffff, cap: 'butt', join: 'miter', miterLimit: 3 });
    // 한쪽만 있는 타일(시작·끝·미드스핀)은 중심 쪽 끝도 네모나게
    if (!(b && f)) c.rect(-w / 2, -w / 2, w, w).fill({ color: 0xffffff });
  };
  const outer = new GraphicsContext();
  draw(outer, BLOCK_W, 0.5);
  const inner = new GraphicsContext();
  draw(inner, BLOCK_W - BLOCK_BORDER * 2, BLOCK_BORDER + 0.5);
  const v = { outer, inner };
  blockCache.set(key, v);
  return v;
}

export type IconKind =
  | 'twirl'
  | 'speedUp'
  | 'speedUp2'
  | 'speedDown'
  | 'speedDown2'
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
      rabbit(c, 0, 0.95);
      break;
    case 'speedUp2':
      rabbit(c, -6, 0.8);
      rabbit(c, 6, 0.8);
      break;
    case 'speedDown':
      snail(c, 0, 0.95);
      break;
    case 'speedDown2':
      snail(c, -10, 0.7);
      snail(c, 10, 0.7);
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

/** 토끼 (빨라짐): 두 귀 + 머리 + 눈. 직접 그린 단순한 모양. */
function rabbit(c: GraphicsContext, dx: number, k: number): void {
  const col = 0xff6b6b;
  c.ellipse(dx - 4 * k, -9 * k, 2.6 * k, 7 * k).fill({ color: col });
  c.ellipse(dx + 4 * k, -9 * k, 2.6 * k, 7 * k).fill({ color: col });
  c.ellipse(dx - 4 * k, -9 * k, 1.1 * k, 4.8 * k).fill({ color: 0xffd0d0 });
  c.ellipse(dx + 4 * k, -9 * k, 1.1 * k, 4.8 * k).fill({ color: 0xffd0d0 });
  c.circle(dx, 3 * k, 8 * k).fill({ color: col });
  c.circle(dx - 3 * k, 2 * k, 1.4 * k).fill({ color: 0x3a1010 });
  c.circle(dx + 3 * k, 2 * k, 1.4 * k).fill({ color: 0x3a1010 });
  c.circle(dx, 5.5 * k, 1.3 * k).fill({ color: 0xffd0d0 });
}

/** 달팽이 (느려짐): 소용돌이 껍데기 + 몸 + 더듬이. 직접 그린 단순한 모양. */
function snail(c: GraphicsContext, dx: number, k: number): void {
  const col = 0x5aa8ff;
  // 몸
  c.roundRect(dx - 11 * k, 4 * k, 22 * k, 6 * k, 3 * k).fill({ color: 0x9fd0ff });
  c.moveTo(dx + 7 * k, 5 * k).lineTo(dx + 10 * k, -4 * k).stroke({ width: 1.4 * k, color: 0x9fd0ff, cap: 'round' });
  c.moveTo(dx + 9 * k, 5 * k).lineTo(dx + 13 * k, -2 * k).stroke({ width: 1.4 * k, color: 0x9fd0ff, cap: 'round' });
  c.circle(dx + 10 * k, -4 * k, 1.5 * k).fill({ color: 0x9fd0ff });
  c.circle(dx + 13 * k, -2 * k, 1.5 * k).fill({ color: 0x9fd0ff });
  // 껍데기
  c.circle(dx - 2 * k, 0, 8.5 * k).fill({ color: col });
  const pts: number[] = [];
  for (let i = 0; i <= 30; i++) {
    const a = (i / 30) * Math.PI * 3.4;
    const r = 7 * k - i * 0.21 * k;
    pts.push(dx - 2 * k + Math.cos(a) * r, Math.sin(a) * r);
  }
  c.poly(pts, false).stroke({ width: 1.5 * k, color: 0x1f4f8a, cap: 'round' });
}

const planetCache = new Map<number, GraphicsContext>();
export function planetContext(color: number, bold = false): GraphicsContext {
  const key = color + (bold ? 0x1000000 : 0);
  let c = planetCache.get(key);
  if (c) return c;
  c = new GraphicsContext();
  for (let k = 6; k >= 1; k--) c.circle(0, 0, PLANET_R + k * 4).fill({ color, alpha: (bold ? 0.06 : 0.035) * (7 - k) });
  // 강조: 검은 테두리로 밝은 배경에서도 행성이 묻히지 않게
  if (bold) c.circle(0, 0, PLANET_R + 3).fill({ color: 0x000000, alpha: 0.6 });
  c.circle(0, 0, PLANET_R).fill({ color });
  c.circle(-PLANET_R * 0.3, -PLANET_R * 0.3, PLANET_R * 0.45).fill({ color: 0xffffff, alpha: 0.35 });
  planetCache.set(key, c);
  return c;
}

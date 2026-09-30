/** '#rrggbb' / '#rgb' → 0xRRGGBB. 실패 시 fallback. */
export function parseColor(s: string | undefined, fallback = 0xffffff): number {
  if (!s) return fallback;
  let h = s.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return parseInt(h, 16);
}

export function isColor(s: unknown): boolean {
  return typeof s === 'string' && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

export function toHex(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

export function lerpColor(a: number, b: number, t: number): number {
  t = t > 1 ? 1 : t > 0 ? t : 0; // 범위를 넘으면 색이 깨진다
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255;
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function scaleColor(c: number, k: number): number {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255);
}

/** 색상환 위치(0~1) → 선명한 색 (무지개 트랙). */
export function hueColor(h: number): number {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}

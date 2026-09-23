import type { EaseName } from './types';

export const EASE_NAMES: EaseName[] = [
  'linear',
  'inSine',
  'outSine',
  'inOutSine',
  'inQuad',
  'outQuad',
  'inOutQuad',
  'outBack',
  'outElastic',
];

const fns: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

export function ease(name: EaseName | undefined, t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return (fns[name ?? 'linear'] ?? fns.linear)(c);
}

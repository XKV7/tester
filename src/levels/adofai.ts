import { compileChart } from '../core/chart';
import { TILE_LEN } from '../core/math';
import { defaultMeta, defaultSettings, FILTER_NAMES, MAX_BPM, MAX_EFFECT_BEATS, MAX_EXTRA_BEATS, MAX_MULTIPLIER, validateLevel } from '../core/level';
import { EASE_NAMES } from '../core/ease';
import type { Action, JudgeRuleAction, DecoBlend, DecoMask, Decoration, EaseName, LevelData, ParticleDef, RecolorTrackAction, TrackAppear, TrackDisappear, TrackStyle } from '../core/types';

/**
 * 얼음과 불의 춤(.adofai) 레벨 → ORBIT 레벨 변환. 순수 함수.
 *
 * 좌표·방향 규칙이 같다: angleData[i] = 타일 i에서 i+1로 가는 절대 각도(0°=오른쪽, 90°=위),
 * 첫 타일의 진입각 180°, 기본 회전 시계 방향, 두 각도가 같으면 360°(U턴).
 * 그래서 타일 배치·박은 그대로 옮기고, 이벤트는 ORBIT에 있는 것만 옮긴다(없는 연출은 경고로 개수만 알림).
 */

export interface AdofaiResult {
  level: LevelData;
  /** 원본이 가리키는 음원 파일 이름 (없으면 ''). */
  songFile: string;
  warnings: string[];
}

/** pathData 글자 → 절대 각도. 숫자 글자는 이전 방향 기준 상대 회전(정오각형·정칠각형). */
const PATH_CHARS: Record<string, number> = {
  R: 0, p: 15, J: 30, E: 45, T: 60, o: 75, U: 90, q: 105, G: 120, Q: 135, H: 150, W: 165,
  L: 180, x: 195, N: 210, Z: 225, F: 240, V: 255, D: 270, Y: 285, B: 300, C: 315, M: 330, A: 345,
  '!': 999,
};
const RELATIVE_CHARS: Record<string, number> = { '5': 72, '6': -72, '7': 360 / 7, '8': -360 / 7 };
const MIDSPIN = 999;

/**
 * .adofai는 JSON과 비슷하지만 BOM, 끝에 붙은 쉼표(`, }`), 문자열 안 줄바꿈이 흔하다.
 * 문자열 밖의 끝 쉼표만 지우고, 문자열 안 제어 문자는 이스케이프해 JSON.parse에 넘긴다.
 */
export function parseLenientJson(text: string): unknown {
  const s = text.replace(/^\uFEFF/, '');
  const out: string[] = [];
  let inStr = false;
  // 마지막 의미 있는 글자, 그 뒤에 공백이 있었는지 (빠진 쉼표 넣기용)
  let last = '';
  let gap = false;
  const isWord = (ch: string) => /[0-9A-Za-z.+]/.test(ch);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        out.push(c + (s[i + 1] ?? ''));
        i++;
      } else if (c === '"') {
        inStr = false;
        out.push(c);
        last = '"';
        gap = false;
      } else if (c === '\n') out.push('\\n');
      else if (c === '\r') out.push('\\r');
      else if (c === '\t') out.push('\\t');
      else out.push(c);
      continue;
    }
    if (/\s/.test(c)) {
      out.push(c);
      gap = true;
      continue;
    }
    // 원작 파일엔 쉼표가 빠진 곳이 있다 (원작은 받아 준다): 값이 끝난 뒤 바로 새 값이 오면 쉼표를 넣는다
    if (c === '{' || c === '[' || c === '"' || c === '-' || isWord(c)) {
      const valueEnd = last === '}' || last === ']' || last === '"' || isWord(last);
      if (valueEnd && (last === '}' || last === ']' || last === '"' || gap)) out.push(',');
    }
    if (c === '"') {
      inStr = true;
      out.push(c);
    } else if (c === ',') {
      // 다음 의미 있는 글자가 } 또는 ] 이면 버린다
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== '}' && s[j] !== ']') out.push(c);
      else {
        gap = true;
        continue;
      }
    } else out.push(c);
    last = c;
    gap = false;
  }
  return JSON.parse(out.join(''));
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** 연출 지속 시간 (박): 0 ~ 한계. */
const dur = (v: unknown, d: number): number => Math.max(0, Math.min(MAX_EFFECT_BEATS, num(v, d)));
const onOff = (v: unknown): boolean => v === true || v === 'Enabled' || v === 'enabled';

/** <color=#fff>…</color> 같은 서식 태그 제거. */
/** 글자 장식용: 서식 태그만 떼고 줄바꿈·공백은 그대로. */
export function richToPlain(s: string): string {
  return s.replace(/<\/?(?:color|b|i|u|s|size|material|quad|sprite|font|mark|sup|sub|alpha|align|cspace|line-height|voffset|br|nobr|noparse|pos|space|width|indent|margin|rotate|lowercase|uppercase|smallcaps|style|link|gradient)\b[^>]*>/gi, '');
}

export function stripRichText(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

/** 'debb7b', '#debb7bff' → '#debb7b'. 잘못된 값이면 null. */
export function adofaiColor(v: unknown): string | null {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(str(v).trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** 원작 8자리 색(RRGGBBAA)의 불투명도 (0~1). 6자리면 1. */
export function adofaiAlpha(v: unknown): number {
  const m = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(str(v).trim());
  return m ? parseInt(m[1], 16) / 255 : 1;
}

/** 원작 AddParticle → 입자 설정. */
function particleFrom(e: Record<string, unknown>): ParticleDef {
  const pair = (v: unknown, d: [number, number]): [number, number] => (Array.isArray(v) ? [num(v[0], d[0]), num(v[1], d[1])] : [num(v, d[0]), num(v, d[1])]);
  const sorted = (x: [number, number]): [number, number] => (x[0] <= x[1] ? x : [x[1], x[0]]);
  const vel = Array.isArray(e.velocity) ? e.velocity : [];
  const v0 = pair(vel[0], [0, 0]);
  const v1 = pair(vel[1], v0);
  const p: ParticleDef = {
    rate: sorted(pair(e.emissionRate, [10, 10])),
    lifetime: sorted(pair(e.particleLifetime, [1, 1])),
    size: sorted(pair(e.particleSize, [100, 100]).map((x) => Math.max(0, x / 100)) as [number, number]),
    velocity: [
      [v0[0] * TILE_LEN, v0[1] * TILE_LEN],
      [v1[0] * TILE_LEN, v1[1] * TILE_LEN],
    ],
  };
  const spin = pair(e.rotationOverTime, [0, 0]);
  if (spin[0] || spin[1]) p.spin = sorted([(spin[0] * 180) / Math.PI, (spin[1] * 180) / Math.PI]);
  // 방출 영역: 원작 모양 크기 (사각형 = scale, 원 = 반지름 × scale)
  const sc = pair(e.scale, [100, 100]).map((x) => Math.abs(x) / 100);
  const shape = str(e.shapeType);
  const rad = num(e.shapeRadius, 1);
  const rect = shape === 'Rectangle' || shape === 'Box';
  const area: [number, number] = rect ? [sc[0] * TILE_LEN, sc[1] * TILE_LEN] : [2 * rad * sc[0] * TILE_LEN, 2 * rad * sc[1] * TILE_LEN];
  if (area[0] > 0 || area[1] > 0) p.area = area;
  if (!rect && p.area) {
    p.circle = true;
    const arc = num(e.arc, 360);
    if (arc < 360) p.arc = Math.max(0, arc);
  }
  const r0 = pair(e.startRotation, [0, 0]);
  if (r0[0] || r0[1]) p.rot0 = sorted(r0);
  const sl = pair(e.sizeOverLifetime, [100, 100]);
  if (sl[0] !== 100 || sl[1] !== 100) p.sizeLife = [Math.max(0, sl[0] / 100), Math.max(0, sl[1] / 100)];
  const tt = pair(e.randomTextureTiling, [1, 1]).map((x) => Math.max(1, Math.min(64, Math.round(x)))) as [number, number];
  if (tt[0] > 1 || tt[1] > 1) p.sheet = tt;
  if (str(e.simulationSpace) === 'World') p.world = true;
  const col = e.colorOverLifetime as Record<string, unknown> | undefined;
  const start = e.color as Record<string, unknown> | undefined;
  if (col && str(col.mode) === 'Gradient' && typeof col.gradient1 === 'object' && col.gradient1) {
    const g = col.gradient1 as { colorKeys?: { time: number; color: string }[]; alphaKeys?: { time: number; alpha: number }[] };
    const ck = (g.colorKeys ?? []).slice().sort((a, b) => a.time - b.time);
    const c0 = adofaiColor(ck[0]?.color);
    const c1 = adofaiColor(ck[ck.length - 1]?.color);
    if (c0 && c1) p.colors = [c0, c1];
    const ak = (g.alphaKeys ?? []).filter((k) => typeof k.time === 'number' && typeof k.alpha === 'number');
    if (ak.length) p.alphaKeys = ak.map((k) => [Math.max(0, Math.min(1, k.time)), Math.max(0, Math.min(1, k.alpha))]);
  } else {
    const c = adofaiColor((col && str(col.mode) === 'Color' ? col.color1 : undefined) ?? start?.color1);
    if (c && c !== '#ffffff') p.colors = [c, c];
  }
  if (e.autoPlay === true || e.autoPlay === 'Enabled') p.autoPlay = true;
  const pd = num(e.playDuration, 0);
  if (pd > 0) p.duration = pd;
  if (e.loop === true || e.loop === 'Enabled') p.loop = true;
  const mx = num(e.maxParticles, 1000);
  p.max = Math.max(1, Math.min(2000, mx));
  const sp = num(e.simulationSpeed, 100) / 100;
  if (sp !== 1) p.speed = Math.max(0, Math.min(20, sp));
  return p;
}

/** 원작 AddObject → 도형 장식 (행성 또는 타일). */
function objectFrom(e: Record<string, unknown>, floor: number): Decoration | null {
  const kind = str(e.objectType);
  const planet = kind === 'Planet';
  const d = decoFrom({ ...e, decorationImage: 'x' }, floor, false);
  if (!d) return null;
  delete d.image;
  d.shape = planet ? 'planet' : 'tile';
  const colKey = planet ? e.planetColor : e.trackColor;
  const c = adofaiColor(colKey) ?? (planet ? '#ff8a3d' : '#debb7b');
  d.color = c;
  const a = planet ? adofaiAlpha(colKey) : num(e.trackOpacity, 100) / 100;
  if (a < 1) d.opacity = Math.max(0, a * (d.opacity ?? 1));
  if (!planet) {
    const ang = num(e.trackAngle, 180);
    if (ang !== 180) d.rotation = (d.rotation ?? 0) + (180 - ang) / 2;
  }
  return d;
}

function mapEase(v: unknown): EaseName | undefined {
  const s = str(v);
  if (!s) return undefined;
  const lc = (s[0].toLowerCase() + s.slice(1)) as EaseName;
  if (EASE_NAMES.includes(lc)) return lc;
  // 없는 종류는 가까운 것으로 (Cubic·Quart·Expo·Circ… → Quad, Bounce → Elastic)
  const m = /^(InOut|In|Out)(\w+)$/.exec(s);
  if (!m) return 'linear';
  const [, dir, kind] = m;
  if (kind === 'Back' || kind === 'Elastic' || kind === 'Bounce') return kind === 'Back' ? 'outBack' : 'outElastic';
  const base = kind === 'Sine' ? 'Sine' : 'Quad';
  return `${dir === 'In' ? 'in' : dir === 'Out' ? 'out' : 'inOut'}${base}` as EaseName;
}

/** 원본의 angleData / pathData → 절대 각도 배열 (999 = 미드스핀). */
function readAngles(raw: Record<string, unknown>, warnings: string[]): number[] {
  if (Array.isArray(raw.angleData)) return raw.angleData.map((v) => num(v, 0));
  const pd = str(raw.pathData);
  const out: number[] = [];
  let prev = 0;
  let unknown = 0;
  for (const ch of pd) {
    let a: number;
    if (ch in PATH_CHARS) a = PATH_CHARS[ch];
    else if (ch in RELATIVE_CHARS) a = (((prev + RELATIVE_CHARS[ch]) % 360) + 360) % 360;
    else {
      unknown++;
      a = prev;
    }
    out.push(a);
    if (a !== MIDSPIN) prev = a;
  }
  if (unknown) warnings.push(`pathData의 알 수 없는 글자 ${unknown}개는 앞 방향으로 대체했습니다.`);
  return out;
}

/** 타일 참조 [n, "ThisTile"|"Start"|"End"] → 절대 타일 번호. */
function tileRef(ref: unknown, floor: number, last: number): number {
  if (!Array.isArray(ref)) return floor;
  const n = Math.round(num(ref[0], 0));
  const base = ref[1] === 'Start' ? 0 : ref[1] === 'End' ? last : floor;
  return Math.max(0, Math.min(last, base + n));
}

const STYLE_MAP: Record<string, TrackStyle> = { Standard: 'standard', Neon: 'neon', NeonLight: 'neonlight', Basic: 'basic', Minimal: 'basic', Gems: 'standard' };
const APPEAR_MAP: Record<string, TrackAppear> = {
  None: 'none', Fade: 'fade', Grow: 'grow', Grow_Spin: 'spin', Extend: 'extend', Drop: 'drop', Rise: 'rise',
  Assemble: 'scatter', Assemble_Far: 'scatter', Assemble_Scatter: 'scatter', Scatter: 'scatter', Scatter_Far: 'scatter',
};
const DISAPPEAR_MAP: Record<string, TrackDisappear> = {
  None: 'none', Fade: 'fade', Shrink: 'shrink', Shrink_Spin: 'spin', Scatter: 'scatter', Scatter_Far: 'scatter', Retract: 'retract', Rise: 'fade', Drop: 'fade',
};

/** 원작 트랙 색 필드(trackColor·trackStyle·trackColorType·secondaryTrackColor …) → RecolorTrack의 색·모양·물결. */
function trackLook(e: Record<string, unknown>): Pick<RecolorTrackAction, 'color' | 'style' | 'color2' | 'glowDuration' | 'pulseLength' | 'lit' | 'colorMode' | 'pulseBack'> | null {
  const c = adofaiColor(e.trackColor);
  if (!c) return null;
  const look: Pick<RecolorTrackAction, 'color' | 'style' | 'color2' | 'glowDuration' | 'pulseLength' | 'lit' | 'colorMode' | 'pulseBack'> = { color: c };
  // 지나간 타일이 빛나는 정도 (없으면 기본 1)
  if (e.trackGlowIntensity !== undefined) look.lit = Math.max(0, Math.min(1, num(e.trackGlowIntensity, 100) / 100));
  const st = STYLE_MAP[str(e.trackStyle)];
  if (st) look.style = st;
  const type = str(e.trackColorType);
  const c2 = adofaiColor(e.secondaryTrackColor);
  // 무지개는 두 번째 색이 필요 없다
  if (type === 'Rainbow' || (c2 && c2 !== c && (type === 'Glow' || type === 'Blink' || type === 'Switch' || type === 'Volume'))) {
    look.color2 = c2 ?? c;
    look.glowDuration = Math.max(0.05, num(e.trackColorAnimDuration, 2));
    if (type === 'Rainbow') look.colorMode = 'rainbow';
    else if (type === 'Blink' || type === 'Switch') look.colorMode = 'blink';
    const pulse = str(e.trackColorPulse);
    if (pulse && pulse !== 'None') {
      look.pulseLength = Math.max(0, num(e.trackPulseLength, 10));
      if (pulse === 'Backward') look.pulseBack = true;
    }
  }
  return look;
}

/** 원작 AddDecoration / AddText → 장식. 위치 단위: 타일 (× TILE_LEN). */
/** 원작 섞는 방식 → ORBIT (없거나 모르는 방식은 보통) */
function blendFrom(v: unknown): DecoBlend | undefined {
  switch (str(v)) {
    case 'LinearDodge':
    case 'Add':
    case 'Additive':
      return 'add';
    case 'Screen':
      return 'screen';
    case 'Overlay':
      return 'overlay';
    case 'SoftLight':
      return 'soft-light';
    case 'Difference':
      return 'difference';
    case 'Multiply':
      return 'multiply';
    default:
      return undefined;
  }
}

/** 원작 maskingType → ORBIT 가리기 */
function maskFrom(v: unknown): DecoMask | 'none' | undefined {
  switch (str(v)) {
    case 'Mask':
      return 'mask';
    case 'VisibleInsideMask':
      return 'inside';
    case 'VisibleOutsideMask':
      return 'outside';
    case 'None':
      return 'none';
    default:
      return undefined;
  }
}

function decoFrom(e: Record<string, unknown>, floor: number, isText: boolean): Decoration | null {
  const image = str(e.decorationImage).split(/[\\/]/).pop() ?? '';
  // 원작 서식 태그(<color="red"> 등)는 ORBIT 글자에서 그대로 보이므로 뗀다 (줄바꿈은 유지)
  const text = isText ? richToPlain(str(e.decText)) : '';
  if (!isText && !image) return null;
  const rel = str(e.relativeTo);
  const vec = (v: unknown, d: number): [number, number] => (Array.isArray(v) ? [num(v[0], d), num(v[1], d)] : [d, d]);
  const pos = vec(e.position, 0);
  const d: Decoration = {
    relativeTo: rel === 'Global' ? 'global' : rel === 'Camera' || rel === 'CameraAspect' ? 'camera' : 'tile',
    floor,
    position: [pos[0] * TILE_LEN, pos[1] * TILE_LEN],
  };
  if (isText) {
    d.text = text;
    d.fontSize = 40;
  } else d.image = image;
  const tag = str(e.tag).trim();
  if (tag) d.tag = tag;
  const piv = vec(e.pivotOffset, 0);
  if (piv[0] || piv[1]) d.pivot = [piv[0] * TILE_LEN, piv[1] * TILE_LEN];
  const rot = num(e.rotation, 0);
  if (rot) d.rotation = rot;
  const sc = Array.isArray(e.scale) ? vec(e.scale, 100) : [num(e.scale, 100), num(e.scale, 100)];
  if (sc[0] !== 100 || sc[1] !== 100) d.scale = [sc[0] / 100, sc[1] / 100];
  const c = adofaiColor(e.color);
  if (c && c !== '#ffffff') d.color = c;
  const ca = adofaiAlpha(e.color);
  if (ca < 1) d.alpha = ca;
  const op = num(e.opacity, 100) / 100;
  if (op !== 1) d.opacity = Math.max(0, Math.min(1, op));
  d.depth = num(e.depth, -1);
  const par = vec(e.parallax, 0);
  if (par[0] || par[1]) d.parallax = [par[0] / 100, par[1] / 100];
  const po = vec(e.parallaxOffset, 0);
  if (po[0] || po[1]) d.parallaxOffset = [po[0] * TILE_LEN, po[1] * TILE_LEN];
  const tl = vec(e.tile, 1);
  if ((tl[0] !== 1 || tl[1] !== 1) && tl[0] > 0 && tl[1] > 0) d.tile = [Math.min(200, tl[0]), Math.min(200, tl[1])];
  const blend = blendFrom(e.blendMode);
  if (blend) d.blend = blend;
  const mask = maskFrom(e.maskingType);
  if (mask && mask !== 'none') d.mask = mask;
  if (e.imageSmoothing === false) d.smooth = false;
  if (e.lockRotation === true) d.lockRotation = true;
  if (e.lockScale === true) d.lockScale = true;
  if (e.hideIcon === undefined && (e.visible === false || e.visible === 'Disabled')) d.visible = false;
  return d;
}

/** 확장 필터 속성 문자열 ('"filter_Size": 72, "filter_Smooth": 1') → 이름(소문자, 앞 filter_ 제거) → 값 */
export function parseFilterProps(v: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) out.set(k.replace(/^filter_+/i, '').toLowerCase(), x);
    return out;
  }
  const s = str(v).trim();
  if (!s) return out;
  try {
    const o = JSON.parse(s.startsWith('{') ? s : `{${s}}`) as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) out.set(k.replace(/^filter_+/i, '').toLowerCase(), x);
  } catch {
    // 형식이 다르면 속성 없이 기본값
  }
  return out;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface AdvancedConv {
  filters: [string, number][];
  bloom?: { intensity: number; threshold: number; color?: string };
}

/**
 * 원작 CameraFilterPack 필터 → ORBIT 필터(이름, 세기). 없으면 null.
 * 원작 속성 값은 100 = 1 기준. 똑같지는 않고 느낌이 비슷한 쪽으로.
 */
export function advancedFilter(name: string, p: Map<string, unknown>): AdvancedConv | null {
  const n = name.replace(/^CameraFilterPack_/, '');
  const v = (k: string, d: number) => num(p.get(k.replace(/^_+/, '').toLowerCase()), d);
  const one = (f: string, x: number): AdvancedConv => ({ filters: [[f, x]] });
  switch (n) {
    case 'Colors_Brightness':
      return one('Brightness', v('_Brightness', 100) / 100);
    case 'TV_WideScreenHorizontal':
      return one('LetterboxH', Math.max(0, 1 - v('Size', 55) / 100));
    case 'TV_WideScreenVertical':
      return one('LetterboxV', Math.max(0, 1 - v('Size', 55) / 100));
    case 'TV_WideScreenCircle':
    case 'Vision_Tunnel':
      return one('Vignette', 1);
    case 'Color_GrayScale':
      return one('Grayscale', clamp01(v('_Fade', 100) / 100));
    case 'TV_PlanetMars':
      // Fade = 붉은 화성 색이 섞이는 정도 (0 = 거의 그대로)
      return one('Sepia', clamp01(v('Fade', 100) / 100));
    case 'Color_Sepia':
      return one('Sepia', clamp01(v('_Fade', 100) / 100));
    case 'Color_Contrast':
      // 원작 Contrast −100 ~ 100 → 배율 0(회색) ~ 2
      return one('ContrastAdj', Math.max(0, Math.min(3, 1 + v('Contrast', 0) / 100)));
    case 'Sharpen_Sharpen':
      // 원작 값은 매우 크게 쓰인다 (50000 = 강한 윤곽)
      return one('SharpenX', Math.max(0, Math.min(4, v('Value', 400) / 12500)));
    case 'Drawing_Manga_FlashWhite':
      return one('MangaFlash', clamp01(v('Intensity', 100) / 100));
    case 'Vision_Aura': {
      const col = adofaiColor(p.get('color'));
      return {
        filters: [
          ['Aura', Math.min(3, Math.abs(v('Twist', 500)) / 1000)],
          ['AuraSpeed', Math.min(5, Math.abs(v('Speed', 100)) / 100)],
          // 기운 색의 밝기 (원작은 거의 검은색을 많이 쓴다)
          ['AuraTint', col ? [1, 3, 5].reduce((t, i) => t + parseInt(col.slice(i, i + 2), 16), 0) / 765 : 0],
        ],
      };
    }
    case 'Vision_Plasma':
      return one('Plasma', clamp01(v('Intensity', 50) / 100));
    case 'Pixelisation_OilPaint':
      // 유화: 색 단계를 줄이고 살짝 흐리게
      return { filters: [['Posterize', clamp01(v('Value', 50) / 100)], ['Blur', 0.15 * clamp01(v('Value', 50) / 100)]] };
    case 'Blur_Movie': {
      // Radius 0 = 흐림 없음 (원작에서 끄는 대신 자주 쓴다)
      const r = p.has('radius') ? Math.min(1, Math.abs(v('Radius', 100000)) / 100000) : 1;
      return one('Blur', 0.5 * r);
    }
    case 'Blur_Noise':
    case 'Blur_Radial':
    case 'Blur_Radial_Fast':
    case 'Blur_BlurHole':
    case 'Blur_DitherOffset':
    case 'Blur_Focus':
    case 'Blur_GaussianBlur': {
      // 세기 속성이 있으면 그만큼만 (작은 값은 거의 안 흐림)
      const amt = p.has('intensity') ? Math.min(1, Math.abs(v('Intensity', 100)) / 100) : 1;
      return one('Blur', 0.5 * amt);
    }
    case 'FX_Glitch1':
    case 'FX_Glitch2':
    case 'FX_Glitch3':
    case 'TV_Distorted':
    case 'Distortion_Dissipation':
    case 'VHS_Tracking':
      return one('Glitch', 1);
    case 'TV_VHS':
    case 'TV_VHS_Rewind':
    case 'Real_VHS':
    case 'TV_Vcr':
      return one('VHS', 1);
    case 'TV_Artefact':
    case 'TV_CompressionFX':
      return one('Compression', 1);
    case 'TV_Chromatical':
    case 'TV_Chromatical2':
      return one('Aberration', Math.max(0.3, v('Aberration', 50) / 100) * (p.has('fade') ? clamp01(v('Fade', 100) / 100) : 1));
    case 'Color_Chromatic_Aberration':
      return one('Aberration', 0.5);
    case 'Glitch_Mozaic':
      return one('Pixelate', Math.max(0.1, v('Intensity', 50) / 100));
    case 'Pixel_Pixelisation':
    case 'Pixelisation_OilPaintHQ':
      return one('Pixelate', 0.5);
    case 'Color_Noise':
    case 'Noise_TV':
    case 'TV_Noise':
      return one('Static', p.has('noise') ? Math.max(0.05, Math.min(0.6, Math.abs(v('Noise', 60)) / 100)) : 0.6);
    case 'Edge_Edge_filter':
      return one('EdgeBlackLine', 1);
    case 'TV_Old_Movie_2':
      // 색은 그대로, 필름 잡티만 (흑백으로 바꾸지 않는다)
      return one('Grain', 0.5);
    case 'TV_Vintage':
    case 'TV_Old_Movie':
      return one('FiftiesTV', 1);
    case 'Atmosphere_Rain_Pro':
    case 'Atmosphere_Rain':
      // Fade 0 = 안 보임
      return one('Rain', Math.max(0, (v('Intensity', 100) / 100) * clamp01(v('Fade', 100) / 100)));
    case 'Colors_HUE_Rotate':
    case 'Light_Rainbow2':
    case 'Light_Rainbow':
      return one('Funk', 1);
    case 'FX_EarthQuake':
      return one('Quake', Math.max(0.3, Math.min(3, (Math.abs(v('X', 5)) + Math.abs(v('Y', 5))) / 10)));
    case 'FX_Drunk2':
    case 'FX_Drunk':
      return one('Waves', 1);
    case 'Colors_Adjust_FullColors':
      // 채널별 배율만 (다른 채널 섞기·상수는 거의 안 씀)
      return {
        filters: [
          ['ChanR', v('Red_R', 10000) / 10000],
          ['ChanG', v('Green_G', 10000) / 10000],
          ['ChanB', v('Blue_B', 10000) / 10000],
        ],
      };
    case 'Distortion_BlackHole':
      return {
        filters: [
          ['HoleX', Math.max(0, Math.min(1, v('PositionX', 50) / 100))],
          ['HoleY', Math.max(0, Math.min(1, v('PositionY', 50) / 100))],
          ['HoleSize', Math.max(0.01, Math.min(1, v('Size', 30) / 100))],
          ['Hole', Math.max(0.1, Math.min(3, v('Distortion', 3000) / 10000))],
        ],
      };
    case 'FX_DarkMatter':
      return one('DarkMatter', Math.max(0.1, Math.min(2, (v('Intensity', 100) / 100) * (v('DarkIntensity', 100) / 100))));
    case 'Glow_Glow':
    case 'Glow_Glow_Color': {
      const col = adofaiColor(p.get('glowcolor'));
      return {
        filters: [],
        bloom: { intensity: Math.max(0.3, v('Intensity', 50) / 50), threshold: Math.max(0, Math.min(1, v('Threshold', 25) / 100)), ...(col ? { color: col } : {}) },
      };
    }
    default:
      return null;
  }
}

/** 반복 대상이 아닌 이벤트 (게임 진행을 바꾸는 것) */
const NO_REPEAT = new Set(['Twirl', 'SetSpeed', 'Pause', 'Hold', 'MultiPlanet', 'FreeRoam', 'AutoPlayTiles', 'Checkpoint', 'RepeatEvents', 'AddDecoration', 'AddText', 'AddObject', 'AddParticle']);
/** 반복 횟수 상한 (이벤트 하나당) */
const MAX_REPEATS = 2000;

/**
 * 원작 RepeatEvents를 펼친다: 같은 타일에서 태그가 겹치는 연출 이벤트를
 * Beat — interval 박마다 (angleOffset을 늘려서), Floor — floorCount 타일마다 repetitions 번 더 실행.
 * Floor 방식에서 executeOnCurrentFloor가 꺼져 있으면 원래 타일에서는 실행하지 않는다.
 */
export function expandRepeats(list: unknown[], last: number): unknown[] {
  const reps = new Map<number, Record<string, unknown>[]>();
  for (const ev of list) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as Record<string, unknown>;
    if (str(e.eventType) !== 'RepeatEvents' || e.active === false) continue;
    const f = Math.round(num(e.floor, -1));
    if (!reps.has(f)) reps.set(f, []);
    reps.get(f)!.push(e);
  }
  if (reps.size === 0) return list;
  const tagsOf = (v: unknown) => str(v).split(/\s+/).filter(Boolean);
  const out: unknown[] = [];
  for (const ev of list) {
    if (typeof ev !== 'object' || ev === null) {
      out.push(ev);
      continue;
    }
    const e = ev as Record<string, unknown>;
    const type = str(e.eventType);
    if (type === 'RepeatEvents') continue;
    const floor = Math.round(num(e.floor, -1));
    const rs = reps.get(floor);
    const tags = rs && !NO_REPEAT.has(type) ? tagsOf(e.eventTag) : [];
    const matched = tags.length ? rs!.filter((r) => tagsOf(r.tag).some((t) => tags.includes(t))) : [];
    if (matched.length === 0) {
      out.push(e);
      continue;
    }
    let keepOriginal = true;
    for (const r of matched) {
      const n = Math.max(0, Math.min(MAX_REPEATS, Math.round(num(r.repetitions, 1))));
      if (str(r.repeatType) === 'Floor') {
        const step = Math.max(1, Math.round(num(r.floorCount, 1)));
        if (r.executeOnCurrentFloor === false) keepOriginal = false;
        for (let k = 1; k <= n && floor + k * step <= last; k++) out.push({ ...e, floor: floor + k * step });
      } else {
        const iv = Math.max(0, num(r.interval, 1));
        const a0 = num(e.angleOffset, 0);
        for (let k = 1; k <= n; k++) out.push({ ...e, angleOffset: a0 + k * iv * 180 });
      }
    }
    if (keepOriginal) out.push(e);
  }
  return out;
}

export function convertAdofai(text: string): AdofaiResult {
  let raw: unknown;
  try {
    raw = parseLenientJson(text);
  } catch (e) {
    throw new Error(`.adofai 파일을 읽을 수 없습니다: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('.adofai 파일 형식이 아닙니다.');
  const r = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const angles = readAngles(r, warnings);
  if (angles.length === 0) throw new Error('.adofai 파일에 타일(angleData / pathData)이 없습니다.');

  // ── 타일: 미드스핀(999)은 '이전 방향의 반대 + Midspin 이벤트'로
  const path: number[] = [];
  const midspins: number[] = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    if (a === MIDSPIN) {
      if (i === 0 || i === angles.length - 1) {
        warnings.push(`${i === 0 ? '첫' : '마지막'} 타일의 미드스핀은 옮길 수 없어 곧은 길로 바꿨습니다.`);
        path.push(i === 0 ? 0 : path[i - 1]);
        continue;
      }
      path.push((path[i - 1] + 180) % 360);
      midspins.push(i);
    } else path.push(((a % 360) + 360) % 360);
  }
  const last = path.length; // 도착 타일 번호

  // ── 설정
  const s = (typeof r.settings === 'object' && r.settings !== null ? r.settings : {}) as Record<string, unknown>;
  const settings = defaultSettings();
  settings.bpm = Math.max(0.001, Math.min(MAX_BPM, num(s.bpm, 100)));
  // 원작 offset = 첫 타일(floor 1)을 누르는 순간. ORBIT offset = 타일 0 시각 → 아래에서 첫 회전만큼 당긴다.
  const firstHit = num(s.offset, 0) / 1000;
  settings.offset = firstHit;
  settings.pitch = Math.max(0.25, Math.min(4, num(s.pitch, 100) / 100));
  settings.volume = Math.max(0, Math.min(1, num(s.volume, 100) / 100));
  settings.countdownTicks = Math.max(0, Math.min(16, Math.round(num(s.countdownTicks, 4))));
  settings.trackColor = adofaiColor(s.trackColor) ?? '#debb7b';
  settings.bgColor = adofaiColor(s.backgroundColor) ?? '#000000';
  settings.startDirection = 'CW';
  const songFile = str(s.songFilename).split(/[\\/]/).pop() ?? '';
  settings.songFile = songFile;

  const meta = defaultMeta();
  meta.title = stripRichText(str(s.song)) || '가져온 레벨';
  meta.artist = stripRichText(str(s.artist)) || '알 수 없음';
  const author = stripRichText(str(s.author));
  meta.author = author ? `원작 맵: ${author}` : '원작 맵 (얼음과 불의 춤)';
  meta.difficulty = Math.max(1, Math.min(10, Math.round(num(s.difficulty, 5))));
  meta.previewStart = Math.max(0, num(s.previewSongStart, 0));
  meta.origin = 'adofai';

  // ── 이벤트
  const actions: Action[] = midspins.map((floor) => ({ floor, type: 'Midspin' as const }));
  const midSet = new Set(midspins);
  const skipped = new Map<string, number>();
  const approx = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  /** PositionTrack: 해당 타일부터 뒤로 계속 밀리는 정적 위치 (타일 단위). */
  const shift: { floor: number; x: number; y: number }[] = [];
  /** 마지막 MoveCamera 기준 (원작은 비워 두면 이어 쓴다) */
  let camRel = 'Player';

  const decorations: Decoration[] = [];
  const filterSet = new Set(FILTER_NAMES);
  const colorTracks: { floor: number; look: NonNullable<ReturnType<typeof trackLook>> }[] = [];
  const thisTileLooks: { floor: number; look: NonNullable<ReturnType<typeof trackLook>> }[] = [];

  // ── 레벨 설정에 들어 있는 시작 상태 (원작은 설정에 첫 카메라·트랙 모양·배경·타일 애니메이션을 둔다)
  const startLook = trackLook({ trackColor: s.trackColor ?? 'debb7b', trackStyle: s.trackStyle ?? 'Standard', ...s });
  if (startLook) colorTracks.push({ floor: 0, look: startLook });
  if (s.relativeTo !== undefined || s.zoom !== undefined || s.position !== undefined || s.rotation !== undefined) {
    const cam: Action = { floor: 0, type: 'Camera', duration: 0 };
    const rel = str(s.relativeTo);
    cam.relativeTo = rel === 'Tile' ? 'tile' : rel === 'Global' ? 'global' : 'player';
    if (rel === 'Tile') cam.tile = 0;
    if (Array.isArray(s.position)) cam.offset = [num(s.position[0], 0) * TILE_LEN, num(s.position[1], 0) * TILE_LEN];
    if (s.rotation !== undefined) cam.rotation = num(s.rotation, 0);
    if (s.zoom !== undefined) cam.zoom = Math.max(0.05, Math.min(20, 100 / Math.max(1, num(s.zoom, 100))));
    actions.push(cam);
  }
  if (s.trackAnimation !== undefined || s.trackDisappearAnimation !== undefined) {
    actions.push({
      floor: 0,
      type: 'TrackAnim',
      appear: APPEAR_MAP[str(s.trackAnimation)] ?? 'none',
      beatsAhead: Math.max(0, num(s.beatsAhead, 3)),
      disappear: DISAPPEAR_MAP[str(s.trackDisappearAnimation)] ?? 'none',
      beatsBehind: Math.max(0, num(s.beatsBehind, 4)),
    });
  }
  {
    const img = str(s.bgImage).split(/[\\/]/).pop() ?? '';
    const mode = str(s.bgDisplayMode);
    const tint = adofaiColor(s.bgImageColor);
    actions.push({
      floor: 0,
      type: 'Background',
      color: settings.bgColor,
      image: img,
      // 배경 동영상 (원작 vidOffset: 곡 시작 후 몇 ms 뒤에 동영상 시작)
      ...(str(s.bgVideo).trim()
        ? { video: str(s.bgVideo).split(/[\\/]/).pop()!, videoOffset: num(s.vidOffset, 0) / 1000, videoLoop: str(s.loopVideo) === 'Enabled' || s.loopVideo === true }
        : {}),
      ...(img ? { fit: mode === 'Unscaled' ? 'unscaled' : mode === 'Tiled' ? 'tile' : 'cover', opacity: 1, ...(tint && tint !== '#ffffff' ? { tint } : {}) } : {}),
    } as Action);
  }
  // 타격음 (원작 기본 Kick)
  if (s.hitsound !== undefined || s.hitsoundVolume !== undefined)
    actions.push({ floor: 0, type: 'Sound', hitsound: str(s.hitsound) || 'Kick', hitVolume: Math.max(0, Math.min(10, num(s.hitsoundVolume, 100) / 100)) });
  // 장식은 새 버전은 "decorations" 배열, 옛 버전은 actions 안의 AddDecoration/AddText
  const list = expandRepeats([...(Array.isArray(r.actions) ? r.actions : []), ...(Array.isArray(r.decorations) ? r.decorations : [])], last);
  // 원작 대회 규칙: '죽는 히트박스' 장식(hitbox Kill)을 움직이는 태그 이벤트 = 그 판정이 나오면 실패
  const killDeco = new Set<string>();
  for (const ev of list) {
    const e = ev as Record<string, unknown>;
    if (e && str(e.eventType) === 'AddDecoration' && str(e.hitbox) === 'Kill') for (const t of str(e.tag).split(/\s+/)) if (t) killDeco.add(t);
  }
  const deadlyTags = new Set<string>();
  if (killDeco.size)
    for (const ev of list) {
      const e = ev as Record<string, unknown>;
      if (!e || str(e.eventType) !== 'MoveDecorations' || !str(e.eventTag)) continue;
      if (str(e.tag).split(/\s+/).some((t) => killDeco.has(t))) for (const t of str(e.eventTag).split(/\s+/)) if (t) deadlyTags.add(t);
    }
  for (const ev of list) {
    if (typeof ev !== 'object' || ev === null) continue;
    const e = ev as Record<string, unknown>;
    const type = str(e.eventType);
    const floor = Math.round(num(e.floor, type === 'AddDecoration' || type === 'AddText' ? 0 : -1));
    if (floor < 0 || floor > last) continue;
    if (e.active === false) continue;
    // 원작 angleOffset: 타일을 친 뒤 그 각도만큼 돈 다음 (180° = 1박)
    const delay = Math.max(0, num(e.angleOffset, 0)) / 180;
    const vis = (a: Action) => {
      if (delay > 0) a.delay = Math.min(MAX_EFFECT_BEATS, delay);
      actions.push(a);
    };
    switch (type) {
      case 'Twirl':
        actions.push({ floor, type: 'Twirl' });
        break;
      case 'SetSpeed': {
        if (num(e.angleOffset, 0) !== 0) bump(approx, 'SetSpeed(각도 지연)');
        if (str(e.speedType) === 'Multiplier') {
          const m = num(e.bpmMultiplier, 1);
          if (m > 0 && m <= MAX_MULTIPLIER) actions.push({ floor, type: 'SetSpeed', multiplier: m });
          else bump(approx, 'SetSpeed(범위 밖 배율)');
        } else {
          const b = num(e.beatsPerMinute, settings.bpm);
          if (b > 0 && b <= MAX_BPM) actions.push({ floor, type: 'SetSpeed', bpm: b });
          else bump(approx, 'SetSpeed(범위 밖 BPM)');
        }
        break;
      }
      case 'Pause': {
        const b = num(e.duration, 0);
        if (b > 0 && floor < last && !midSet.has(floor)) actions.push({ floor, type: 'Pause', beats: Math.min(MAX_EXTRA_BEATS, b) });
        break;
      }
      case 'Hold': {
        // 원작 Hold의 duration = 추가로 도는 바퀴 수 (1바퀴 = 2박)
        const laps = num(e.duration, 0);
        if (laps > 0 && floor < last && !midSet.has(floor)) actions.push({ floor, type: 'Hold', beats: Math.min(MAX_EXTRA_BEATS, laps * 2) });
        else bump(approx, 'Hold(추가 바퀴 0)');
        break;
      }
      case 'Checkpoint':
        actions.push({ floor, type: 'Checkpoint' });
        break;
      case 'ColorTrack': {
        // 원작 ColorTrack은 시간 이벤트가 아니라 '이 타일부터 트랙 모양' — 아래에서 구간별로 처음부터 적용
        const look = trackLook(e);
        // justThisTile: 이 타일만 (뒤 타일은 앞 모양 그대로)
        if (look && onOff(e.justThisTile)) thisTileLooks.push({ floor, look });
        else if (look) colorTracks.push({ floor, look });
        break;
      }
      case 'RecolorTrack': {
        const look = trackLook(e);
        if (!look) break;
        const a = tileRef(e.startTile, floor, last);
        const b = tileRef(e.endTile, floor, last);
        const gap = Math.max(0, Math.round(num(e.gapLength, 0)));
        vis({ floor, type: 'RecolorTrack', from: Math.min(a, b), to: Math.max(a, b), ...look, ...(gap ? { gap } : {}), duration: dur(e.duration, 0) });
        break;
      }
      case 'MoveCamera': {
        const cam: Action = { floor, type: 'Camera', duration: dur(e.duration, 1) };
        if (e.zoom !== undefined && e.zoom !== null) cam.zoom = Math.max(0.05, Math.min(20, 100 / Math.max(1, num(e.zoom, 100))));
        if (e.rotation !== undefined && e.rotation !== null) cam.rotation = num(e.rotation, 0);
        if (Array.isArray(e.position) && e.position.some((v) => v !== null)) cam.offset = [num(e.position[0], 0) * TILE_LEN, num(e.position[1], 0) * TILE_LEN];
        const ease = mapEase(e.ease);
        if (ease) cam.ease = ease;
        // 기준을 비워 두면 앞의 기준을 이어 쓴다 — 타일 기준이면 이 이벤트의 타일 (원작)
        const rel = e.relativeTo === undefined || e.relativeTo === null ? (cam.offset && camRel === 'Tile' ? 'Tile' : '') : str(e.relativeTo);
        if (e.relativeTo !== undefined && e.relativeTo !== null) camRel = rel;
        if (rel === 'Player') cam.relativeTo = 'player';
        else if (rel === 'Tile') {
          cam.relativeTo = 'tile';
          cam.tile = floor;
        } else if (rel === 'Global') cam.relativeTo = 'global';
        else if (rel.startsWith('LastPosition')) cam.relativeTo = 'last';
        vis(cam);
        break;
      }
      case 'Flash': {
        // 원작: 시작 → 끝 상태로 바뀌고, 끝 상태가 그대로 남는다
        const color = adofaiColor(e.startColor) ?? '#ffffff';
        const endColor = adofaiColor(e.endColor) ?? color;
        const pct = (v: unknown, d: number) => Math.max(0, Math.min(1, num(v, d) / 100));
        vis({
          floor,
          type: 'Flash',
          color,
          opacity: pct(e.startOpacity, 100),
          endColor,
          endOpacity: pct(e.endOpacity, 0),
          ...(str(e.plane) === 'Background' ? { plane: 'bg' as const } : {}),
          duration: dur(e.duration, 1),
        });
        break;
      }
      case 'MoveTrack': {
        const a = tileRef(e.startTile, floor, last);
        const b = tileRef(e.endTile, floor, last);
        const mgap = Math.max(0, Math.round(num(e.gapLength, 0)));
        const mv: Action = { floor, type: 'MoveTrack', from: Math.min(a, b), to: Math.max(a, b), ...(mgap ? { gap: mgap } : {}), duration: dur(e.duration, 1) };
        // 비어 있는(null) 축은 그대로
        if (Array.isArray(e.positionOffset) && e.positionOffset.some((v) => v !== null)) {
          const ax = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v) * TILE_LEN);
          mv.offset = [ax(e.positionOffset[0]), ax(e.positionOffset[1])];
        }
        if (e.rotationOffset !== undefined && e.rotationOffset !== null) mv.rotation = num(e.rotationOffset, 0);
        if (e.opacity !== undefined && e.opacity !== null) mv.opacity = Math.max(0, Math.min(1, num(e.opacity, 100) / 100));
        // 가로·세로 크기가 따로면 작은 쪽으로 (한쪽이 0이면 납작해져 안 보이는 것과 비슷하게)
        const scs = Array.isArray(e.scale) ? e.scale.filter((v) => v !== null && Number.isFinite(Number(v))).map(Number) : [];
        const sc = Array.isArray(e.scale) ? (scs.length ? Math.min(...scs) : undefined) : e.scale;
        if (sc !== undefined && sc !== null) mv.scale = Math.max(0, Math.min(100, num(sc, 100) / 100));
        const ease = mapEase(e.ease);
        if (ease) mv.ease = ease;
        vis(mv);
        break;
      }
      case 'PositionTrack': {
        if (onOff(e.editorOnly)) break;
        const p = Array.isArray(e.positionOffset) ? e.positionOffset : [0, 0];
        const x = num(p[0], 0);
        const y = num(p[1], 0);
        if (x || y) shift.push({ floor, x, y });
        break;
      }
      case 'CustomBackground': {
        const c = adofaiColor(e.color);
        const img = str(e.bgImage).split(/[\\/]/).pop() ?? '';
        const mode = str(e.bgDisplayMode);
        const fit = mode === 'Unscaled' ? 'unscaled' : mode === 'Tiled' ? 'tile' : 'cover';
        const tint = adofaiColor(e.imageColor);
        vis({
          floor,
          type: 'Background',
          ...(c ? { color: c } : {}),
          image: img,
          ...(img ? { fit, opacity: 1, ...(tint && tint !== '#ffffff' ? { tint } : {}) } : {}),
        });
        break;
      }
      case 'SetFilter': {
        const name = str(e.filter);
        if (!name) break;
        if (!filterSet.has(name)) bump(skipped, `필터 ${name}`);
        const on = onOff(e.enabled);
        const fe = mapEase(e.ease);
        const raw = num(e.intensity, 100);
        // 음수 대비 = 흐리게 (원작은 음수도 받는다)
        const neg = name === 'Contrast' && raw < 0;
        vis({
          floor,
          type: 'Filter',
          filter: neg ? 'ContrastAdj' : name,
          enabled: on,
          intensity: neg ? Math.max(0, 1 + raw / 400) : Math.max(0, Math.min(100, raw / 100)),
          ...(onOff(e.disableOthers) ? { exclusive: true } : {}),
          ...(num(e.duration, 0) > 0 ? { duration: dur(e.duration, 0) } : {}),
          ...(fe ? { ease: fe } : {}),
        });
        break;
      }
      case 'SetFilterAdvanced': {
        // 원작 확장 필터(CameraFilterPack)를 비슷한 ORBIT 필터로 옮긴다
        const props = parseFilterProps(e.filterProperties);
        const on = onOff(e.enabled);
        const conv = advancedFilter(str(e.filter), props);
        // 끄기만 하는 이벤트는 (없는 필터라도) 할 일이 없다
        if (!conv && !on) break;
        if (!conv) {
          bump(skipped, `확장 필터 ${str(e.filter).replace(/^CameraFilterPack_/, '')}`);
          break;
        }
        const fe = mapEase(e.ease);
        const d = {
          ...(num(e.duration, 0) > 0 ? { duration: dur(e.duration, 0) } : {}),
          ...(fe ? { ease: fe } : {}),
          ...(str(e.plane) === 'Background' ? { plane: 'back' as const } : {}),
        };
        if (conv.bloom) {
          vis({ floor, type: 'Bloom', enabled: on, ...conv.bloom });
          break;
        }
        for (const [name, v] of conv.filters) {
          vis({
            floor,
            type: 'Filter',
            filter: name,
            enabled: on,
            intensity: Math.max(0, Math.min(100, v)),
            ...(onOff(e.disableOthers) ? { exclusive: true } : {}),
            ...d,
          });
        }
        break;
      }
      case 'Bloom':
        vis({
          floor,
          type: 'Bloom',
          enabled: onOff(e.enabled),
          intensity: Math.max(0, Math.min(100, num(e.intensity, 100) / 100)),
          threshold: Math.max(0, Math.min(1, num(e.threshold, 50) / 100)),
          ...(adofaiColor(e.color) ? { color: adofaiColor(e.color)! } : {}),
        });
        break;
      case 'ShakeScreen':
        vis({
          floor,
          type: 'Shake',
          duration: dur(e.duration, 1),
          strength: Math.max(0, Math.min(100, num(e.strength, 100) / 100)),
          frequency: Math.max(0, Math.min(1000, (num(e.intensity, 100) / 100) * 15)),
          fadeOut: e.fadeOut === undefined ? true : onOff(e.fadeOut),
        });
        break;
      case 'AnimateTrack': {
        const ap = APPEAR_MAP;
        const dp = DISAPPEAR_MAP;
        const a: Action = { floor, type: 'TrackAnim' };
        if (e.trackAnimation !== undefined) a.appear = ap[str(e.trackAnimation)] ?? 'fade';
        // 박 수는 그 애니메이션을 함께 바꿀 때만 (원작 에디터는 꺼 둔 칸에도 기본값 3·4를 적어 둔다 —
        // 사라지기만 바꾸는 이벤트의 'beatsAhead: 3'까지 쓰면 앞 타일이 바로 앞 것만 보였다, Phantigma)
        if (e.beatsAhead !== undefined && e.trackAnimation !== undefined) a.beatsAhead = Math.max(0, Math.min(MAX_EFFECT_BEATS, num(e.beatsAhead, 3)));
        if (e.trackDisappearAnimation !== undefined) a.disappear = dp[str(e.trackDisappearAnimation)] ?? 'fade';
        if (e.beatsBehind !== undefined && e.trackDisappearAnimation !== undefined) a.beatsBehind = Math.max(0, Math.min(MAX_EFFECT_BEATS, num(e.beatsBehind, 4)));
        actions.push(a);
        break;
      }
      case 'AddDecoration':
      case 'AddText': {
        const d = decoFrom(e, floor, type === 'AddText');
        if (d) decorations.push(d);
        break;
      }
      case 'AddParticle': {
        const d = decoFrom(e, floor, false);
        if (d) {
          delete d.scale; // 원작 입자의 scale은 방출 영역 크기
          d.particle = particleFrom(e);
          decorations.push(d);
        }
        break;
      }
      case 'AddObject': {
        const d = objectFrom(e, floor);
        if (d) decorations.push(d);
        break;
      }
      case 'SetParticle':
      case 'EmitParticle': {
        const tag = str(e.tag).trim();
        if (!tag) break;
        if (type === 'EmitParticle') {
          vis({ floor, type: 'MoveDecorations', tag, emit: Math.max(1, Math.min(100000, Math.round(num(e.count, 10)))), duration: 0 });
          break;
        }
        const mode = str(e.targetMode);
        const particle = mode === 'Start' ? 'start' : mode === 'Stop' ? 'stop' : mode === 'Clear' ? 'clear' : null;
        if (particle) vis({ floor, type: 'MoveDecorations', tag, particle, duration: 0 });
        else bump(approx, 'SetParticle(속성 바꾸기)');
        break;
      }
      case 'SetObject': {
        const tag = str(e.tag).trim();
        if (!tag) break;
        const key = e.planetColor !== undefined ? e.planetColor : e.trackColor;
        const c = adofaiColor(key);
        if (!c) break;
        const a: Action = { floor, type: 'MoveDecorations', tag, color: c, duration: dur(e.duration, 0) };
        if (e.planetColor !== undefined) a.opacity = adofaiAlpha(e.planetColor);
        const ease = mapEase(e.ease);
        if (ease) a.ease = ease;
        vis(a);
        break;
      }
      case 'SetText': {
        const tag = str(e.tag).trim();
        if (tag) vis({ floor, type: 'MoveDecorations', tag, text: richToPlain(str(e.decText)), duration: 0 });
        break;
      }
      case 'ScalePlanets': {
        const a: Action = { floor, type: 'Planets', size: Math.max(0, Math.min(100, num(e.scale, 100) / 100)), duration: dur(e.duration, 0) };
        const ease = mapEase(e.ease);
        if (ease) a.ease = ease;
        if (str(e.targetPlanet) && str(e.targetPlanet) !== 'All') bump(approx, 'ScalePlanets(행성 하나만)');
        vis(a);
        break;
      }
      case 'ScaleRadius':
        vis({ floor, type: 'Planets', radius: Math.max(0, Math.min(100, num(e.scale, 100) / 100)), duration: 0 });
        break;
      case 'HallOfMirrors':
        vis({ floor, type: 'Screen', mirrors: onOff(e.enabled) });
        break;
      case 'ScreenTile': {
        const t = Array.isArray(e.tile) ? e.tile : [1, 1];
        const a: Action = { floor, type: 'Screen', tile: [num(t[0], 1), num(t[1], 1)], duration: dur(e.duration, 0) };
        const ease = mapEase(e.ease);
        if (ease) a.ease = ease;
        vis(a);
        break;
      }
      case 'ScreenScroll': {
        // 원작 속도 단위는 확실하지 않아 1000 = 초당 화면 한 개로 본다
        const sc = Array.isArray(e.scroll) ? e.scroll : [0, 0];
        vis({ floor, type: 'Screen', scroll: [num(sc[0], 0) / 1000, -num(sc[1], 0) / 1000] });
        break;
      }
      case 'SetFrameRate':
        vis({ floor, type: 'Screen', fps: onOff(e.enabled) ? Math.max(1, Math.min(1000, num(e.frameRate, 60))) : 0 });
        break;
      case 'SetHitsound':
        if (str(e.gameSound || 'Hitsound') !== 'Hitsound') {
          bump(approx, 'SetHitsound(게임 소리)');
          break;
        }
        actions.push({ floor, type: 'Sound', hitsound: str(e.hitsound) || 'Kick', hitVolume: Math.max(0, Math.min(10, num(e.hitsoundVolume, 100) / 100)) });
        break;
      case 'PlaySound':
        vis({ floor, type: 'Sound', play: str(e.hitsound) || 'Kick', volume: Math.max(0, Math.min(10, num(e.hitsoundVolume, 100) / 100)) });
        break;
      case 'SetConditionalEvents': {
        if (!deadlyTags.size) {
          bump(skipped, type);
          break;
        }
        const map: [string, JudgeRuleAction['fail'][number]][] = [
          ['tooEarlyTag', 'tooEarly'],
          ['veryEarlyTag', 'early'],
          ['veryLateTag', 'late'],
          ['earlyPerfectTag', 'earlyPerfect'],
          ['latePerfectTag', 'latePerfect'],
        ];
        const fail = map.filter(([k]) => str(e[k]).split(/\s+/).some((t) => deadlyTags.has(t))).map(([, j]) => j);
        actions.push({ floor, type: 'JudgeRule', fail });
        break;
      }
      // 편집기 전용·판정 문구·여백 등 화면에 영향이 없는 이벤트는 조용히 넘긴다
      case 'Bookmark':
      case 'EditorComment':
      case 'SetDefaultText':
      case 'ScaleMargin':
      case 'Hide':
        break;
      case 'MoveDecorations': {
        const tag = str(e.tag).trim();
        if (!tag) break;
        // 실패 규칙의 방아쇠 이벤트 (조건이 맞을 때만 실행) — 판정 규칙으로 옮겼다
        if (str(e.eventTag).split(/\s+/).some((t) => deadlyTags.has(t))) break;
        const a: Action = { floor, type: 'MoveDecorations', tag, duration: dur(e.duration, 1) };
        // 원작은 비어 있는(null) 축을 그대로 둔다
        const axes = (v: unknown, k: number): [number | null, number | null] | undefined => {
          if (!Array.isArray(v)) return v === undefined || v === null ? undefined : [num(v, 0) * k, num(v, 0) * k];
          const f = (x: unknown) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x) * k);
          const r: [number | null, number | null] = [f(v[0]), f(v[1])];
          return r[0] === null && r[1] === null ? undefined : r;
        };
        const off = axes(e.positionOffset, TILE_LEN);
        if (off) a.offset = off;
        if (e.rotationOffset !== undefined && e.rotationOffset !== null) a.rotation = num(e.rotationOffset, 0);
        // 크기는 원작처럼 절대값 (100 = 그림 원래 크기)
        const sc = axes(e.scale, 1 / 100);
        if (sc) a.scale = sc;
        const par = axes(e.parallax, 1 / 100);
        if (par) a.parallax = par;
        const po = axes(e.parallaxOffset, TILE_LEN);
        if (po) a.parallaxOffset = po;
        const c = adofaiColor(e.color);
        if (c) {
          a.color = c;
          a.alpha = adofaiAlpha(e.color);
        }
        if (e.opacity !== undefined && e.opacity !== null) a.opacity = Math.max(0, Math.min(1, num(e.opacity, 100) / 100));
        if (e.visible !== undefined) a.visible = onOff(e.visible);
        if (str(e.decorationImage)) a.image = str(e.decorationImage).split(/[\\/]/).pop();
        const mk = maskFrom(e.maskingType);
        if (mk) a.mask = mk;
        if (e.depth !== undefined && e.depth !== null && Number.isFinite(Number(e.depth))) a.depth = Number(e.depth);
        const ease = mapEase(e.ease);
        if (ease) a.ease = ease;
        vis(a);
        break;
      }
      case 'MultiPlanet': {
        const pl = str(e.planets);
        if (pl === 'ThreePlanets' || pl === 'TwoPlanets') actions.push({ floor, type: 'MultiPlanet', planets: pl === 'ThreePlanets' ? 3 : 2 });
        else bump(approx, type);
        break;
      }
      case 'FreeRoam':
      case 'FreeRoamTwirl':
      case 'FreeRoamRemove':
      case 'SetPlanetRotation':
        bump(approx, type);
        break;
      default:
        bump(skipped, type || '(이름 없음)');
    }
  }

  // ColorTrack (+ 설정의 시작 모양) → 구간마다 레벨 시작부터 적용되는 RecolorTrack
  // 이 타일만 바꾸는 모양은 구간 모양보다 뒤에 적용되게 먼저 앞에 넣는다 (아래 구간들이 그 앞에 들어감)
  for (const t of thisTileLooks) actions.unshift({ floor: 0, type: 'RecolorTrack', from: t.floor, to: t.floor, ...t.look, duration: 0 });
  colorTracks.sort((a, b) => a.floor - b.floor);
  colorTracks.forEach((ct, j) => {
    const to = j + 1 < colorTracks.length ? colorTracks[j + 1].floor - 1 : last;
    if (to >= ct.floor) actions.unshift({ floor: 0, type: 'RecolorTrack', from: ct.floor, to, ...ct.look, duration: 0 });
  });
  if (startLook) settings.trackColor = startLook.color;

  // PositionTrack → 타일마다 누적 위치를 구해, 같은 위치가 이어지는 구간마다 즉시 적용되는 MoveTrack (첫 타일에서)
  if (shift.length) {
    const ox = new Float64Array(last + 1);
    const oy = new Float64Array(last + 1);
    for (const sh of shift)
      for (let f = sh.floor; f <= last; f++) {
        ox[f] += sh.x;
        oy[f] += sh.y;
      }
    let from = 0;
    for (let f = 1; f <= last + 1; f++) {
      if (f <= last && ox[f] === ox[from] && oy[f] === oy[from]) continue;
      if (ox[from] || oy[from]) actions.push({ floor: 0, type: 'MoveTrack', from, to: f - 1, offset: [ox[from] * TILE_LEN, oy[from] * TILE_LEN], duration: 0 });
      from = f;
    }
  }

  actions.sort((a, b) => a.floor - b.floor);

  const ignoredDecor = 0;
  if (approx.size)
    warnings.push(
      `원작과 다르게 동작할 수 있는 이벤트: ${[...approx].map(([k, n]) => `${k} ${n}개`).join(', ')}. ` +
        (approx.has('MultiPlanet') || approx.has('FreeRoam') ? '행성 4개 이상·자유 이동 구간은 박이 원작과 다릅니다.' : ''),
    );
  if (skipped.size || ignoredDecor)
    warnings.push(
      `ORBIT에 없는 연출은 뺐습니다: ${[...skipped].map(([k, n]) => `${k} ${n}개`).join(', ')}${ignoredDecor ? `${skipped.size ? ', ' : ''}장식 ${ignoredDecor}개` : ''}.`,
    );

  let level: LevelData = { version: 1, meta, settings, path, actions, ...(decorations.length ? { decorations } : {}) };
  // 안전망: 그래도 검증을 못 넘는 이벤트가 있으면 그 이벤트만 빼고 알린다 (레벨 전체를 거부하지 않게)
  for (let pass = 0; pass < 3; pass++) {
    const v = validateLevel(level);
    if (v.ok) break;
    const bad = new Set<number>();
    for (const err of v.errors) {
      const m = /^actions\[(\d+)\]/.exec(err);
      if (m) bad.add(Number(m[1]));
    }
    if (!bad.size) throw new Error(`변환한 레벨이 올바르지 않습니다: ${v.errors.slice(0, 3).join(' / ')}`);
    warnings.push(`옮길 수 없는 이벤트 ${bad.size}개를 뺐습니다 (예: ${v.errors[0]}).`);
    level = { ...level, actions: level.actions.filter((_, i) => !bad.has(i)) };
  }
  // 첫 회전(타일 0 → 1) 시간만큼 앞당겨, 타일 1이 원작 offset 시각에 오게 한다
  const first = compileChart(level).tiles[0].duration;
  settings.offset = Math.max(-60, Math.min(3600, Math.round((firstHit - first) * 10000) / 10000));
  return { level, songFile, warnings };
}

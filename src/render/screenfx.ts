import { KawaseBlurFilter } from 'pixi-filters/kawase-blur';
import {
  BlurFilter,
  ColorMatrixFilter,
  Container,
  Filter,
  GlProgram,
  Graphics,
  NoiseFilter,
  Texture,
  TexturePool,
  UniformGroup,
  type ColorMatrix,
  type FilterSystem,
  type RenderSurface,
} from 'pixi.js';
import type { BloomState, FilterState } from '../core/timeline';

/**
 * 화면 필터 (원작 SetFilter·Bloom 근사). 무대 전체(배경·월드·플래시)에 걸린다.
 * - 색: 흑백·세피아·반전·대비·야간 투시·네온·펑크 … → 색 행렬 하나로 합침
 * - 흐림: 블러 계열 → BlurFilter
 * - 잡음: Grain·Static·VHS … → NoiseFilter
 * - 화면 왜곡: 픽셀화·색 번짐(Aberration)·주사선·어안·포스터화 → 셰이더 하나
 * - 날씨: Rain·Blizzard·PixelSnow → 입자 오버레이
 * 세기는 0 = 없음, 1 = 원작 100%.
 */

type Mat = number[]; // 4×5 색 행렬 (20개)

const ID: Mat = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

/** 두 색 행렬 합성 (a 다음 b). */
function mul(a: Mat, b: Mat): Mat {
  const r = new Array<number>(20);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 5; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += b[i * 5 + k] * a[k * 5 + j];
      if (j === 4) v += b[i * 5 + 4];
      r[i * 5 + j] = v;
    }
  }
  return r;
}
/** 항등 행렬과 섞기 (세기 k). */
function mix(m: Mat, k: number): Mat {
  return m.map((v, i) => ID[i] + (v - ID[i]) * k);
}
const GRAY: Mat = [0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0.3, 0.59, 0.11, 0, 0, 0, 0, 0, 1, 0];
const SEPIA: Mat = [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
const INVERT: Mat = [-1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0];
const NIGHT: Mat = [0.1, 0.4, 0, 0, 0, 0.3, 1, 0.3, 0, 0.05, 0, 0.4, 0.1, 0, 0, 0, 0, 0, 1, 0];
function contrast(c: number): Mat {
  const o = 0.5 * (1 - c);
  return [c, 0, 0, 0, o, 0, c, 0, 0, o, 0, 0, c, 0, o, 0, 0, 0, 1, 0];
}
function saturation(s: number): Mat {
  const r = (1 - s) * 0.3;
  const g = (1 - s) * 0.59;
  const b = (1 - s) * 0.11;
  return [r + s, g, b, 0, 0, r, g + s, b, 0, 0, r, g, b + s, 0, 0, 0, 0, 0, 1, 0];
}
function brightness(k: number, tint: number, amt: number): Mat {
  const tr = ((tint >> 16) & 255) / 255;
  const tg = ((tint >> 8) & 255) / 255;
  const tb = (tint & 255) / 255;
  return [k, 0, 0, 0, tr * amt, 0, k, 0, 0, tg * amt, 0, 0, k, 0, tb * amt, 0, 0, 0, 1, 0];
}
function hue(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const lr = 0.213;
  const lg = 0.715;
  const lb = 0.072;
  return [
    lr + c * (1 - lr) + s * -lr, lg + c * -lg + s * -lg, lb + c * -lb + s * (1 - lb), 0, 0,
    lr + c * -lr + s * 0.143, lg + c * (1 - lg) + s * 0.14, lb + c * -lb + s * -0.283, 0, 0,
    lr + c * -lr + s * -(1 - lr), lg + c * -lg + s * lg, lb + c * (1 - lb) + s * lb, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

const FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uInputClamp;
uniform float uPixel;
uniform float uAberr;
uniform float uScan;
uniform float uFish;
uniform float uPoster;
uniform float uTime;
uniform float uVig;
uniform float uBloom;
uniform float uBloomThr;
uniform vec3 uBloomCol;

vec2 toTex(vec2 s) { return s * uOutputFrame.zw * uInputSize.zw; }
vec4 samp(vec2 s) { return texture(uTexture, clamp(toTex(s), uInputClamp.xy, uInputClamp.zw)); }

void main() {
  vec2 s = vTextureCoord * uInputSize.xy / uOutputFrame.zw; // 화면 0~1
  vec2 s0 = s;
  if (uFish > 0.0) {
    vec2 d = s - 0.5;
    float r2 = dot(d, d);
    s = 0.5 + d * (1.0 - uFish * 0.9 * (0.5 - r2));
  }
  if (uPixel > 1.0) {
    vec2 px = uOutputFrame.zw;
    s = (floor(s * px / uPixel) + 0.5) * uPixel / px;
  }
  vec4 c;
  if (uAberr > 0.0) {
    vec2 o = vec2(uAberr / uOutputFrame.z, 0.0);
    vec4 m = samp(s);
    c = vec4(samp(s + o).r, m.g, samp(s - o).b, m.a);
  } else {
    c = samp(s);
  }
  // 빛 번짐: 주변의 밝은 부분을 모아 더한다 (원작 Bloom 근사)
  if (uBloom > 0.0) {
    vec3 acc = vec3(0.0);
    vec2 px = 1.0 / uOutputFrame.zw;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      vec2 dir = vec2(cos(a), sin(a));
      for (int j = 1; j <= 3; j++) {
        float r = float(j * j) * 7.0;
        vec3 b = samp(s + dir * r * px).rgb;
        acc += max(b - vec3(uBloomThr), 0.0) / float(j);
      }
    }
    c.rgb += acc * (uBloom / 8.0) * uBloomCol;
  }
  if (uPoster > 1.0) c.rgb = floor(c.rgb * uPoster + 0.5) / uPoster;
  if (uScan > 0.0) {
    float line = 0.5 + 0.5 * sin(s.y * uOutputFrame.w * 1.6 + uTime * 6.0);
    c.rgb *= 1.0 - uScan * 0.35 * line;
  }
  // 옛 TV(원작 Arcade·Fisheye): 둥근 모서리 쪽이 어두워지고, 휘어진 화면 밖은 검게
  if (uVig > 0.0) {
    vec2 d = abs(s0 - 0.5) * 2.0;
    float edge = pow(d.x, 6.0) + pow(d.y, 6.0);
    c.rgb *= 1.0 - uVig * smoothstep(0.35, 1.0, edge);
  }
  if (uFish > 0.0 && (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0)) c = vec4(0.0, 0.0, 0.0, 1.0);
  finalColor = c;
}`;

const VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) { return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}`;

class DistortFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'orbit-distort', preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' }),
      resources: {
        fx: new UniformGroup({
          uPixel: { value: 0, type: 'f32' },
          uAberr: { value: 0, type: 'f32' },
          uScan: { value: 0, type: 'f32' },
          uFish: { value: 0, type: 'f32' },
          uPoster: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uVig: { value: 0, type: 'f32' },
          uBloom: { value: 0, type: 'f32' },
          uBloomThr: { value: 0.5, type: 'f32' },
          uBloomCol: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        }),
      },
    });
  }
  get u(): Record<string, number> & { uBloomCol: Float32Array } {
    return (this.resources.fx as { uniforms: Record<string, number> & { uBloomCol: Float32Array } }).uniforms;
  }
}

const EXTRACT_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uThr;
void main() {
  vec4 c = texture(uTexture, vTextureCoord);
  float l = max(c.r, max(c.g, c.b));
  // 문턱을 넘은 만큼 부드럽게
  finalColor = vec4(c.rgb * smoothstep(uThr, min(1.0, uThr + 0.25), l), 1.0);
}`;

/** 밝은 부분만 남기기 */
class ExtractFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERT, fragment: EXTRACT_FRAG, name: 'orbit-extract', preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' }),
      resources: { exU: new UniformGroup({ uThr: { value: 0.5, type: 'f32' } }) },
    });
  }
  set threshold(v: number) {
    (this.resources.exU as { uniforms: { uThr: number } }).uniforms.uThr = v;
  }
}

const GLOW_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uMapTexture;
uniform sampler2D uMap2Texture;
uniform float uScale;
uniform vec3 uColor;
void main() {
  vec4 c = texture(uTexture, vTextureCoord);
  // 좁은 빛(가장자리 광채) + 넓은 빛(빛무리)
  vec3 g = texture(uMapTexture, vTextureCoord).rgb * 0.7 + texture(uMap2Texture, vTextureCoord).rgb * 1.3;
  finalColor = vec4(c.rgb + g * uScale * uColor, c.a);
}`;

/**
 * 빛 번짐 (원작 Bloom): 밝은 부분만 뽑아 넓게 흐린 뒤 색을 입혀 더한다.
 * 흰 타일 둘레로 크고 부드러운 빛무리가 생긴다.
 */
class GlowFilter extends Filter {
  private readonly extract = new ExtractFilter();
  private readonly kawase = new KawaseBlurFilter({ strength: 8, quality: 3 });
  private readonly kawase2 = new KawaseBlurFilter({ strength: 20, quality: 5 });
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERT, fragment: GLOW_FRAG, name: 'orbit-glow', preferredVertexPrecision: 'highp', preferredFragmentPrecision: 'highp' }),
      resources: {
        glowU: new UniformGroup({
          uScale: { value: 1, type: 'f32' },
          uColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
        }),
        uMapTexture: Texture.WHITE.source,
        uMap2Texture: Texture.WHITE.source,
      },
    });
  }
  get u(): { uScale: number; uColor: Float32Array } {
    return (this.resources.glowU as { uniforms: { uScale: number; uColor: Float32Array } }).uniforms;
  }
  set(threshold: number, scale: number, color: number, blurPx: number): void {
    this.extract.threshold = Math.max(0, Math.min(0.99, threshold));
    this.kawase.strength = blurPx * 0.3;
    this.kawase2.strength = blurPx;
    const u = this.u;
    u.uScale = scale;
    u.uColor[0] = ((color >> 16) & 255) / 255;
    u.uColor[1] = ((color >> 8) & 255) / 255;
    u.uColor[2] = (color & 255) / 255;
  }
  override apply(fm: FilterSystem, input: Texture, output: RenderSurface, clear: boolean): void {
    const bright = TexturePool.getSameSizeTexture(input);
    this.extract.apply(fm, input, bright, true);
    const blurred = TexturePool.getSameSizeTexture(input);
    this.kawase.apply(fm, bright, blurred, true);
    const wide = TexturePool.getSameSizeTexture(input);
    this.kawase2.apply(fm, blurred, wide, true);
    this.resources.uMapTexture = blurred.source;
    this.resources.uMap2Texture = wide.source;
    fm.applyFilter(this, input, output, clear);
    TexturePool.returnTexture(wide);
    TexturePool.returnTexture(blurred);
    TexturePool.returnTexture(bright);
  }
}

interface Flake {
  x: number;
  y: number;
  v: number;
  s: number;
}

export class ScreenFx {
  private readonly cm = new ColorMatrixFilter();
  private readonly blur = new BlurFilter({ strength: 0, quality: 2 });
  private readonly noise = new NoiseFilter({ noise: 0 });
  private readonly distort: DistortFilter | null;
  private readonly glow: GlowFilter | null;
  /** 날씨 입자 (화면 좌표). */
  readonly weather = new Container();
  private readonly weatherGfx = new Graphics();
  private flakes: Flake[] = [];
  private lastKey = '';
  /** 화면 높이 (px) — 흐림 반경을 화면 크기에 맞춘다 */
  screenH = 720;

  constructor() {
    let d: DistortFilter | null = null;
    try {
      d = new DistortFilter();
    } catch (e) {
      console.warn('[ORBIT] 화면 왜곡 필터를 만들 수 없습니다', e);
    }
    this.distort = d;
    let g: GlowFilter | null = null;
    try {
      g = new GlowFilter();
    } catch (e) {
      console.warn('[ORBIT] 빛 번짐 필터를 만들 수 없습니다', e);
    }
    this.glow = g;
    this.weather.addChild(this.weatherGfx);
  }

  /**
   * 필터 목록 계산. 쓰는 필터만 돌려준다 (없으면 빈 배열 — 성능).
   * reduce: 효과 줄이기 설정이면 번쩍이는 효과는 약하게.
   */
  filters(
    fs: ReadonlyMap<string, FilterState>,
    bloom: BloomState,
    timeSec: number,
    reduce: boolean,
    /** 카메라 이동 속도 (화면 px/초) — 모션 블러는 카메라가 움직일 때만. */
    motion: { x: number; y: number } = { x: 0, y: 0 },
  ): Filter[] {
    const out: Filter[] = [];
    const k = (name: string) => Math.max(0, fs.get(name)?.intensity ?? 0);
    const any = (...names: string[]) => Math.max(0, ...names.map(k));

    // 색 행렬
    let m = ID;
    const apply = (mat: Mat, amt: number) => {
      if (amt > 0) m = mul(m, mix(mat, Math.min(1, amt)));
    };
    apply(GRAY, any('Grayscale', 'Drawing', 'FiftiesTV'));
    apply(SEPIA, k('Sepia'));
    apply(INVERT, k('Invert'));
    apply(NIGHT, k('NightVision'));
    const con = any('Contrast', 'Sharpen', 'EdgeBlackLine', 'Drawing');
    if (con > 0) m = mul(m, contrast(1 + 0.8 * Math.min(2, con)));
    const neon = Math.max(k('Neon'), 0.4 * any('Arcade', 'LED'));
    if (neon > 0) m = mul(m, saturation(1 + 0.8 * Math.min(2, neon)));
    const funk = k('Funk');
    if (funk > 0) m = mul(m, hue(((timeSec * 120) % 360) * Math.min(1, funk)));
    if (bloom.intensity > 0 && (reduce || !this.glow)) {
      // 셰이더를 못 쓰면 밝기로 흉내
      const b = Math.min(2, bloom.intensity) * (reduce ? 0.3 : 1);
      m = mul(m, brightness(1 + 0.18 * b, bloom.color, 0.06 * b));
    }
    if (m !== ID) {
      this.cm.matrix = m as unknown as ColorMatrix;
      out.push(this.cm);
    }

    // 효과 줄이기: 무거운 필터(흐림·잡음·왜곡)는 건너뛰고 색만
    if (reduce) return out;

    // 흐림
    const bl = any('Blur', 'GaussianBlur', 'BlurFocus');
    // 모션 블러: 카메라가 움직인 방향으로만, 속도에 비례 (가만히 있으면 없음)
    const mb = Math.min(3, k('MotionBlur'));
    const mx = Math.min(4, (Math.abs(motion.x) / 3000) * mb * 2);
    const my = Math.min(4, (Math.abs(motion.y) / 3000) * mb * 2);
    if (bl > 0 || mx > 1 || my > 1) {
      this.blur.strengthX = 8 * Math.min(3, bl) + (mx > 1 ? mx : 0);
      this.blur.strengthY = 8 * Math.min(3, bl) + (my > 1 ? my : 0);
      out.push(this.blur);
    }

    // 잡음
    const nz = any('Grain', 'Static', 'VHS', 'EightiesTV', 'FiftiesTV') + 0.3 * k('Compression');
    if (nz > 0) {
      this.noise.noise = Math.min(0.6, 0.18 * nz);
      this.noise.seed = (timeSec * 7.31) % 1;
      out.push(this.noise);
    }

    // 왜곡
    if (this.distort) {
      const u = this.distort.u;
      const px = any('Pixelate', 'Compression', 'LED', 'PixelSnow') > 0 ? Math.max(k('Pixelate'), k('Compression') * 0.25, k('LED') * 0.8) : 0;
      u.uPixel = px > 0 ? 2 + 5 * Math.min(3, px) : 0;
      u.uAberr = Math.min(40, 6 * any('Aberration', 'VHS', 'EightiesTV', 'Handheld') + (k('Aberration') > 0 ? 2 : 0));
      u.uScan = Math.min(1, 0.6 * any('Arcade', 'VHS', 'EightiesTV', 'FiftiesTV', 'LED'));
      u.uFish = Math.min(1.5, k('Fisheye'));
      u.uPoster = k('Posterize') > 0 ? Math.max(2, 10 - 6 * Math.min(1, k('Posterize'))) : 0;
      u.uTime = timeSec;
      u.uVig = Math.min(1, Math.max(k('Arcade'), k('Fisheye'), k('VHS'), k('EightiesTV'), k('FiftiesTV')) * 0.9);
      u.uBloom = 0; // 빛 번짐은 GlowFilter가 맡는다
      u.uBloomThr = bloom.threshold;
      u.uBloomCol[0] = ((bloom.color >> 16) & 255) / 255;
      u.uBloomCol[1] = ((bloom.color >> 8) & 255) / 255;
      u.uBloomCol[2] = (bloom.color & 255) / 255;
      if (u.uPixel > 0 || u.uAberr > 0 || u.uScan > 0 || u.uFish > 0 || u.uPoster > 0 || u.uVig > 0 || u.uBloom > 0) out.push(this.distort);
    }
    return out;
  }

  /**
   * 트랙 층(타일·행성)에만 거는 빛 번짐. 배경까지 번지면 화면이 뿌옇게 떠서 트랙만.
   * 화면 높이에 비례한 넓은 흐림 (720px 기준 약 25~45px).
   */
  worldFilters(bloom: BloomState, reduce: boolean): Filter[] {
    if (reduce || !this.glow || bloom.intensity <= 0) return [];
    const b = Math.min(3, bloom.intensity);
    // 빛 색은 흰색과 원작 색의 중간 (원작 빛무리는 거의 흰색)
    const c = bloom.color;
    const half = (sh: number) => Math.round(127.5 + ((c >> sh) & 255) / 2);
    const col = (half(16) << 16) | (half(8) << 8) | half(0);
    this.glow.set(Math.max(0.35, bloom.threshold), 1.1 + 0.5 * b, col, (26 + 10 * Math.min(2, b)) * (this.screenH / 720));
    return [this.glow];
  }

  /** 날씨 입자 그리기 (화면 크기 w×h, dt 초). */
  drawWeather(fs: ReadonlyMap<string, FilterState>, w: number, h: number, dt: number, reduce: boolean): void {
    const g = this.weatherGfx;
    g.clear();
    const rain = fs.get('Rain')?.intensity ?? 0;
    const snow = Math.max(fs.get('Blizzard')?.intensity ?? 0, fs.get('PixelSnow')?.intensity ?? 0);
    const kind = rain > 0 ? 'rain' : snow > 0 ? ((fs.get('Blizzard')?.intensity ?? 0) > 0 ? 'blizzard' : 'pixel') : '';
    const amt = Math.min(2, Math.max(rain, snow)) * (reduce ? 0.3 : 1);
    if (!kind || amt <= 0) {
      this.flakes = [];
      this.lastKey = '';
      return;
    }
    const want = Math.round(120 * amt);
    if (this.lastKey !== kind) this.flakes = [];
    this.lastKey = kind;
    while (this.flakes.length < want) this.flakes.push({ x: Math.random(), y: Math.random(), v: 0.5 + Math.random(), s: Math.random() });
    this.flakes.length = want;
    for (const f of this.flakes) {
      if (kind === 'rain') {
        f.y += dt * 1.6 * f.v;
        f.x += dt * 0.15 * f.v;
      } else if (kind === 'blizzard') {
        f.y += dt * 0.5 * f.v;
        f.x += dt * 0.6 * f.v;
      } else {
        f.y += dt * 0.12 * f.v;
        f.x += dt * 0.03 * Math.sin(f.y * 12 + f.s * 6);
      }
      if (f.y > 1.05) {
        f.y -= 1.1;
        f.x = Math.random();
      }
      if (f.x > 1.05) f.x -= 1.1;
      const x = f.x * w;
      const y = f.y * h;
      if (kind === 'rain') g.moveTo(x, y).lineTo(x - 3, y - 18 * f.v).stroke({ width: 1.2, color: 0xaaccff, alpha: 0.45 });
      else if (kind === 'blizzard') g.circle(x, y, 1.2 + f.s * 2.2).fill({ color: 0xffffff, alpha: 0.75 });
      else {
        const s = 3 + Math.round(f.s * 3);
        g.rect(Math.round(x / 3) * 3, Math.round(y / 3) * 3, s, s).fill({ color: 0xffffff, alpha: 0.85 });
      }
    }
  }
}

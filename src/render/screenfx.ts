import { BlurFilter, ColorMatrixFilter, Container, Filter, GlProgram, Graphics, NoiseFilter, UniformGroup, type ColorMatrix } from 'pixi.js';
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

vec2 toTex(vec2 s) { return s * uOutputFrame.zw * uInputSize.zw; }
vec4 samp(vec2 s) { return texture(uTexture, clamp(toTex(s), uInputClamp.xy, uInputClamp.zw)); }

void main() {
  vec2 s = vTextureCoord * uInputSize.xy / uOutputFrame.zw; // 화면 0~1
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
  if (uPoster > 1.0) c.rgb = floor(c.rgb * uPoster + 0.5) / uPoster;
  if (uScan > 0.0) {
    float line = 0.5 + 0.5 * sin(s.y * uOutputFrame.w * 1.6 + uTime * 6.0);
    c.rgb *= 1.0 - uScan * 0.35 * line;
  }
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
        }),
      },
    });
  }
  get u(): Record<string, number> {
    return (this.resources.fx as { uniforms: Record<string, number> }).uniforms;
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
  /** 날씨 입자 (화면 좌표). */
  readonly weather = new Container();
  private readonly weatherGfx = new Graphics();
  private flakes: Flake[] = [];
  private lastKey = '';

  constructor() {
    let d: DistortFilter | null = null;
    try {
      d = new DistortFilter();
    } catch (e) {
      console.warn('[ORBIT] 화면 왜곡 필터를 만들 수 없습니다', e);
    }
    this.distort = d;
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
    if (bloom.intensity > 0) {
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
    const mx = Math.min(8, (Math.abs(motion.x) / 1500) * mb * 3);
    const my = Math.min(8, (Math.abs(motion.y) / 1500) * mb * 3);
    if (bl > 0 || mx > 0.5 || my > 0.5) {
      this.blur.strengthX = 8 * Math.min(3, bl) + (mx > 0.5 ? mx : 0);
      this.blur.strengthY = 8 * Math.min(3, bl) + (my > 0.5 ? my : 0);
      out.push(this.blur);
    }

    // 잡음
    const nz = any('Grain', 'Static', 'VHS', 'EightiesTV', 'FiftiesTV', 'Compression');
    if (nz > 0) {
      this.noise.noise = Math.min(0.6, 0.18 * nz);
      this.noise.seed = (timeSec * 7.31) % 1;
      out.push(this.noise);
    }

    // 왜곡
    if (this.distort) {
      const u = this.distort.u;
      const px = any('Pixelate', 'Compression', 'LED', 'PixelSnow') > 0 ? Math.max(k('Pixelate'), k('Compression') * 0.6, k('LED') * 0.8) : 0;
      u.uPixel = px > 0 ? 2 + 5 * Math.min(3, px) : 0;
      u.uAberr = Math.min(40, 6 * any('Aberration', 'VHS', 'EightiesTV', 'Handheld') + (k('Aberration') > 0 ? 2 : 0));
      u.uScan = Math.min(1, 0.6 * any('Arcade', 'VHS', 'EightiesTV', 'FiftiesTV', 'LED'));
      u.uFish = Math.min(1.5, k('Fisheye'));
      u.uPoster = k('Posterize') > 0 ? Math.max(2, 10 - 6 * Math.min(1, k('Posterize'))) : 0;
      u.uTime = timeSec;
      if (u.uPixel > 0 || u.uAberr > 0 || u.uScan > 0 || u.uFish > 0 || u.uPoster > 0) out.push(this.distort);
    }
    return out;
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

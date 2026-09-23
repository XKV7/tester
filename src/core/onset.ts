/**
 * 정밀 onset(소리 시작) 검출 — 대역별 스펙트럼 변화량(spectral flux) + 적응형 임계값 + 피크 보간.
 * 순수 함수. 약 5.8ms 간격으로 저음(킥)·중음(스네어·멜로디)·고음(하이햇)을 따로 보고 어느 대역이든 새 소리가 나면 잡는다.
 */

export interface Onset {
  /** 곡 시각(초). */
  t: number;
  /** 세기 (정규화된 값, 클수록 뚜렷). */
  s: number;
  /** 가장 강하게 반응한 대역: 0 저음, 1 중음, 2 고음. */
  band: number;
}

export interface OnsetOptions {
  /** 0(큰 소리만) ~ 1(작은 소리까지). 기본 0.5. */
  sensitivity?: number;
  /** 두 onset 사이 최소 간격(초). 기본 0.05. */
  minGap?: number;
  /** 진행률 콜백 (0~1). */
  onProgress?: (r: number) => void;
}

const N = 512;
const TARGET_SR = 22050;

/** 제자리 radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 정수 배 평균 다운샘플 (≈22kHz). */
function downsample(x: Float32Array, sr: number): { y: Float32Array; sr: number } {
  const f = Math.max(1, Math.round(sr / TARGET_SR));
  if (f === 1) return { y: x, sr };
  const y = new Float32Array(Math.floor(x.length / f));
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += x[i * f + k];
    y[i] = s / f;
  }
  return { y, sr: sr / f };
}

function movingStat(x: Float32Array, half: number, fn: 'mean' | 'median'): Float32Array {
  const out = new Float32Array(x.length);
  if (fn === 'mean') {
    let sum = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < x.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(x.length - 1, i + half);
      while (hi < b) sum += x[++hi];
      while (lo < a) sum -= x[lo++];
      out[i] = sum / (hi - lo + 1);
    }
    return out;
  }
  // 근사 중앙값: 구간을 듬성듬성(step) 샘플링
  const step = Math.max(1, Math.floor(half / 16));
  const buf: number[] = [];
  for (let i = 0; i < x.length; i += step) {
    buf.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j += step) buf.push(x[j]);
    buf.sort((p, q) => p - q);
    const m = buf[buf.length >> 1] ?? 0;
    for (let k = i; k < Math.min(x.length, i + step); k++) out[k] = m;
  }
  return out;
}

/** 대역별 스펙트럼 flux 곡선. 반환: 대역 3개 × 프레임, 프레임 간격(초), 프레임 0 중심 시각. */
export function bandFlux(samples: Float32Array, sampleRate: number, onProgress?: (r: number) => void) {
  const { y, sr } = downsample(samples, sampleRate);
  const hop = Math.round(sr * 0.0058); // ≈ 128
  const frames = Math.max(0, Math.floor((y.length - N) / hop));
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const edges = [30, 200, 2000, Math.min(11000, sr / 2 - binHz)].map((f) => Math.max(1, Math.round(f / binHz)));
  const flux = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  let prev = new Float32Array(N / 2);
  let cur = new Float32Array(N / 2);
  const maxPrev = new Float32Array(N / 2);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = y[o + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    if (f > 0) {
      // SuperFlux: 이전 프레임을 주파수 방향으로 ±2칸 최댓값 필터 → 음높이가 미끄러지는 소리(킥 스윕·비브라토)는 새 소리로 안 셈
      for (let k = 0; k < N / 2; k++) {
        let m = prev[k];
        for (let j = Math.max(0, k - 2); j <= Math.min(N / 2 - 1, k + 2); j++) if (prev[j] > m) m = prev[j];
        maxPrev[k] = m;
      }
      for (let b = 0; b < 3; b++) {
        let s = 0;
        for (let k = edges[b]; k < edges[b + 1]; k++) {
          const d = cur[k] - maxPrev[k];
          if (d > 0) s += d;
        }
        flux[b][f] = s / (edges[b + 1] - edges[b]);
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
    if (onProgress && f % 4000 === 0) onProgress(f / frames);
  }
  onProgress?.(1);
  return { flux, dt: hop / sr, t0: N / 2 / sr };
}

/** onset 목록 (시간순). */
export function detectOnsets(samples: Float32Array, sampleRate: number, opts: OnsetOptions = {}): Onset[] {
  const sens = Math.max(0, Math.min(1, opts.sensitivity ?? 0.5));
  const minGap = opts.minGap ?? 0.05;
  const { flux, dt, t0 } = bandFlux(samples, sampleRate, opts.onProgress);
  const n = flux[0].length;
  if (n < 10) return [];
  // 대역별 정규화: (flux - 이동 중앙값) / 이동 평균 크기 → 대역끼리 비교 가능
  const half = Math.round(0.6 / dt);
  const norm = flux.map((fl) => {
    const med = movingStat(fl, half, 'median');
    const mean = movingStat(fl, half, 'mean');
    let g = 0;
    for (const v of fl) g += v;
    g = g / fl.length + 1e-9;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(0, fl[i] - med[i]) / (0.5 * mean[i] + 0.5 * g + 1e-9);
    return out;
  });
  // 결합 검출 함수: 대역 중 최댓값
  const odf = new Float32Array(n);
  const band = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    let bi = 0;
    for (let b = 0; b < 3; b++)
      if (norm[b][i] > m) {
        m = norm[b][i];
        bi = b;
      }
    odf[i] = m;
    band[i] = bi;
  }
  // 적응형 임계값 + 지역 최대
  const thBase = 1.6 - 1.25 * sens; // 민감도 높을수록 낮게
  const localMean = movingStat(odf, Math.round(0.1 / dt), 'mean');
  // 주변 평균 대비 배율: 민감도가 높을수록 큰 소리 바로 뒤의 작은 소리(스네어 뒤 하이햇 등)도 잡는다
  const localK = 1.5 - 1.1 * sens;
  const w = Math.max(1, Math.round(minGap / dt / 2));
  const out: Onset[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = odf[i];
    if (v < thBase || v < localMean[i] * localK) continue;
    let isMax = true;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++)
      if (odf[j] > v || (odf[j] === v && j < i)) {
        isMax = false;
        break;
      }
    if (!isMax) continue;
    // 포물선 보간으로 프레임 사이 위치
    const a = odf[i - 1];
    const c = odf[i + 1];
    const den = a - 2 * v + c;
    const d = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    // flux는 프레임 f와 f-1의 차이 → 새 소리는 두 창 중심 사이(반 hop 앞)에 있다
    const t = t0 + (i + d + 0.5) * dt;
    if (out.length && t - out[out.length - 1].t < minGap) {
      if (v > out[out.length - 1].s) out[out.length - 1] = { t, s: v, band: band[i] };
      continue;
    }
    out.push({ t, s: v, band: band[i] });
  }
  return out;
}

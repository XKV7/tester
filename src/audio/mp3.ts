import { Mp3Encoder } from '@breezystack/lamejs';

/**
 * PCM → mp3 (LAME, 브라우저 안에서). 순수 계산 — DOM 의존 없음.
 * 길게 걸릴 수 있어 일정 프레임마다 쉬면서(await) 진행률을 알린다.
 */
export interface Mp3Options {
  kbps?: number;
  onProgress?: (ratio: number) => void;
  /** 이만큼 프레임을 인코딩할 때마다 이벤트 루프에 양보. */
  yieldEvery?: number;
}

const FRAME = 1152;
const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function toInt16(src: Float32Array, from: number, to: number): Int16Array {
  const out = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const v = Math.max(-1, Math.min(1, src[i]));
    out[i - from] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** 선형 보간 리샘플 (LAME가 지원하지 않는 샘플레이트용). */
export function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return src;
  const n = Math.floor((src.length * to) / from);
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
  }
  return out;
}

export async function encodeMp3(channels: Float32Array[], sampleRate: number, opts: Mp3Options = {}): Promise<Uint8Array> {
  if (channels.length === 0 || channels[0].length === 0) throw new Error('소리가 없습니다.');
  let chs = channels.slice(0, 2);
  let rate = sampleRate;
  if (!LAME_RATES.includes(rate)) {
    const target = rate > 48000 ? 48000 : LAME_RATES.find((r) => r >= rate) ?? 44100;
    chs = chs.map((c) => resample(c, rate, target));
    rate = target;
  }
  const stereo = chs.length === 2;
  const kbps = opts.kbps ?? (stereo ? 192 : 128);
  const enc = new Mp3Encoder(chs.length, rate, kbps);
  const parts: Uint8Array[] = [];
  const total = chs[0].length;
  const every = opts.yieldEvery ?? 200;
  let frames = 0;
  for (let i = 0; i < total; i += FRAME) {
    const end = Math.min(total, i + FRAME);
    const l = toInt16(chs[0], i, end);
    const out = stereo ? enc.encodeBuffer(l, toInt16(chs[1], i, end)) : enc.encodeBuffer(l);
    if (out.length) parts.push(new Uint8Array(out));
    if (++frames % every === 0) {
      opts.onProgress?.(end / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  opts.onProgress?.(1);
  const size = parts.reduce((a, p) => a + p.length, 0);
  const res = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    res.set(p, o);
    o += p.length;
  }
  return res;
}

/** AudioBuffer의 모든 채널을 섞은 모노 샘플. */
export function toMono(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

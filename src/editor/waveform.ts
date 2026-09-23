import type { Chart } from '../core/chart';

const PEAKS_PER_SEC = 200;
const peakCache = new WeakMap<AudioBuffer, Float32Array>();

/** 버퍼 → |최대값| 피크 배열 (초당 200개). */
export function peaks(buf: AudioBuffer): Float32Array {
  let p = peakCache.get(buf);
  if (p) return p;
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(buf.sampleRate / PEAKS_PER_SEC));
  p = new Float32Array(Math.ceil(ch.length / step));
  for (let i = 0; i < p.length; i++) {
    let m = 0;
    const end = Math.min(ch.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const v = Math.abs(ch[j]);
      if (v > m) m = v;
    }
    p[i] = m;
  }
  peakCache.set(buf, p);
  return p;
}

/** 하단 타임라인: 음원 파형 + hitTime 마커 + 재생 위치. */
export class WaveTimeline {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  /** 화면 중앙 시각 (초), 보이는 폭 (초). */
  center = 0;
  span = 8;
  buffer: AudioBuffer | null = null;
  chart: Chart | null = null;
  selected = 0;
  playhead: number | null = null;
  onSelect: ((floor: number) => void) | null = null;
  private drag: { x: number; c: number; moved: boolean } | null = null;
  private ro: ResizeObserver;

  constructor() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.span = Math.max(1, Math.min(120, this.span * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
      else this.center += (e.deltaY + e.deltaX) * 0.002 * this.span;
      this.draw();
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, c: this.center, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      if (Math.abs(dx) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.center = this.drag.c - (dx / this.canvas.clientWidth) * this.span;
        this.draw();
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved || !this.chart) return;
      const r = this.canvas.getBoundingClientRect();
      const t = this.timeAt(e.clientX - r.left);
      // 가장 가까운 마커
      let best = -1;
      let bd = Infinity;
      this.chart.times.forEach((ht, i) => {
        const d2 = Math.abs(ht - t);
        if (d2 < bd) {
          bd = d2;
          best = i;
        }
      });
      if (best >= 0 && (bd / this.span) * this.canvas.clientWidth < 12) this.onSelect?.(best);
    });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  private timeAt(x: number): number {
    return this.center + (x / this.canvas.clientWidth - 0.5) * this.span;
  }

  focus(t: number): void {
    const lo = this.center - this.span * 0.4;
    const hi = this.center + this.span * 0.4;
    if (t < lo || t > hi) this.center = t;
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (!w || !hgt) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const t0 = this.center - this.span / 2;
    const x = (t: number) => ((t - t0) / this.span) * w;
    const mid = hgt / 2 + 8;

    // 초 눈금
    g.fillStyle = '#8d94b8';
    g.font = '11px system-ui, sans-serif';
    const tickStep = this.span > 40 ? 10 : this.span > 16 ? 5 : this.span > 6 ? 1 : 0.5;
    for (let s = Math.ceil(t0 / tickStep) * tickStep; s < t0 + this.span; s += tickStep) {
      g.fillRect(x(s), 0, 1, 6);
      g.fillText(`${s.toFixed(tickStep < 1 ? 1 : 0)}s`, x(s) + 3, 12);
    }

    // 파형
    if (this.buffer) {
      const p = peaks(this.buffer);
      g.fillStyle = 'rgba(122, 209, 255, 0.35)';
      const amp = (hgt - 30) / 2;
      for (let px = 0; px < w; px++) {
        const ta = t0 + (px / w) * this.span;
        const tb = t0 + ((px + 1) / w) * this.span;
        const ia = Math.max(0, Math.floor(ta * PEAKS_PER_SEC));
        const ib = Math.min(p.length, Math.ceil(tb * PEAKS_PER_SEC));
        let m = 0;
        for (let i = ia; i < ib; i++) if (p[i] > m) m = p[i];
        if (m > 0) g.fillRect(px, mid - m * amp, 1, Math.max(1, m * amp * 2));
      }
    } else {
      g.fillStyle = '#8d94b8';
      g.fillText('음원 없음 — 합성 비트 사용', 8, hgt - 8);
    }

    // hitTime 마커
    if (this.chart) {
      const times = this.chart.times;
      for (let i = 0; i < times.length; i++) {
        const xx = x(times[i]);
        if (xx < -2 || xx > w + 2) continue;
        const sel = i === this.selected;
        g.fillStyle = sel ? '#ff8a3d' : this.chart.tiles[i].checkpoint ? '#5cf07a' : 'rgba(232,236,255,0.55)';
        g.fillRect(xx - (sel ? 1 : 0.5), 16, sel ? 2 : 1, hgt - 16);
        if (sel || this.span < 10) {
          g.fillStyle = sel ? '#ff8a3d' : '#8d94b8';
          g.fillText(String(i), xx + 2, 26);
        }
      }
      // offset 표시
      g.fillStyle = '#3de0d0';
      g.fillText('offset', x(this.chart.level.settings.offset) + 3, hgt - 6);
    }
    if (this.playhead !== null) {
      g.fillStyle = '#ff5a5a';
      g.fillRect(x(this.playhead) - 1, 0, 2, hgt);
    }
  }

  destroy(): void {
    this.ro.disconnect();
  }
}

import { defineConfig } from 'vitest/config';

// 빌드 시각 (타이틀 화면에 버전으로 표시 — 최신 버전인지 확인용)
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(stamp) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});

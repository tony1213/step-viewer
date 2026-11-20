import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相对路径：同一份构建既能在本机根路径运行，也能部署到 GitHub Pages 的 /step-viewer/ 子路径
  base: './',
  // 只监听本机，文件不会暴露到局域网
  // 5280: 5173/5174/5180 are already used by other local servers on this machine
  server: { host: '127.0.0.1', port: 5280 },
  preview: { host: '127.0.0.1', port: 5280 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 180_000,
  },
});

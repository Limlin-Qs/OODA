import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    // 与 e2e/run.mjs 启动的 vite preview 端口一致（见 vite.config.ts 注释）
    baseURL: 'http://127.0.0.1:5173',
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// 端口约定（与 e2e/run.mjs、playwright.config.ts 保持一致，勿单独改动）：
// - 本地开发：vite dev 4116 → API 4016（可用 SHAREWORK_DEV_API_ORIGIN 覆盖）
// - E2E：vite preview 5173 → API 3101（可用 SHAREWORK_E2E_API_ORIGIN 覆盖）
const devApiOrigin = process.env.SHAREWORK_DEV_API_ORIGIN ?? 'http://127.0.0.1:4016'
const e2eApiOrigin = process.env.SHAREWORK_E2E_API_ORIGIN ?? 'http://127.0.0.1:3101'

const proxyFor = (target: string) => ({
  '/api': target,
  '/auth': target,
  '/healthz': target,
})

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4116,
    proxy: proxyFor(devApiOrigin),
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: proxyFor(e2eApiOrigin),
  },
})

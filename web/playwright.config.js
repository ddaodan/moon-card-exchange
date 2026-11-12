import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1080, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure"
  },
  webServer: {
    // e2e 必须跑 mock 产物：真实 API 的跨域预检在无头环境不稳定，且测试数据不应写入线上。
    command: "npm run build:mock && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    port: 4173,
    reuseExistingServer: true,
    timeout: 30000
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1080, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 375, height: 720 } } }
  ]
});

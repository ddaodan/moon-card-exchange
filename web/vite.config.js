import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode ?? "production", process.cwd(), "");
  if (command === "build" && mode !== "mock") {
    const base = env.VITE_API_BASE;
    if (!base || base.includes("<") || !base.startsWith("https://")) {
      throw new Error(
        `生产构建需要通过 VITE_API_BASE 指定 HTTPS API 地址，当前值：${base ?? "(未设置)"}`
      );
    }
  }
  if (mode === "mock") {
    // mock 模式固定使用内置假 API，让 import.meta.env.VITE_API_BASE 折叠为 "mock"。
    process.env.VITE_API_BASE = "mock";
  }
  return {
    base: "./",
    appType: "spa",
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash].[ext]"
        }
      }
    }
  };
});

import { defineConfig } from "vitest/config";

process.env.ESBUILD_WORKER_THREADS = "1";

export default defineConfig({
  test: {
    pool: "threads"
  }
});

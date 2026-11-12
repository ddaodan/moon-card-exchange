// 阿里云函数计算定时触发器入口：每天清理一次过期数据。
// 部署时 handler 设为 index.fcTimerHandler，由 esbuild 打包成 dist/fc/index.js。
import { createDefaultApp } from "./index.js";
import { cleanup } from "./index.js";

let storePromise = null;

async function loadStore() {
  if (!storePromise) {
    const module = await import("./store/runtime.js");
    storePromise = module.createRuntimeStore({ ...process.env });
  }
  return storePromise;
}

export async function fcTimerHandler(_event, _context) {
  try {
    const store = await loadStore();
    await cleanup(store);
    return { ok: true };
  } catch (error) {
    console.error(error);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// 同 fc-http.js：兼容 FC 的 CJS 加载方式。
if (typeof module !== "undefined" && module?.exports) {
  module.exports = { fcTimerHandler };
}

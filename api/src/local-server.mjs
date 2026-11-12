// 本地开发服务器：Node 直接跑 Hono，存储用内存实现（数据不落盘）。
// 用法：node api/src/local-server.mjs 或 npm run dev -w @moon/api
import { createServer } from "node:http";
import { createMemoryStore } from "./store/memory.js";
import { createApp } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
const env = {
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173",
  RATE_SALT: process.env.RATE_SALT ?? "local-dev-salt",
  ENKA_UA: process.env.ENKA_UA ?? "moon-card-exchange/1.0",
  ENKA_BASE: process.env.ENKA_BASE
};
const app = createApp(env, createMemoryStore());

createServer(async (request, response) => {
  try {
    const body = await new Response(request, { method: request.method }).arrayBuffer();
    const url = new URL(request.url, `http://localhost:${port}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const method = request.method.toUpperCase();
    const appResponse = await app.fetch(
      new Request(url, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body
      })
    );
    response.statusCode = appResponse.status;
    appResponse.headers.forEach((value, name) => response.setHeader(name, value));
    const buffer = Buffer.from(await appResponse.arrayBuffer());
    response.end(buffer);
  } catch (error) {
    console.error(error);
    response.statusCode = 500;
    response.end(JSON.stringify({ error: { code: "INTERNAL", message: "服务器开小差了，请稍后再试" } }));
  }
}).listen(port, () => {
  console.log(`API 开发服务器已启动：http://localhost:${port}`);
});

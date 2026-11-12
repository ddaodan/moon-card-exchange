// 阿里云函数计算 HTTP 函数入口（Node.js 18 runtime，CommonJS 风格 handler）。
// 把 FC 的事件结构转换成标准 Request，交给 Hono 应用处理，再转回 FC 响应。
// 部署时 handler 设为 index.fcHandler，由 esbuild 打包成 dist/fc/index.js。
import { createDefaultApp } from "./index.js";

let appPromise = null;

function toAppRequest(event, context) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value === undefined || value === null) continue;
    for (const part of String(value).split(",")) {
      try {
        headers.append(name, part.trim());
      } catch {
        // 忽略非法头名
      }
    }
  }
  if (!headers.has("x-forwarded-for")) {
    const ip = context?.clientIP;
    if (ip) headers.set("x-forwarded-for", ip);
  }
  // x-forwarded-for 可被客户端伪造，FC 场景下统一以 context.clientIP 为准。
  headers.delete("x-forwarded-for");
  const trustedIp = context?.clientIP;
  if (trustedIp) headers.set("cf-connecting-ip", trustedIp);
  const url = new URL(event.path ?? "/", "https://fc.aliyun.invalid");
  for (const [name, value] of Object.entries(event.queryParameters ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(name, String(value));
  }
  const method = (event.method ?? "GET").toUpperCase();
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : typeof event.body === "string" && event.body.length > 0
      ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body)
      : undefined;
  return new Request(url, { method, headers, body });
}

async function toFcResponse(appResponse) {
  const headers = {};
  appResponse.headers.forEach((value, name) => {
    headers[name] = headers[name] ? `${headers[name]},${value}` : value;
  });
  const arrayBuffer = await appResponse.arrayBuffer();
  return {
    isBase64Encoded: true,
    statusCode: appResponse.status,
    headers,
    body: Buffer.from(arrayBuffer).toString("base64")
  };
}

function failResponse(message) {
  return {
    isBase64Encoded: false,
    statusCode: 500,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { code: "INTERNAL", message } })
  };
}

function debugDetail(error) {
  if (process.env.DEBUG_ERRORS !== "1") return undefined;
  const stack = error?.stack ?? String(error);
  return String(stack).slice(0, 600);
}

export async function fcHandler(...args) {
  // FC 2.0 的 HTTP 触发器以 (request, response, context) 调用；
  // FC 3.0 / 事件调用以 (event, context) 调用。按第二参是否有 setStatusCode 区分。
  if (args.length >= 2 && args[1] && typeof args[1].setStatusCode === "function") {
    return fcHandlerHttp2(args[0], args[1], args[2]);
  }
  return fcHandlerEvent(args[0], args[1]);
}

// FC 2.0 HTTP 函数签名：request/response/context。
async function fcHandlerHttp2(request, response, context) {
  try {
    if (!appPromise) appPromise = createDefaultApp({ ...process.env });
    const app = await appPromise;
    const appRequest = await toAppRequestHttp2(request, context);
    const appResponse = await app.fetch(appRequest);
    const arrayBuffer = await appResponse.arrayBuffer();
    response.setStatusCode(appResponse.status);
    appResponse.headers.forEach((value, name) => response.setHeader(name, value));
    response.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error(error);
    try {
      response.setStatusCode(500);
      response.setHeader("content-type", "application/json; charset=utf-8");
      const message = "服务器开小差了，请稍后再试";
      const detail = debugDetail(error);
      response.send(
        JSON.stringify({
          error: { code: "INTERNAL", message: detail ? `${message}|${detail}` : message }
        })
      );
    } catch {
      // 响应已发送或连接已断开。
    }
  }
}

async function toAppRequestHttp2(request, context) {
  const headers = new Headers();
  const rawHeaders = request.headers ?? {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined || value === null) continue;
    const parts = Array.isArray(value) ? value : String(value).split(",");
    for (const part of parts) {
      try {
        headers.append(name, String(part).trim());
      } catch {
        // 忽略非法头名
      }
    }
  }
  const trustedIp = request.clientIP ?? context?.clientIP;
  if (trustedIp) {
    headers.delete("x-forwarded-for");
    headers.set("cf-connecting-ip", String(trustedIp));
  }
  const method = String(request.method ?? "GET").toUpperCase();
  const url = new URL(String(request.url ?? request.path ?? "/"), "https://fc.aliyun.invalid");
  // HTTP 触发器代理路径可能带 /2016-08-15/proxy/<service>/<function> 前缀，剥掉它。
  const proxyPrefix = "/2016-08-15/proxy/";
  if (url.pathname.startsWith(proxyPrefix)) {
    const parts = url.pathname.slice(proxyPrefix.length).split("/");
    parts.shift();
    parts.shift();
    url.pathname = "/" + parts.join("/");
  }
  const queries = request.queries ?? {};
  for (const [name, value] of Object.entries(queries)) {
    if (value === undefined || value === null) continue;
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) url.searchParams.append(name, String(part));
  }
  let body;
  if (!["GET", "HEAD"].includes(method)) {
    body = await readHttp2Body(request);
  }
  return new Request(url, { method, headers, body });
}

async function readHttp2Body(request) {
  if (request.body !== undefined && request.body !== null) {
    if (Buffer.isBuffer(request.body)) return request.body;
    if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  }
  if (typeof request.on === "function" && typeof request.read === "function") {
    const chunks = [];
    await new Promise((resolve, reject) => {
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", resolve);
      request.on("error", reject);
    });
    return Buffer.concat(chunks);
  }
  return undefined;
}

// FC 3.0 / 事件签名：event/context。
async function fcHandlerEvent(event, context) {
  try {
    if (!appPromise) {
      appPromise = createDefaultApp({ ...process.env });
    }
    const app = await appPromise;
    const request = toAppRequest(event, context);
    const response = await app.fetch(request);
    return await toFcResponse(response);
  } catch (error) {
    console.error(error);
    const message = "服务器开小差了，请稍后再试";
    const detail = debugDetail(error);
    return failResponse(detail ? `${message}|${detail}` : message);
  }
}

// esbuild --format=cjs 时让 require 能拿到 handler；ESM 源码里 module 未定义，此分支不执行。
if (typeof module !== "undefined" && module?.exports) {
  module.exports = { fcHandler };
}

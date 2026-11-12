const TIMEOUT_MS = 8000;

// 该导出必须保持静态可折叠：生产构建（VITE_API_BASE != "mock"）时
// Rollup 会把下面的动态 import("mock") 整个裁剪掉，保证 mock 代码不进包。
export const IS_MOCK = import.meta.env?.VITE_API_BASE === "mock";

const ERROR_MESSAGES = {
  INVALID_INPUT: "提交的内容有误，请检查后重试",
  UID_INVALID: "UID 应为 9–10 位数字，且服务器可识别",
  UID_NOT_FOUND: "查不到这个 UID，请确认后重试",
  UID_TAKEN: "这个 UID 已经登记过了，可以用恢复码导入找回",
  UNAUTHORIZED: "恢复码无效或已失效，请重新登记",
  NOT_FOUND: "内容不存在或已被删除",
  RATE_LIMITED: "操作太频繁了，请稍后再试",
  LISTING_EXPIRED: "登记已过期，请更新牌匣后继续",
  INTERNAL: "服务器开小差了，请稍后再试"
};

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function resolveBase() {
  const base = import.meta.env?.VITE_API_BASE ?? "";
  if (base === "mock") return "mock";
  return String(base).replace(/\/+$/, "");
}

export const API_BASE = resolveBase();

async function request(path, { method = "GET", body, token } = {}) {
  if (IS_MOCK) {
    const { mockRequest } = await import("./mock/index.js");
    try {
      return await mockRequest(path, { method, body, token });
    } catch (error) {
      const match = String(error?.message ?? "").match(/^MOCK_API:(\d+):([A-Z_]+):(.*)$/);
      if (match) throw new ApiError(match[2], match[3], Number(match[1]));
      throw error;
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError("TIMEOUT", "请求超时了，请检查网络后重试", 0);
    }
    throw new ApiError("NETWORK", "网络连接失败，请稍后重试", 0);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (!data && (response.headers.get("content-type") ?? "").includes("text/html")) {
      // 典型场景：dev server 没开 mock 也没配 API 地址，请求被 SPA 兜底成 HTML 页面。
      throw new ApiError("MISCONFIGURED", "API 地址没有生效：本地开发请用 npm run dev:web:mock 启动", response.status);
    }
    const code = data?.error?.code ?? "INTERNAL";
    throw new ApiError(code, data?.error?.message ?? ERROR_MESSAGES[code] ?? "请求失败，请稍后重试", response.status);
  }
  if (!data) {
    throw new ApiError("MISCONFIGURED", "接口没有返回有效数据，请检查 API 地址配置", response.status);
  }
  return data;
}

export const api = {
  health: () => request("/v1/health"),
  stats: () => request("/v1/stats"),
  profile: (uid) => request(`/v1/profile/${encodeURIComponent(uid)}`),
  createListing: (input) => request("/v1/listings", { method: "POST", body: input }),
  getMyListing: (token) => request("/v1/listings/me", { token }),
  updateMyListing: (token, input) => request("/v1/listings/me", { method: "PUT", body: input, token }),
  deleteMyListing: (token) => request("/v1/listings/me", { method: "DELETE", token }),
  matches: (token) => request("/v1/matches", { token }),
  setPairState: (token, pairId, state, snapshot) =>
    request(`/v1/pairs/${encodeURIComponent(pairId)}/state`, { method: "POST", body: snapshot ? { state, snapshot } : { state }, token }),
  report: (token, pairId, reason) =>
    request("/v1/reports", { method: "POST", body: { pairId, reason }, token })
};

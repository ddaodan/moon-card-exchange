import { cloudClearToken, cloudGet, cloudSet } from "./platform.js";

const KEYS = {
  token: "moon.token",
  // v2：牌目录改为 BWIKI 顺序（愚者挪到第 22 位），旧草稿的下标映射失效，换键废弃。
  draft: "moon.draft.v2",
  seen: "moon.lastSeenMatchesAt",
  hideUid: "moon.hideUid",
  toasts: "moon.toasts"
};

export function getToken() {
  return cloudGet(KEYS.token) ?? "";
}

export function setToken(token) {
  cloudSet(KEYS.token, token ?? "");
}

export function clearToken() {
  cloudSet(KEYS.token, "");
  // 删除登记后同步清掉 B站 云端的恢复码备份；未登录或 Web 端自动跳过。
  cloudClearToken();
}

export function getDraft() {
  const raw = cloudGet(KEYS.draft);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveDraft(draft) {
  cloudSet(KEYS.draft, JSON.stringify(draft));
}

export function clearDraft() {
  cloudSet(KEYS.draft, "");
}

export function getLastSeenMatchesAt() {
  const raw = cloudGet(KEYS.seen);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function setLastSeenMatchesAt(value) {
  cloudSet(KEYS.seen, String(value));
}

export function getHideUid() {
  return cloudGet(KEYS.hideUid) === "1";
}

export function setHideUid(value) {
  cloudSet(KEYS.hideUid, value ? "1" : "0");
}

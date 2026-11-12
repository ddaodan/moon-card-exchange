// Toy 页面实际运行在 www.bilibili.com/toy/<slug>/ 路径下，host 只是兜底判断。
const TOY_PATH_PATTERN = /^\/toy\//i;
const TOY_HOST_PATTERN = /toy\.bilibili\.com/i;
const SDK_SRC = "https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js";
const SDK_LOAD_TIMEOUT = 2000;

// 预置了 window.toy 的环境（如测试注入）也视为 Toy 环境。
export function isToy() {
  if (typeof window === "undefined") return false;
  return TOY_PATH_PATTERN.test(window.location.pathname)
    || TOY_HOST_PATTERN.test(window.location.host)
    || Boolean(window.toy);
}

let sdkPromise = null;

// 动态注入 Toy SDK；只在 Toy 环境加载，失败或超时都静默降级为普通网页能力。
function loadToySdk() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.toy) return Promise.resolve(window.toy);
  if (!isToy()) return Promise.resolve(null);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = SDK_SRC;
      script.onload = () => resolve(window.toy ?? null);
      script.onerror = () => resolve(null);
      setTimeout(() => resolve(window.toy ?? null), SDK_LOAD_TIMEOUT);
      document.head.append(script);
    });
  }
  return sdkPromise;
}

// 返回支持指定能力的 toy 对象，不支持或环境未知时返回 null；调用方据此走浏览器兜底。
async function toyAbility(ability) {
  const sdk = await loadToySdk();
  if (!sdk || typeof sdk.isSupport !== "function") return null;
  try {
    return (await sdk.isSupport(ability)) ? sdk : null;
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

// 保存图片：App 内优先存相册，Web 端或保存失败时退回浏览器下载。
// 返回 "album" | "download"，调用方据此提示用户去哪里找图。
export async function saveImage(blob) {
  if (typeof window === "undefined" || !blob) throw new Error("无法保存图片");
  const sdk = await toyAbility("saveImageToAlbum");
  if (sdk) {
    try {
      const base64Data = await blobToDataUrl(blob);
      await sdk.saveImageToAlbum({ base64Data, hintMsg: "需要相册权限来保存交换名片" });
      return "album";
    } catch {
      /* 相册保存被拒或失败时退回下载 */
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "月谕圣牌交换名片.png";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "download";
}

export function canSaveImageDirectly() {
  return typeof document !== "undefined" && "download" in HTMLAnchorElement.prototype;
}

export function cloudGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function cloudSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// —— Toy 云存储：恢复码跟随 B站 登录态跨设备同步 ——
// 遵循 SDK 限流最佳实践：只在登记/导入/删除等关键节点调用，不作为常规存储。

export async function cloudSyncToken(token) {
  const sdk = await toyAbility("setCloudStorage");
  if (!sdk || !token) return false;
  try {
    await sdk.setCloudStorage({ token });
    return true;
  } catch {
    return false;
  }
}

export async function cloudClearToken() {
  const sdk = await toyAbility("removeCloudStorage");
  if (!sdk) return;
  try {
    await sdk.removeCloudStorage(["token"]);
  } catch {
    /* 云端清理失败不影响本地删除 */
  }
}

export async function cloudRestoreToken() {
  const sdk = await toyAbility("getCloudStorage");
  if (!sdk) return "";
  try {
    const data = await sdk.getCloudStorage(["token"]);
    const token = data?.token;
    return typeof token === "string" && /^[0-9A-HJKLMNPQRSTVWXYZ]{32}$/.test(token) ? token : "";
  } catch {
    return "";
  }
}

// 分享：拉起 B站 App 分享面板，链接由平台按当前 Toy 生成；Web 端不可用。
export async function canShare() {
  return Boolean(await toyAbility("share"));
}

export async function shareToy() {
  const sdk = await toyAbility("share");
  if (!sdk) return false;
  try {
    await sdk.share({ path: "index.html" });
    return true;
  } catch {
    return false;
  }
}

// 平台生成的 Toy 首页二维码（PNG data URL）；结果缓存，避免重复调用。
let toyQrCache = null;

export async function toyQrCode() {
  if (toyQrCache) return toyQrCache;
  const sdk = await toyAbility("getQrCode");
  if (!sdk) return null;
  try {
    const result = await sdk.getQrCode();
    const base64 = result?.base64;
    if (typeof base64 === "string" && base64.startsWith("data:image/")) {
      toyQrCache = base64;
      return toyQrCache;
    }
    return null;
  } catch {
    return null;
  }
}

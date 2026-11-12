import { refreshIcons } from "./icons.js";
import { api, ApiError, IS_MOCK } from "./api.js";
import { cloudRestoreToken } from "./platform.js";
import { clearToken, getToken, setToken } from "./store.js";
import { el, toast } from "./ui.js";
import { createBoxView } from "./views/box.js";
import { createCardView } from "./views/card.js";
import { createMatchView } from "./views/match.js";
import "./styles.css";

const app = document.getElementById("app");

const shell = el("div", { class: "mg" });
app.append(shell);

let currentListing = null;
let currentRoute = "";
let views = {};
let boxView = null;
let matchView = null;
let cardView = null;

// 初始必须隐藏，否则未登记时导航上会显示一个空红点。
const badge = el("span", { class: "mg-badge num", "data-r": "badge", hidden: true });
const navBox = el("button", { type: "button", "data-go": "box", "aria-pressed": "true", onclick: () => navigate("#/box") },
  el("i", { "data-lucide": "library", "aria-hidden": "true" }), "我的牌匣");
const navCard = el("button", { type: "button", "data-go": "card", "aria-pressed": "false", onclick: () => navigate("#/card") },
  el("i", { "data-lucide": "id-card", "aria-hidden": "true" }), "交换名片");
const navMatch = el("button", { type: "button", "data-go": "match", "aria-pressed": "false", onclick: () => navigate("#/match") },
  el("i", { "data-lucide": "sparkles", "aria-hidden": "true" }), "月下相遇", badge);
const header = el("header", { class: "mg-top" },
  el("div", { class: "mg-brand" },
    el("img", { src: "./cards/moon-box-96.webp", alt: "", width: "42", height: "42" }),
    el("div", {}, el("b", {}, "月谕圣牌 · 交换所"), el("small", {}, "MOONLIT ORACLE EXCHANGE"))),
  el("nav", { class: "mg-nav", "aria-label": "主导航" }, navBox, navCard, navMatch));

const viewHost = el("main", { class: "mg-body" });
const foot = el("footer", { class: "mg-foot" },
  el("span", {}, "非官方玩家工具 · 牌面图片来源原神 BWIKI，版权归米哈游"),
  el("span", {}, IS_MOCK ? "当前为演示模式（mock）" : "登记即代表同意共享信息"));

shell.append(header, viewHost, foot);

// 导入恢复码等身份切换后，当前视图需要按新身份重新渲染。
function rerender() {
  if (routeFromHash() === "box" && boxView?.repaint) boxView.repaint();
  if (matchView) matchView.refresh();
  if (cardView) cardView.repaint?.();
}

async function restoreListing() {
  const token = getToken();
  if (!token) return null;
  try {
    const data = await api.getMyListing(token);
    currentListing = data.listing;
    return currentListing;
  } catch (err) {
    if (err instanceof ApiError && (err.code === "UNAUTHORIZED" || err.code === "NOT_FOUND")) {
      clearToken();
      currentListing = null;
    }
    return null;
  }
}

function setBadge(count) {
  badge.textContent = count ? String(count) : "";
  badge.hidden = !count;
}

function routeFromHash() {
  const hash = window.location.hash || "#/box";
  const name = hash.replace(/^#\//, "").split("?")[0];
  return ["box", "match", "card"].includes(name) ? name : "box";
}

function navigate(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

function render() {
  const route = routeFromHash();
  currentRoute = route;
  navBox.setAttribute("aria-pressed", String(route === "box"));
  navCard.setAttribute("aria-pressed", String(route === "card"));
  navMatch.setAttribute("aria-pressed", String(route === "match"));
  if (!views[route]) {
    if (route === "box") {
      boxView = createBoxView(context);
      views.box = boxView.root;
    }
    if (route === "card") {
      cardView = createCardView(context);
      views.card = cardView.root;
    }
    if (route === "match") {
      matchView = createMatchView(context);
      views.match = matchView.root;
    }
  }
  if (route === "match" && matchView) matchView.refresh();
  if (route === "card" && cardView) cardView.repaint?.();
  if (route === "box" && boxView?.repaint) boxView.repaint();
  viewHost.replaceChildren(views[route]);
  refreshIcons(viewHost);
}

const context = {
  navigate,
  getListing: () => currentListing,
  setListing(listing) {
    currentListing = listing;
  },
  setBadge,
  handleUnauthorized() {
    clearToken();
    currentListing = null;
    toast("恢复码已失效，请重新登记或导入", "warn");
  },
  rerender
};

window.addEventListener("hashchange", render);

async function boot() {
  await restoreListing();
  // Toy 云端找回：本地没有令牌但 B站 云端有备份时，静默导入并恢复登记。
  if (!getToken() && !currentListing) {
    const cloudToken = await cloudRestoreToken();
    if (cloudToken) {
      try {
        const data = await api.getMyListing(cloudToken);
        setToken(cloudToken);
        currentListing = data.listing;
        toast("已通过 B站 云端找回你的登记", "ok");
      } catch {
        /* 云端备份已失效：按未登记处理，等删除登记时再清云端 */
      }
    }
  }
  render();
}

boot();

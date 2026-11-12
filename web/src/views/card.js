import { CARDS, CARD_BY_ID, RULES } from "@moon/shared";
import qrcode from "qrcode-generator";
import { TOY_URL } from "../config.js";
import { refreshIcons } from "../icons.js";
import { canShare, saveImage, shareToy, toyQrCode } from "../platform.js";
import { getHideUid, setHideUid, getToken } from "../store.js";
import { el, toast, copyText } from "../ui.js";
import { toPosterState } from "./state.js";

export function createCardView(context) {
  const root = el("div", { "data-view": "card" });
  let hideUid = getHideUid();

  const poster = el("article", { class: "mg-poster", "aria-label": "交换名片" });
  const posterScale = el("div", { class: "mg-poster-scale" }, poster);
  const hideUidToggle = el("input", { type: "checkbox", onchange: () => {
    hideUid = hideUidToggle.checked;
    setHideUid(hideUid);
    paintPoster();
  } });
  hideUidToggle.checked = hideUid;
  const saveMsg = el("span", { "aria-live": "polite" });
  const saveBtn = el("button", { class: "mg-btn is-ghost", type: "button", onclick: savePoster },
    el("i", { "data-lucide": "image-down", "aria-hidden": "true" }), "保存名片图片");
  const shareBtn = el("button", { class: "mg-btn is-ghost", type: "button", hidden: true, onclick: () => shareToy() },
    el("i", { "data-lucide": "share-2", "aria-hidden": "true" }), "分享给牌友");
  // 分享面板仅在 B站 App 内可用，确认支持后再显示按钮。
  canShare().then((ok) => { shareBtn.hidden = !ok; });

  const sideCol = el("div", { class: "mg-sidecol" },
    el("div", { class: "mg-panel mg-form" },
      el("h3", {}, "名片设置"),
      el("label", { class: "mg-switch" }, hideUidToggle, el("span", {}, "名片上隐藏 UID（只影响这张公开名片，不影响匹配共享）")),
      el("p", { class: "mg-hint" }, "名片二维码指向 Toy 页面，扫码即可打开交换所。"),
      el("p", { class: "mg-hint", "data-r": "empty", hidden: true }, "还没有登记信息。先在「我的牌匣」提交登记，名片会自动生成。")),
    el("div", { class: "mg-panel mg-form mg-cardhelp" },
      el("h3", {}, "怎么用这张名片"),
      el("ul", {},
        el("li", {}, el("i", { "data-lucide": "image-down", "aria-hidden": "true" }), el("span", {}, "点「保存名片图片」把名片存成图片，发给牌友或贴到群里。")),
        el("li", {}, el("i", { "data-lucide": "qr-code", "aria-hidden": "true" }), el("span", {}, "对方扫码即可打开交换所，直接看到你能提供和想要的圣牌。")),
        el("li", {}, el("i", { "data-lucide": "shield-check", "aria-hidden": "true" }), el("span", {}, "名片上隐藏 UID 只影响这张图片，匹配到的牌友仍能看到你的完整 UID。")))));

  root.append(
    el("div", { class: "mg-sec" },
      el("span", { class: "mg-orn" }),
      el("div", { class: "mg-sechead" }, el("small", {}, "CHAPTER III"), el("h2", {}, "交换名片")),
      el("span", { class: "mg-orn" })),
    el("div", { class: "mg-profile" },
      sideCol,
      el("div", { class: "mg-poster-col" },
        posterScale,
        el("div", { class: "mg-poster-act" }, saveBtn, shareBtn, saveMsg))));

  function maskUid(uid) {
    if (uid.length < 8) return "已隐藏";
    return `${uid.slice(0, 3)}****${uid.slice(-2)}`;
  }

  function qrDataUrl() {
    try {
      const qr = qrcode(0, "M");
      qr.addData(TOY_URL);
      qr.make();
      return qr.createDataURL(4, 2);
    } catch {
      return null;
    }
  }

  // Toy 环境下换用平台生成的二维码，链接由平台保证指向当前 Toy；结果已缓存。
  function upgradeQr(qr) {
    toyQrCode().then((base64) => {
      if (!base64) return;
      const img = qr.querySelector("img");
      if (img) img.src = base64;
    });
  }

  function paintPoster() {
    const state = toPosterState(context.getListing());
    const emptyHint = root.querySelector('[data-r="empty"]');
    if (!state) {
      poster.replaceChildren();
      poster.hidden = true;
      saveBtn.hidden = true;
      if (emptyHint) emptyHint.hidden = false;
      return;
    }
    poster.hidden = false;
    saveBtn.hidden = false;
    if (emptyHint) emptyHint.hidden = true;
    const uidText = hideUid ? maskUid(state.uid) : state.uid;
    const topCard = state.offer[0] ?? CARD_BY_ID[state.selected ?? "moon"];
    poster.style.setProperty("--acc", topCard?.color ?? "#85bfc9");
    const fan = state.offer.slice(0, 5);
    const mid = (fan.length - 1) / 2;
    const fanImgs = fan.map((card, index) => {
      const d = index - mid;
      const img = el("img", { src: `./cards/${card.id}-360.webp`, alt: card.name });
      img.style.transform = `translateX(calc(-50% + ${d} * 44px)) translateY(${Math.abs(d) * 8}px) rotate(${d * 9}deg)`;
      img.style.zIndex = String(10 - Math.abs(Math.round(d)));
      return img;
    });
    const wantFigures = state.want.map((card) =>
      el("figure", {},
        el("img", { src: `./cards/${card.id}-180.webp`, alt: "" }),
        el("figcaption", {}, card.name)));
    const qr = el("div", { class: "mg-qr is-full" });
    const dataUrl = qrDataUrl();
    if (dataUrl) {
      const img = el("img", { src: dataUrl, alt: "Toy 页面二维码" });
      qr.append(img);
    } else {
      qr.append(el("span", { class: "num" }, "二维码生成失败"));
    }
    upgradeQr(qr);
    poster.replaceChildren(
      el("div", { class: "mg-po-head" },
        el("img", { src: "./cards/moon-box-96.webp", alt: "" }),
        el("p", {}, "MOONLIT ORACLE"),
        el("h3", {}, "圣牌交换名片"),
        el("p", { class: "mg-po-nick" }, `${state.nickname} · ${state.level ? `等阶 ${state.level} · ` : ""}${state.serverLabel}`)),
      el("div", { class: "mg-po-label" }, `我可提供 · ${state.offerTotal} 张`),
      fan.length
        ? el("div", { class: "mg-po-fan", style: `width:${Math.min(300, 72 + fan.length * 44)}px;max-width:100%` }, ...fanImgs)
        : el("p", { class: "mg-po-list" }, "暂无可交换的圣牌"),
      fan.length ? el("p", { class: "mg-po-list" }, state.offer.map((card) => `${card.name} ×${card.spare}`).join(" · ")) : null,
      el("div", { class: "mg-po-label" }, `我想获得 · ${state.want.length} 种`),
      state.want.length
        ? el("div", { class: "mg-po-want" }, ...wantFigures)
        : el("p", { class: "mg-po-list" }, "还没有标记想要的圣牌"),
      el("dl", { class: "mg-po-meta" },
        el("div", {}, el("dt", {}, "服务器"), el("dd", {}, state.serverLabel)),
        el("div", {}, el("dt", {}, "可联系"), el("dd", {}, state.timeText)),
        el("div", {}, el("dt", {}, "UID"), el("dd", { class: "num" }, uidText))),
      el("div", { class: "mg-po-qr" }, qr,
        el("p", {}, "扫码打开月谕交换所，", el("br"), "看看你缺的牌在谁手里")));
    refreshIcons(root);
    fitPoster();
  }

  async function savePoster() {
    saveBtn.disabled = true;
    saveMsg.textContent = "正在生成图片…";
    try {
      const { toBlob } = await import("html-to-image");
      const blob = await toBlob(poster, { pixelRatio: 2, backgroundColor: "#0b0e28" });
      if (!blob) throw new Error("生成失败");
      // App 内存相册，Web 端退回浏览器下载；platform 统一处理。
      const how = await saveImage(blob);
      saveMsg.textContent = how === "album" ? "已保存到手机相册" : "已开始下载";
      toast(how === "album" ? "名片已保存到相册" : "名片图片已开始下载", "ok");
    } catch {
      saveMsg.textContent = "生成失败，请长按名片截图保存";
      toast("图片生成失败，可长按名片截图保存", "warn");
    } finally {
      saveBtn.disabled = false;
    }
  }

  function mount() {
    paintPoster();
    refreshIcons(root);
  }

  // 桌面端把名片预览缩放进当前屏幕：缩放加在包装层上，导出 PNG 仍按原始尺寸渲染。
  const fitQuery = window.matchMedia("(max-width: 780px)");
  function fitPoster() {
    if (fitQuery.matches || poster.hidden || !poster.firstElementChild) {
      posterScale.style.transform = "";
      posterScale.style.height = "";
      return;
    }
    posterScale.style.transform = "";
    posterScale.style.height = "";
    const natural = poster.offsetHeight;
    if (!natural) return;
    const act = root.querySelector(".mg-poster-act");
    const foot = document.querySelector(".mg-foot");
    const top = posterScale.getBoundingClientRect().top + window.scrollY;
    const reserved = (act?.offsetHeight ?? 0) + (foot?.offsetHeight ?? 0) + 76;
    const scale = Math.min(1, (window.innerHeight - top - reserved) / natural);
    if (scale < 0.995) {
      posterScale.style.transform = `scale(${scale.toFixed(4)})`;
      posterScale.style.height = `${Math.round(natural * scale)}px`;
    }
  }
  fitQuery.addEventListener("change", fitPoster);
  window.addEventListener("resize", fitPoster);
  // 图片与字体加载完成会改变自然高度，加载后重新适配一次。
  poster.addEventListener("load", fitPoster, true);
  document.fonts?.ready?.then(fitPoster).catch(() => {});

  mount();
  return { root, repaint: paintPoster };
}

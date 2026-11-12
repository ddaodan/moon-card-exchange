import { refreshIcons } from "./icons.js";

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(message, kind = "info") {
  let wrap = document.querySelector(".mg-toasts");
  if (!wrap) {
    wrap = el("div", { class: "mg-toasts" });
    document.body.append(wrap);
  }
  const item = el("div", { class: `mg-toast is-${kind}`, role: "status" }, message);
  wrap.append(item);
  setTimeout(() => {
    item.classList.add("is-out");
    setTimeout(() => item.remove(), 400);
  }, 2600);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      // 部分浏览器在未授权时会挂起而不是拒绝，加超时避免拖住后续交互。
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200))
      ]);
      return "clipboard";
    } catch {
      /* 继续降级 */
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (ok) return "execCommand";
  } catch {
    /* 继续降级 */
  }
  return "manual";
}

export function formatRelative(ms) {
  if (!ms) return "";
  const diff = Date.now() - Number(ms);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(Number(ms)).toLocaleDateString("zh-CN");
}

export function confirmDialog({ title, body, extra = null, confirmLabel = "确认", cancelLabel = "取消", checkboxes = [] }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "mg-modal-backdrop" });
    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };
    const boxes = checkboxes.map((box) => ({
      ...box,
      node: el("label", { class: "mg-switch" },
        el("input", {
          type: "checkbox",
          checked: box.checked ?? false,
          onchange: (event) => {
            if (!event.target.checked || !box.radio) return;
            // 单选组：勾选一项时取消同组其他项。
            for (const other of boxes) {
              if (other !== box && other.radio) {
                other.node.querySelector("input").checked = false;
              }
            }
          }
        }),
        el("span", {}, box.label)
      )
    }));
    const dialog = el("div", { class: "mg-panel mg-modal", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("h3", {}, title),
      body ? (body.nodeType ? body : el("p", { class: "mg-hint" }, body)) : null,
      extra,
      ...boxes.map((box) => box.node),
      el("div", { class: "mg-modal-act" },
        cancelLabel ? el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => close(null) }, cancelLabel) : null,
        el("button", {
          class: "mg-btn", type: "button",
          onclick: () => close(boxes.map((box) => box.node.querySelector("input").checked))
        }, confirmLabel)
      )
    );
    backdrop.append(dialog);
    refreshIcons(backdrop);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.body.append(backdrop);
  });
}

// 恢复码等需要强调的内容块：说明 + 大号代码 + 复制按钮，供 confirmDialog 与提示面板复用。
export function codeBlock({ caption, code, copyLabel = "复制", onCopied }) {
  const codeNode = el("code", { class: "num mg-code" }, code);
  const node = el("div", { class: "mg-code-block" },
    caption ? el("p", { class: "mg-code-caption" }, caption) : null,
    el("div", { class: "mg-code-line" },
      codeNode,
      el("button", {
        class: "mg-icon-btn", type: "button", "aria-label": copyLabel,
        onclick: async (event) => {
          const button = event.currentTarget;
          const result = await copyText(code);
          if (result !== "manual") {
            toast("已复制到剪贴板", "ok");
            button.classList.add("is-done");
            setTimeout(() => button.classList.remove("is-done"), 1200);
          } else {
            toast("复制失败，请手动选中代码复制", "warn");
          }
          onCopied?.(result);
        }
      }, el("i", { "data-lucide": "copy", "aria-hidden": "true" }))));
  return node;
}

import { api, ApiError } from "../api.js";
import { refreshIcons } from "../icons.js";
import { cloudSyncToken } from "../platform.js";
import { clearDraft, clearToken, getToken, setToken } from "../store.js";
import { el, toast, copyText, confirmDialog } from "../ui.js";

function formatToken(token) {
  return (token.match(/.{1,4}/g) ?? [token]).join(" ");
}

// 恢复码导入用 8 组 × 4 字符的分组输入框：每组只收 1 个字符段，规避自由文本输入。
function importCodeInputs() {
  const inputs = [];
  for (let group = 0; group < 8; group += 1) {
    const input = el("input", {
      class: "mg-field num mg-code-cell",
      inputmode: "latin",
      maxlength: "4",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `恢复码第 ${group + 1} 组`,
      oninput: (event) => {
        const target = event.target;
        target.value = target.value.toUpperCase().replace(/[^0-9A-HJKLMNPQRSTVWXYZ]/g, "").slice(0, 4);
        if (target.value.length === 4 && inputs[group + 1]) inputs[group + 1].focus();
      },
      onkeydown: (event) => {
        if (event.key === "Backspace" && !event.target.value && inputs[group - 1]) {
          event.preventDefault();
          inputs[group - 1].focus();
        }
      },
      onpaste: (event) => {
        // 允许整段粘贴：自动拆分到后续各组。
        const text = String(event.clipboardData?.getData("text") ?? "").toUpperCase();
        const cleaned = text.replace(/[^0-9A-HJKLMNPQRSTVWXYZ]/g, "");
        if (cleaned.length <= 4) return;
        event.preventDefault();
        for (let offset = 0; offset + group < 8 && offset * 4 < cleaned.length; offset += 1) {
          inputs[group + offset].value = cleaned.slice(offset * 4, offset * 4 + 4);
        }
        const last = Math.min(7, group + Math.ceil(cleaned.length / 4) - 1);
        inputs[last].focus();
      }
    });
    inputs.push(input);
  }
  return inputs;
}

// 登记页「找回登记」弹窗：8 组 × 4 位分组输入，支持整段粘贴自动拆分。
// 弹窗打开时才挂到 body 上，不影响首页布局；导入成功后由 onImported 决定去向。
export function createRecoveryPanel({ onImported } = {}) {
  const hint = el("p", { class: "mg-hint", "aria-live": "polite", style: "flex:1;align-self:center" });
  const inputs = importCodeInputs();
  const dialog = el("div", { class: "mg-panel mg-modal", role: "dialog", "aria-modal": "true", "aria-label": "用恢复码找回登记" },
    el("h3", {}, "用恢复码找回登记"),
    el("p", { class: "mg-hint" }, "换设备或清除浏览器数据后，在下方 8 个格子里填入登记时保存的恢复码（支持整段粘贴自动拆分）。导入成功后，这份登记会回到本设备。"),
    el("div", { class: "mg-code-grid" }, ...inputs.map((input) => el("label", { class: "mg-code-wrap" }, input))),
    el("div", { class: "mg-import-row" },
      el("button", { class: "mg-btn", type: "button", onclick: doImport }, "导入并恢复"),
      el("button", { class: "mg-btn is-ghost", type: "button", onclick: hide }, "取消"),
      hint));
  const backdrop = el("div", { class: "mg-modal-backdrop", hidden: true }, dialog);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) hide();
  });

  async function doImport() {
    // 输入框的 oninput/onpaste 已过滤非法字符，这里只需拼接与长度校验。
    const raw = inputs.map((cell) => cell.value.toUpperCase()).join("");
    if (raw.length !== 32) {
      hint.textContent = `还差 ${32 - raw.length} 位，请填满 8 组`;
      return;
    }
    hint.textContent = "正在导入…";
    try {
      const data = await api.getMyListing(raw);
      clearDraft();
      setToken(raw);
      // 导入的登记同样备份到 B站 云端；失败静默，本地恢复码仍然有效。
      cloudSyncToken(raw);
      hint.textContent = "";
      toast("找回成功，登记已恢复", "ok");
      onImported?.(data.listing);
    } catch (err) {
      hint.textContent = err instanceof ApiError ? err.message : "导入失败，请检查恢复码";
    }
  }

  function toggle() {
    if (backdrop.hidden) {
      backdrop.hidden = false;
      document.body.append(backdrop);
      inputs[0].focus();
    } else {
      hide();
    }
  }

  function hide() {
    backdrop.hidden = true;
    backdrop.remove();
  }

  return { toggle, hide };
}

// 已登记用户的登记管理：恢复码查看复制、续期、删除与数据说明，嵌入登记向导下方。
export function createRegistryPanel({ getListing, onChanged } = {}) {
  const tokenDisplay = el("code", { class: "num mg-token" });
  const expiresNote = el("p", { class: "mg-hint" });
  const node = el("div", { class: "mg-panel mg-form mg-registry", hidden: true },
    el("h3", {}, "登记管理"),
    el("div", { class: "mg-token-row" },
      tokenDisplay,
      el("button", { class: "mg-icon-btn", type: "button", "aria-label": "复制恢复码", onclick: copyToken },
        el("i", { "data-lucide": "copy", "aria-hidden": "true" }))),
    el("p", { class: "mg-hint" }, "恢复码是找回登记的唯一凭证，等同于账号。换设备或清除浏览器数据后，回登记页首页点「已有恢复码？找回登记」导入即可。请妥善保存、勿与他人分享。"),
    el("div", { class: "mg-act-row" },
      el("button", { class: "mg-btn is-ghost", type: "button", onclick: renew },
        el("i", { "data-lucide": "refresh-cw", "aria-hidden": "true" }), "续期 30 天"),
      el("button", { class: "mg-btn is-ghost", type: "button", onclick: remove },
        el("i", { "data-lucide": "trash-2", "aria-hidden": "true" }), "删除登记")),
    expiresNote,
    el("p", { class: "mg-hint" }, "数据说明：本站只保存 UID、牌匣数量、想要列表、可联系时间。名片图片保存在你自己的设备里，本站不保存。删除登记会同时删除所有匹配记录，恢复码随之失效。"));

  async function copyToken() {
    const token = getToken();
    const result = await copyText(token);
    toast(result === "manual" ? "复制失败，请手动复制" : "恢复码已复制", result === "manual" ? "warn" : "ok");
  }

  async function renew() {
    const token = getToken();
    if (!token) return;
    try {
      const data = await api.getMyListing(token);
      // 更新一次登记即完成续期（服务端 PUT 会把有效期延长 30 天）。
      const updated = await api.updateMyListing(token, {
        uid: data.listing.uid,
        counts: data.listing.counts,
        want: data.listing.want,
        timeSlots: data.listing.timeSlots,
        consent: true
      });
      onChanged?.(updated.listing);
      toast("已续期 30 天", "ok");
      paint();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "续期失败，请稍后重试", "warn");
    }
  }

  async function remove() {
    const token = getToken();
    if (!token) return;
    const result = await confirmDialog({
      title: "删除登记？",
      body: "会删除你的登记和所有匹配记录，恢复码失效。此操作无法撤销。",
      confirmLabel: "确认删除"
    });
    if (!result) return;
    try {
      await api.deleteMyListing(token);
      clearToken();
      clearDraft();
      onChanged?.(null);
      toast("已删除登记", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "删除失败，请稍后重试", "warn");
    }
  }

  function paint() {
    const token = getToken();
    node.hidden = !token;
    if (!token) return;
    tokenDisplay.textContent = formatToken(token);
    const expiresAt = Number(getListing?.()?.expiresAt ?? 0);
    expiresNote.textContent = expiresAt
      ? `登记有效期至 ${new Date(expiresAt).toLocaleDateString("zh-CN")}，更新登记或点「续期」可延长 30 天。`
      : "";
    refreshIcons(node);
  }

  return { node, paint };
}

import { CARD_BY_ID, TIME_SLOTS } from "@moon/shared";
import { api, ApiError } from "../api.js";
import { refreshIcons } from "../icons.js";
import { clearDraft, getLastSeenMatchesAt, setLastSeenMatchesAt, getToken } from "../store.js";
import { el, toast, copyText, confirmDialog, formatRelative } from "../ui.js";

const REPORT_REASONS = [
  { id: "uid_invalid", label: "UID 无效或不是本人" },
  { id: "inventory_fake", label: "牌匣信息不实" },
  { id: "harassment", label: "骚扰或不当行为" }
];

export function createMatchView(context) {
  const root = el("div", { "data-view": "match" });
  let tab = "active";
  let data = { active: [], records: [] };
  let loading = false;
  let error = null;
  let lastFetchAt = 0;
  let undoTimer = null;
  let undoPairId = null;
  let undoPrevState = null;

  const banner = el("div", { class: "mg-banner" });
  const tabs = el("div", { class: "mg-tabs", role: "tablist", "aria-label": "匹配列表" });
  const tabButtons = {
    active: el("button", { class: "mg-tab", type: "button", role: "tab", onclick: () => setTab("active") }, "匹配中"),
    completed: el("button", { class: "mg-tab", type: "button", role: "tab", onclick: () => setTab("completed") }, "已交换"),
    hidden: el("button", { class: "mg-tab", type: "button", role: "tab", onclick: () => setTab("hidden") }, "已隐藏")
  };
  Object.values(tabButtons).forEach((button) => tabs.append(button));
  const list = el("div", { class: "mg-matches" });
  const emptyHint = el("p", { class: "mg-empty" }, "对方登记后会自动出现，稍后再来看看。");

  root.append(
    el("div", { class: "mg-sec" },
      el("span", { class: "mg-orn" }),
      el("div", { class: "mg-sechead" }, el("small", {}, "CHAPTER IV"), el("h2", {}, "月下相遇")),
      el("span", { class: "mg-orn" })),
    banner,
    tabs,
    list);

  function setTab(next) {
    tab = next;
    paintTabs();
    paintList();
    markSeen();
  }

  function paintTabs() {
    for (const [key, button] of Object.entries(tabButtons)) {
      button.setAttribute("aria-selected", String(key === tab));
      button.classList.toggle("is-on", key === tab);
      const n = key === "active" ? data.active.length : data.records.filter((row) => row.myState === key).length;
      button.textContent = `${{ active: "匹配中", completed: "已交换", hidden: "已隐藏" }[key]}${n ? ` (${n})` : ""}`;
    }
  }

  function timeOverlapLabel(overlap) {
    return overlap ? "可联系时间有重叠" : "时间不重叠，联系时请留好余地";
  }

  function miniFig(id) {
    const card = CARD_BY_ID[id];
    if (!card) return null;
    return el("figure", { class: "mg-mini", style: `--acc:${card.color}` },
      el("img", { src: `./cards/${card.id}-180.webp`, alt: "" }),
      el("figcaption", {}, card.name));
  }

  function matchArticle(match) {
    const partner = match.partner ?? match.snapshot?.partner ?? { nickname: "旅行者", uid: "—", serverLabel: "—" };
    const isCompleted = match.myState === "completed";
    const isExchanging = match.myState === "exchanging";
    const uidKnown = partner.uid != null && partner.uid !== "" && partner.uid !== "—";
    const give = match.give?.length ? match.give : (match.snapshot?.give ?? []);
    const get = match.get?.length ? match.get : (match.snapshot?.get ?? []);
    const tradeCount = match.tradeCount || match.snapshot?.tradeCount || Math.min(give.length, get.length);
    // 交换按 tradeCount 一换一估算：展示与标记完成的口径一致，超出部分不展示。
    const shownGive = tradeCount > 0 ? give.slice(0, tradeCount) : give;
    const shownGet = tradeCount > 0 ? get.slice(0, tradeCount) : get;
    const article = el("article", { class: "mg-panel mg-match" });
    article.style.setProperty("--acc", CARD_BY_ID[get[0]]?.color ?? "#85bfc9");
    article.append(
      el("div", { class: "mg-who" },
        el("span", { class: "mg-sigil", "aria-hidden": "true" }, String(partner.nickname ?? "旅").trim().charAt(0) || "旅"),
        el("div", {},
          el("b", {}, partner.nickname ?? "旅行者"),
          isExchanging ? el("span", { class: "mg-tag is-live" }, "正在交换") : null,
          match.partnerBusy && !isExchanging && !isCompleted
            ? el("span", { class: "mg-tag is-warn" }, "与他人交换中")
            : null,
          el("small", {}, `${partner.serverLabel ?? partner.serverGroup ?? ""} · ${partner.level ? `等阶 ${partner.level} · ` : ""}${timeOverlapLabel(match.timeOverlap)} · 更新于 ${formatRelative(partner.updatedAt)}`)),
        el("div", { class: "mg-uid" },
          el("span", { class: "mg-uid-label" }, "UID "),
          uidKnown
            ? el("code", { class: "num" }, String(partner.uid))
            : el("span", { class: "mg-uid-pending" }, "申请交换后可见"),
          uidKnown
            ? el("button", { class: "mg-icon-btn", type: "button", "aria-label": "复制对方 UID",
                onclick: async () => {
                  const result = await copyText(String(partner.uid));
                  toast(result === "manual" ? "复制失败，请手动复制" : "UID 已复制", result === "manual" ? "warn" : "ok");
                } },
                el("i", { "data-lucide": "copy", "aria-hidden": "true" }))
            : null,
          match.partnerState === "completed"
            ? el("span", { class: "mg-tag is-done" }, "对方已标记交换")
            : null)),
      el("div", { class: "mg-ritual" },
        el("div", { class: "mg-give" },
          el("small", {}, "你交出"),
          el("div", { class: "mg-minis" }, ...shownGive.map(miniFig))),
        el("div", { class: "mg-swap" },
          el("span", {}, el("i", { "data-lucide": "arrow-left-right", "aria-hidden": "true" })),
          el("b", {}, `${tradeCount} 换 ${tradeCount}`)),
        el("div", { class: "mg-get" },
          el("small", {}, "你获得"),
          el("div", { class: "mg-minis" }, ...shownGet.map(miniFig)))),
      el("div", { class: "mg-act" },
        el("p", { class: "mg-quote" }, isExchanging
          ? "交换进行中：用对方的 UID 在游戏内添加好友，实际换完后点「已交换」更新牌匣。"
          : "先申请交换：进入交换状态后即可看到对方 UID，在游戏内添加好友交换。"),
        isCompleted
          ? el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => setPairState(match.pairId, "active") },
              el("i", { "data-lucide": "undo-2", "aria-hidden": "true" }), "恢复为匹配中")
          : isExchanging
            ? el("button", { class: "mg-btn", type: "button", onclick: () => markCompleted(match) },
                el("span", { class: "mg-ico" }, el("i", { "data-lucide": "check", "aria-hidden": "true" })), "已交换")
            : el("button", { class: "mg-btn", type: "button", onclick: () => applyPair(match) },
                el("span", { class: "mg-ico" }, el("i", { "data-lucide": "handshake", "aria-hidden": "true" })), "申请交换"),
        el("div", { class: "mg-act-row" },
          isExchanging
            ? el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => cancelPair(match) },
                el("i", { "data-lucide": "x", "aria-hidden": "true" }), "取消交换")
            : null,
          el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => hidePair(match) },
            el("i", { "data-lucide": "eye-off", "aria-hidden": "true" }), "隐藏"),
          el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => reportPair(match) },
            el("i", { "data-lucide": "flag", "aria-hidden": "true" }), "举报"))));
    return article;
  }

  function recordArticle(match) {
    const partner = match.partner ?? match.snapshot?.partner ?? { nickname: "旅行者" };
    const giveIds = match.snapshot?.give ?? match.give ?? [];
    const getIds = match.snapshot?.get ?? match.get ?? [];
    return el("li", { class: "mg-log-row" },
      el("time", {}, formatRelative(match.updatedAt)),
      el("div", {},
        el("b", {}, partner.nickname ?? "旅行者"),
        el("small", {}, `UID ${partner.uid ?? "—"} · ${giveIds.map((id) => CARD_BY_ID[id]?.name ?? id).join("、") || "—"} ⇄ ${getIds.map((id) => CARD_BY_ID[id]?.name ?? id).join("、") || "—"}`)),
      match.myState === "hidden"
        ? el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => setPairState(match.pairId, "active") }, "恢复")
        : el("span", { class: "mg-tag is-done" }, "已交换"));
  }

  function paintList() {
    if (loading) {
      list.replaceChildren(el("p", { class: "mg-empty" }, "正在召唤月光的匹配…"));
      return;
    }
    if (error) {
      const retry = el("button", { class: "mg-btn", type: "button", onclick: () => fetchMatches(true) }, "重试");
      list.replaceChildren(el("div", { class: "mg-panel" }, el("p", { class: "mg-hint is-err" }, error), retry));
      refreshIcons(list);
      return;
    }
    const token = getToken();
    if (!token) {
      list.replaceChildren(
        el("div", { class: "mg-panel" },
          el("p", { class: "mg-hint" }, "先在「我的牌匣」提交登记，匹配会自动出现。"),
          el("button", { class: "mg-btn", type: "button", onclick: () => context.navigate("#/box") }, "去整理牌匣")));
      refreshIcons(list);
      return;
    }
    if (tab === "active") {
      const rows = data.active;
      list.replaceChildren(...(rows.length ? rows.map(matchArticle) : [emptyHint]));
    } else {
      const rows = data.records.filter((row) => row.myState === tab);
      if (!rows.length) {
        list.replaceChildren(el("p", { class: "mg-empty" }, tab === "completed" ? "还没有标记完成的交换。" : "没有隐藏的匹配。"));
      } else {
        const log = el("ol", { class: "mg-log" });
        rows.forEach((row) => log.append(recordArticle(row)));
        list.replaceChildren(log);
      }
    }
    refreshIcons(list);
  }

  function paintBanner() {
    const token = getToken();
    if (!token) {
      banner.classList.remove("is-live");
      banner.replaceChildren(
        el("i", { "data-lucide": "moon-star", "aria-hidden": "true" }),
        el("p", {}, "登记之后，系统会自动在同服务器里寻找互相补缺的旅行者。"));
    } else {
      banner.classList.add("is-live");
      banner.replaceChildren(
        el("i", { "data-lucide": "shield-check", "aria-hidden": "true" }),
        el("p", {}, el("b", {}, "已登记"), ` · 双方无需同时在线，新匹配会自动出现。当前有 ${data.active.length} 位互补的旅行者。`));
    }
    refreshIcons(banner);
  }

  async function fetchMatches(force = false) {
    const token = getToken();
    if (!token) {
      paintBanner();
      paintList();
      return;
    }
    if (!force && Date.now() - lastFetchAt < 60000) {
      return;
    }
    loading = true;
    error = null;
    paintList();
    try {
      data = await api.matches(token);
      lastFetchAt = Date.now();
      markSeen();
    } catch (err) {
      error = err instanceof ApiError ? err.message : "加载失败，请稍后重试";
      if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
        context.handleUnauthorized();
      }
    } finally {
      loading = false;
      paintBanner();
      paintTabs();
      paintList();
    }
  }

  function newMatchCount() {
    const seen = getLastSeenMatchesAt();
    return data.active.filter((match) => Number(match.createdAt) > seen).length;
  }

  function markSeen() {
    // 先用旧的 lastSeenMatchesAt 计算新匹配数，再刷新时间戳。
    const count = newMatchCount();
    setLastSeenMatchesAt(Date.now());
    context.setBadge(count);
  }

  async function setPairState(pairId, state, snapshot) {
    try {
      await api.setPairState(getToken(), pairId, state, snapshot);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "操作失败，请稍后重试", "warn");
      return false;
    }
    const inActive = data.active.find((row) => row.pairId === pairId);
    if (inActive) {
      inActive.myState = state;
      if (state === "exchanging") {
        // 申请交换：双方一起进入交换状态，UID 待重新拉取。
        inActive.partnerState = "exchanging";
      } else if (state === "active") {
        if (inActive.partnerState === "exchanging") inActive.partnerState = "active";
      } else {
        data.records = [inActive, ...data.records.filter((row) => row.pairId !== pairId)];
        data.active = data.active.filter((row) => row.pairId !== pairId);
      }
    } else {
      const inRecords = data.records.find((row) => row.pairId === pairId);
      if (inRecords) {
        inRecords.myState = state;
        if (state === "active") {
          data.records = data.records.filter((row) => row.pairId !== pairId);
          data.active = [inRecords, ...data.active];
        }
      }
    }
    paintTabs();
    paintList();
    return true;
  }

  // 申请交换：双方进入交换状态后才互相可见 UID；对方忙碌时先提醒。
  async function applyPair(match) {
    if (match.partnerBusy) {
      const result = await confirmDialog({
        title: "对方正在和他人交换",
        body: "对方已经和其他旅行者进入交换流程，可能会换不到。仍要申请吗？",
        confirmLabel: "仍要申请"
      });
      if (!result) return;
    }
    const ok = await setPairState(match.pairId, "exchanging");
    if (!ok) return;
    toast("已申请交换，现在可以看到对方的 UID 了", "ok");
    // 对方 UID 之前是隐藏的，重新拉取匹配列表拿到完整信息。
    await fetchMatches(true);
  }

  // 取消交换：双方回到匹配中，UID 重新隐藏。
  async function cancelPair(match) {
    const result = await confirmDialog({
      title: "取消这次交换？",
      body: "取消后双方都会回到匹配中，对方的 UID 会重新隐藏。",
      confirmLabel: "取消交换"
    });
    if (!result) return;
    const ok = await setPairState(match.pairId, "active");
    if (!ok) return;
    toast("已取消交换申请", "ok");
    await fetchMatches(true);
  }

  async function markCompleted(match) {
    // 交换按 tradeCount 一换一估算：给出与获得都只取前 tradeCount 种。
    // 对方先完成并更新牌匣后实时牌面可能为空，退回快照（已换向成本方视角）。
    const givePool = match.give?.length ? match.give : (match.snapshot?.give ?? []);
    const getPool = match.get?.length ? match.get : (match.snapshot?.get ?? []);
    const tradeCount = Math.max(1, match.tradeCount || Math.min(givePool.length, getPool.length) || 1);
    const giveIds = givePool.slice(0, tradeCount);
    const getIds = getPool.slice(0, tradeCount);
    const giveNamesReal = giveIds.map((id) => CARD_BY_ID[id]?.name ?? id).join("、");
    const getNamesReal = getIds.map((id) => CARD_BY_ID[id]?.name ?? id).join("、");
    const result = await confirmDialog({
      title: "确认已交换？",
      body: `这次交换：你交出 ${giveNamesReal || "（以实际商定为准）"}，获得 ${getNamesReal || "（以实际商定为准）"}。确认后会在牌匣中交出 −1、获得 +1，并记录为已交换。`,
      confirmLabel: "确认已交换",
      checkboxes: [
        { label: `更新牌匣：${giveNamesReal || "交出的牌"} −1，${getNamesReal || "获得的牌"} +1`, checked: true, id: "apply" },
        { label: "同时隐藏这条匹配", checked: false, id: "hide" }
      ]
    });
    if (!result) return;
    const [applyInventory, alsoHide] = result;
    if (applyInventory && context.getListing()) {
      const listing = context.getListing();
      const counts = [...listing.counts];
      const want = new Set(listing.want ?? []);
      for (const id of giveIds) {
        const card = CARD_BY_ID[id];
        if (card) counts[card.no] = Math.max(0, counts[card.no] - 1);
      }
      for (const id of getIds) {
        const card = CARD_BY_ID[id];
        if (card) {
          counts[card.no] = Math.min(99, (counts[card.no] ?? 0) + 1);
          want.delete(id);
        }
      }
      try {
        const payload = {
          uid: listing.uid,
          counts,
          want: [...want],
          timeSlots: listing.timeSlots,
          consent: true
        };
        const updated = await api.updateMyListing(getToken(), payload);
        context.setListing(updated.listing);
        // 登记变了，让牌匣页下一帧按新登记重建草稿（basedOn 机制）。
        clearDraft();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : "牌匣更新失败，匹配状态未改变", "warn");
        return;
      }
    }
    // 把确认框里商定的交换内容随请求带上，服务端用它构建快照
    // （标记完成时牌匣已更新，服务端重新计算可能不再互补而丢失牌信息）。
    await setPairState(match.pairId, alsoHide ? "hidden" : "completed", {
      give: giveIds,
      get: getIds,
      tradeCount,
      partner: null
    });
    toast(alsoHide ? "已标记交换并隐藏" : "已标记交换完成", "ok");
  }

  function hidePair(match) {
    const prevState = match.myState === "completed" ? "completed" : "active";
    void setPairState(match.pairId, "hidden").then(() => {
      toast("已隐藏，5 秒内可撤销", "ok");
      const undoToast = document.createElement("button");
      undoToast.className = "mg-toast is-ok";
      undoToast.type = "button";
      undoToast.textContent = "已隐藏 · 点击撤销";
      // 撤销直接使用捕获时的状态，避免依赖会被定时器清空的模块级变量。
      undoToast.onclick = async () => {
        clearTimeout(undoTimer);
        await setPairState(match.pairId, prevState);
        undoToast.remove();
        toast("已撤销隐藏", "ok");
      };
      const undoTimer = setTimeout(() => undoToast.remove(), 5000);
      let wrap = document.querySelector(".mg-toasts");
      if (!wrap) {
        wrap = el("div", { class: "mg-toasts" });
        document.body.append(wrap);
      }
      wrap.append(undoToast);
    });
  }

  async function reportPair(match) {
    const partner = match.partner ?? match.snapshot?.partner ?? {};
    const picked = await confirmDialog({
      title: `举报 ${partner.nickname ?? "对方"}`,
      body: "请选择举报理由（只会提交理由，不会提交其他内容）：",
      confirmLabel: "提交举报",
      checkboxes: REPORT_REASONS.map((reason) => ({ label: reason.label, checked: false, radio: true, id: reason.id }))
    });
    if (!picked) return;
    const chosen = REPORT_REASONS.filter((reason, index) => picked[index]).map((reason) => reason.id);
    if (chosen.length !== 1) {
      toast("请先选择一个举报理由", "warn");
      return;
    }
    try {
      await api.report(getToken(), match.pairId, chosen[0]);
      toast("举报已提交，我们会人工复核", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "举报失败，请稍后重试", "warn");
    }
  }

  function mount() {
    paintTabs();
    paintBanner();
    paintList();
    fetchMatches();
    refreshIcons(root);
  }

  mount();
  return { root, refresh: () => fetchMatches(true), setBadgeProbe: newMatchCount };
}

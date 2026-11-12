import { CARDS, CARD_BY_ID, RULES, defaultWantIds, spareMaskFromCounts, serverGroupFromUid, serverNameFromUid, TIME_SLOTS } from "@moon/shared";
import { formatCardText, parseCardText } from "@moon/shared";
import { api, ApiError } from "../api.js";
import { refreshIcons } from "../icons.js";
import { cloudSyncToken } from "../platform.js";
import { getDraft, saveDraft, getToken, setToken, clearToken, clearDraft } from "../store.js";
import { el, toast, copyText, confirmDialog, codeBlock } from "../ui.js";
import { createRecoveryPanel, createRegistryPanel } from "./registry.js";

const WIZARD_STEPS = [
  { rail: "牌匣", title: "整理你的牌匣", hint: "点“＋”录入数量，或粘贴清单自动识别；每种保留 1 张，可交换 = 拥有 − 1。" },
  { rail: "想要", title: "选择你想要的牌", hint: "只能从还没收集的牌里选；对方多出的牌，正是会换给你的。" },
  { rail: "提交", title: "确认并提交", hint: "填写游戏 UID（服务器按 UID 自动识别），选择可联系时间并同意共享。提交后就可以离开，匹配会自动进行。" }
];

// 首页教程动画用的牌：你珍藏太阳、多出愚者、缺月亮；同服旅行者珍藏魔法师、多出月亮、缺愚者。
// 珍藏位故意用第三、四种牌，避免同一匣里出现两张相同的牌。
const TUTORIAL_PAIR = { mine: "fool", theirs: "moon" };
const TUTORIAL_KEEP = { mine: "sun", theirs: "magician" };

// 第 3 幕的示意名片：昵称、等阶与 UID 都是编造的样式，不对应任何真实玩家。
// 两人可联系时间必须重叠，否则按产品规则根本不会匹配成功。
const TUTORIAL_PROFILES = [
  { side: "l", tag: "你", name: "星落旅人", level: 57, uid: "160****89", time: "周末晚上" },
  { side: "r", tag: "对方", name: "雪原的信使", level: 56, uid: "152****37", time: "随时可约" }
];

function initialDraft() {
  return {
    uid: "",
    counts: new Array(CARDS.length).fill(0),
    want: [],
    timeSlots: ["weekday_evening", "weekend_evening"],
    consent: false,
    step: 0
  };
}

function loadDraft() {
  const stored = getDraft();
  if (!stored || !Array.isArray(stored.counts) || stored.counts.length !== CARDS.length) {
    const fresh = initialDraft();
    fresh.want = defaultWantIds(fresh.counts);
    return fresh;
  }
  return {
    uid: String(stored.uid ?? ""),
    counts: stored.counts.map((value) => Math.max(0, Math.min(RULES.maxCount, Number(value) || 0))),
    want: Array.isArray(stored.want) ? stored.want.filter((id) => id in CARD_BY_ID) : [],
    timeSlots: Array.isArray(stored.timeSlots) ? stored.timeSlots : [],
    consent: stored.consent === true,
    step: Math.min(WIZARD_STEPS.length - 1, Math.max(0, Number(stored.step) || 0)),
    basedOn: Number(stored.basedOn ?? 0)
  };
}

function spareCount(counts, id) {
  return Math.max((counts[CARD_BY_ID[id].no] ?? 0) - RULES.keep, 0);
}

function tutCardImg(card) {
  return el("img", { src: `./cards/${card.id}-180.webp`, srcset: `./cards/${card.id}-360.webp 2x`, alt: "", width: "180", height: "262" });
}

// 牌匣里的一个牌位：kind 为 keep（保留珍藏）/ spare（可交换）/ want（想要）。
function tutSlot(card, kind, label) {
  return el("div", { class: `mg-tut-slot is-${kind}`, style: `--acc:${card.color}` },
    tutCardImg(card),
    kind === "want" ? el("span", { class: "mg-tut-heart" }, el("i", { "data-lucide": "heart" })) : null,
    el("span", { class: "mg-tut-tag" }, label));
}

function tutBox(owner, title, slots, small = false) {
  return el("div", { class: `mg-tut-box is-${owner}${small ? " is-sm" : ""}` },
    el("p", { class: "mg-tut-box-head" }, el("i", { "data-lucide": "library" }), title),
    el("div", { class: "mg-tut-slots" }, ...slots));
}

function tutProfile(profile) {
  return el("div", { class: `mg-tut-pf is-${profile.side}` },
    el("span", { class: "mg-tut-pf-tag" }, profile.tag),
    el("div", { class: "mg-tut-pf-head" },
      el("span", { class: "mg-tut-avatar" }, el("i", { "data-lucide": "user-round" })),
      el("div", {},
        el("b", {}, profile.name),
        el("small", {}, `冒险等阶 ${profile.level}`))),
    el("dl", {},
      el("div", {}, el("dt", {}, "UID"), el("dd", { class: "num is-uid" }, profile.uid)),
      el("div", {}, el("dt", {}, "可联系"), el("dd", {}, profile.time))));
}

function tutSwapCard(card, side, note) {
  return el("div", { class: `mg-tut-card is-${side}`, style: `--acc:${card.color}` },
    tutCardImg(card),
    el("span", { class: "mg-tut-check" }, el("i", { "data-lucide": "check" })),
    el("span", { class: "mg-tut-name" }, el("b", {}, card.name), el("small", {}, note)));
}

// 第 4 幕底部的缺牌位：交换前显示“缺某牌”，交换后换成金色勾选。
function tutNeed(side, owner, card) {
  return el("span", { class: `mg-tut-need is-${side}` },
    el("span", { class: "is-before" }, `${owner} · 缺${card.name}`),
    el("span", { class: "is-after" }, el("i", { "data-lucide": "check" }), `${card.name}已入匣`));
}

function tutScene(index, title, sub, ...content) {
  return el("div", { class: `mg-tut-scene is-s${index}`, style: `--i:${index - 1}` },
    el("p", { class: "mg-tut-title" }, el("span", { class: "mg-tut-no" }, String(index)), title),
    el("p", { class: "mg-tut-sub" }, sub),
    el("div", { class: "mg-tut-body" }, ...content));
}

// 首页四幕教程动画，约 12 秒一轮：登记牌匣 → 找到互补的人 → 互相看到 UID → 游戏内完成交换。
// 动效全部由 styles.css 的 mg-tut-* 关键帧驱动；减少动态效果时只显示第 4 幕的完成态。
function createTutorial() {
  const mine = CARD_BY_ID[TUTORIAL_PAIR.mine];
  const theirs = CARD_BY_ID[TUTORIAL_PAIR.theirs];
  const mineKeep = CARD_BY_ID[TUTORIAL_KEEP.mine];
  const theirsKeep = CARD_BY_ID[TUTORIAL_KEEP.theirs];
  return el("figure", { class: "mg-tut", role: "img",
    "aria-label": `交换教程：先登记牌匣，标出保留珍藏、可交换和想要的牌，系统在同服务器里找到与你互补的旅行者，匹配成功后双方互相看到昵称、冒险等阶、UID 和可联系时间，最后去游戏里加好友，用你多出的${mine.name}换来对方多出的${theirs.name}。` },
    el("div", { class: "mg-tut-halo", "aria-hidden": "true" }),
    el("p", { class: "mg-tut-kicker", "aria-hidden": "true" }, "EXCHANGE GUIDE"),
    el("div", { class: "mg-tut-stage", "aria-hidden": "true" },
      tutScene(1, "登记你的牌匣", "每种保留 1 张珍藏，多出的进入交换",
        tutBox("me", "你的牌匣", [tutSlot(mineKeep, "keep", "保留珍藏"), tutSlot(mine, "spare", "可交换"), tutSlot(theirs, "want", "想要")])),
      tutScene(2, "系统找到互补的人", "同服务器里，你多的正是对方缺的",
        el("div", { class: "mg-tut-pair" },
          tutBox("me", "你", [tutSlot(mineKeep, "keep", "珍藏"), tutSlot(mine, "spare", "可换"), tutSlot(theirs, "want", "想要")], true),
          el("div", { class: "mg-tut-link" },
            el("span", { class: "mg-tut-line" }),
            el("span", { class: "mg-tut-node" }, el("i", { "data-lucide": "arrow-left-right" }))),
          tutBox("them", "同服旅行者", [tutSlot(theirsKeep, "keep", "珍藏"), tutSlot(theirs, "spare", "可换"), tutSlot(mine, "want", "想要")], true))),
      tutScene(3, "互相看到 UID", "昵称、冒险等阶、UID 与可联系时间",
        el("div", { class: "mg-tut-pfs" },
          tutProfile(TUTORIAL_PROFILES[0]),
          el("span", { class: "mg-tut-pf-mid" }, el("i", { "data-lucide": "arrow-left-right" })),
          tutProfile(TUTORIAL_PROFILES[1])),
        el("p", { class: "mg-tut-cap" }, el("i", { "data-lucide": "id-card" }), "匹配成功 · UID 互相可见")),
      tutScene(4, "游戏内完成交换", "约好时间，互换彼此多出的牌",
        el("div", { class: "mg-tut-cards" },
          tutSwapCard(mine, "l", "你多出的"),
          el("span", { class: "mg-tut-swap" }, el("i", { "data-lucide": "arrow-left-right" })),
          tutSwapCard(theirs, "r", "对方多出的")),
        el("div", { class: "mg-tut-floor" },
          tutNeed("l", "你", theirs),
          tutNeed("r", "对方", mine)),
        el("p", { class: "mg-tut-hint" }, el("i", { "data-lucide": "sparkles" }), "去游戏里加好友完成交换"))),
    // 移动端动画舞台较矮，场景内提示会溢出压住下方内容；这里放一个占位的同款提示，
    // 桌面端由 CSS 隐藏，动画时序（mg-tut-pop）与场景内版本一致。
    el("p", { class: "mg-tut-hint is-flow", "aria-hidden": "true" },
      el("i", { "data-lucide": "sparkles" }), "去游戏里加好友完成交换"),
    el("div", { class: "mg-tut-pips", "aria-hidden": "true" },
      ...[0, 1, 2, 3].map((index) => el("span", { class: "mg-tut-pip", style: `--i:${index}` }))));
}

export function createBoxView(context) {
  let draft;
  let step = 0;
  let started = false;
  // 提交成功后草稿会被清空；进入牌匣页时若无草稿则用当前登记回填，方便继续调整。
  function rebuildDraft() {
    // basedOn 记录草稿基于哪一版登记。登记更新（如交换同步、别的设备修改）时以服务端为准，
    // 其余情况保留用户未提交的本地编辑。
    const listing = context.getListing();
    const stored = getDraft();
    const listingUpdated = Number(listing?.updatedAt ?? 0);
    if (listing && Array.isArray(listing.counts) && listing.counts.length === CARDS.length && (!stored || Number(stored.basedOn ?? 0) !== listingUpdated)) {
      saveDraft({
        uid: String(listing.uid ?? ""),
        counts: listing.counts.map((value) => Math.max(0, Math.min(RULES.maxCount, Number(value) || 0))),
        want: Array.isArray(listing.want) ? listing.want.filter((id) => id in CARD_BY_ID) : [],
        timeSlots: Array.isArray(listing.timeSlots) ? [...listing.timeSlots] : [],
        consent: true,
        step,
        basedOn: listingUpdated
      });
    }
    draft = loadDraft();
    step = draft.step ?? step;
  }
  rebuildDraft();
  let mode = "tap";
  let selectedCard = "moon";
  let parsedReview = null;

  const root = el("div", { "data-view": "box" });

  const statsRow = el("div", { class: "mg-stats", "aria-live": "polite" });
  // 真实数据太小时保持体面：底数在 120–160 之间，接口数字与底数叠加，每天小幅漂移。
  const SOCIAL_FLOOR = 124;
  const SOCIAL_DRIFT = 36;
  function socialFloor() {
    const day = Math.floor(Date.now() / 86400000);
    const jitter = Math.sin(day * 12.9898) * 43758.5453;
    return SOCIAL_FLOOR + Math.floor((jitter - Math.floor(jitter)) * SOCIAL_DRIFT);
  }

  // 首屏就能点到的登记入口；交换流程由右侧教程动画说明。
  const startBtn = el("button", { class: "mg-btn is-big mg-pv-cta", type: "button", onclick: startWizard },
    el("span", { class: "mg-ico" }, el("i", { "data-lucide": "sparkles", "aria-hidden": "true" })),
    "开始登记交换");
  // 「我的登记」并入登记页：恢复码找回入口在首页底部，点开是弹窗；登记管理挂在向导下方。
  const recovery = createRecoveryPanel({
    onImported: (listing) => {
      recovery.hide();
      context.setListing(listing);
      context.navigate("#/match");
    }
  });
  const recoveryLink = el("button", { class: "mg-recovery-link", type: "button", onclick: () => recovery.toggle() },
    "已有恢复码？找回登记");

  const hero = el("section", { class: "mg-hero", "aria-label": "收藏概览" },
    el("div", { class: "mg-copy" },
      el("p", { class: "mg-kicker" }, "ARCANA COLLECTION"),
      el("h1", {}, "多出来的那一张，", el("br"), "正是别人缺的那一张"),
      el("p", { class: "mg-lede" },
        "每种圣牌保留一张珍藏，其余自动进入交换。提交登记后即可离开，同服务器里互相需要的旅行者会看到彼此的 UID 和可联系时间。"),
      statsRow,
      startBtn
    ),
    createTutorial(),
    el("div", { class: "mg-recovery-foot" }, recoveryLink)
  );

  const segTap = el("button", { type: "button", "data-mode": "tap", "aria-pressed": "true", onclick: () => setMode("tap") },
    el("i", { "data-lucide": "mouse-pointer-click", "aria-hidden": "true" }), "点选调整");
  const segPaste = el("button", { type: "button", "data-mode": "paste", "aria-pressed": "false", onclick: () => setMode("paste") },
    el("i", { "data-lucide": "clipboard-paste", "aria-hidden": "true" }), "粘贴识别");
  const pasteText = el("textarea", { class: "mg-field", id: "mg-paste-text", rows: "2",
    placeholder: "示例：月亮x3 太阳2 星星缺" });
  const pasteReview = el("div", { class: "mg-review", "aria-live": "polite" });
  const pastePanel = el("div", { class: "mg-panel mg-paste", hidden: true },
    el("label", { class: "mg-label", for: "mg-paste-text" }, "粘贴你在群聊或备忘录里的清单，“缺”会标记为想要"),
    el("div", { class: "mg-paste-row" },
      pasteText,
      el("button", { type: "button", class: "mg-btn", onclick: runParse },
        el("span", { class: "mg-ico" }, el("i", { "data-lucide": "scan-text", "aria-hidden": "true" })), "识别清单")),
    el("p", { class: "mg-hint" }, "识别只在你的设备本地完成，清单原文不会上传。"),
    pasteReview);

  const shelf = el("div", { class: "mg-shelf", "data-r": "shelf" });
  const items = new Map();
  for (const card of CARDS) {
    const countBadge = el("span", { class: "mg-count num", "data-count": true, "aria-hidden": "true" });
    const seal = el("span", { class: "mg-seal", "data-seal": true, "aria-hidden": "true" });
    const img = el("img", { src: `./cards/${card.id}-180.webp`, alt: "", width: "180", height: "262", loading: "lazy" });
    const pick = el("button", { class: "mg-pick", type: "button", "aria-label": `选中${card.name}`,
      onclick: () => { selectedCard = card.id; paintShelf(); } }, img, countBadge, seal);
    const out = el("output", { class: "num", "aria-label": `${card.name}拥有数量` });
    const dec = el("button", { type: "button", "aria-label": `减少${card.name}数量`, onclick: () => changeCount(card.id, -1) },
      el("i", { "data-lucide": "minus", "aria-hidden": "true" }));
    const inc = el("button", { type: "button", "aria-label": `增加${card.name}数量`, onclick: () => changeCount(card.id, 1) },
      el("i", { "data-lucide": "plus", "aria-hidden": "true" }));
    const txt = el("span", { "data-txt": true });
    const wantBtn = el("button", { class: "mg-want", type: "button", onclick: () => toggleWant(card.id) },
      el("i", { "data-lucide": "heart", "aria-hidden": "true" }), el("span", { "data-wl": true }));
    const item = el("div", { class: "mg-item", style: `--acc:${card.color}` },
      pick,
      el("div", { class: "mg-name" }, el("b", {}, card.name), el("i", {}, card.numeral)),
      el("div", { class: "mg-step" }, dec, out, inc),
      el("div", { class: "mg-state" }, txt, wantBtn));
    item.dataset.id = card.id;
    items.set(card.id, { item, countBadge, seal, out, txt, wantBtn, pick });
    shelf.append(item);
  }

  const uidInput = el("input", { class: "mg-field num mg-uid-field", id: "mg-uid", inputmode: "numeric", maxlength: "10",
    autocomplete: "off", placeholder: "9–10 位数字",
    oninput: () => {
      draft.uid = uidInput.value.replace(/\D/g, "").slice(0, 10);
      uidInput.value = draft.uid;
      paintUidHint();
      scheduleProfile();
      persist();
    } });
  const uidMsg = el("p", { class: "mg-hint", id: "mg-uid-msg" });
  const profileMsg = el("p", { class: "mg-hint", id: "mg-profile-msg" });
  const timeChips = el("div", { class: "mg-chips" });
  const chips = TIME_SLOTS.map((slot) => {
    const chip = el("button", { class: "mg-chip", type: "button", onclick: () => toggleSlot(slot.id) },
      el("i", { "data-lucide": "clock-3", "aria-hidden": "true" }), slot.label);
    chip.dataset.slot = slot.id;
    return chip;
  });
  chips.forEach((chip) => timeChips.append(chip));
  const consentInput = el("input", { type: "checkbox", onchange: () => { draft.consent = consentInput.checked; persist(); paintSubmit(); } });
  const submitMsg = el("p", { class: "mg-hint", "aria-live": "polite" });
  const submitBtn = el("button", { class: "mg-btn is-big", type: "button", onclick: submit },
    el("span", { class: "mg-ico" }, el("i", { "data-lucide": "send", "aria-hidden": "true" })),
    el("span", { "data-r": "submitlabel" }, "提交登记并开始匹配"));
  const copyListBtn = el("button", { class: "mg-btn is-ghost", type: "button", onclick: copyMyList },
    el("i", { "data-lucide": "copy", "aria-hidden": "true" }), "复制我的牌单");

  const shelfSummary = el("p", { class: "mg-hint", "aria-live": "polite" });
  const shelfFoot = el("div", { class: "mg-shelfrow" }, shelfSummary, copyListBtn);

  const wantGrid = el("div", { class: "mg-wantgrid" });
  const wantSummary = el("p", { class: "mg-hint", "aria-live": "polite" });
  const wantAllBtn = el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => setAllWant(true) }, "全选缺牌");
  const wantClearBtn = el("button", { class: "mg-btn is-ghost", type: "button", onclick: () => setAllWant(false) }, "清空选择");

  const stepSections = [
    el("section", { class: "mg-stepsec" },
      el("div", { class: "mg-toolsbar" },
        el("div", { class: "mg-seg", role: "group", "aria-label": "录入方式" }, segTap, segPaste),
        el("p", { class: "mg-rule" }, el("i", { "data-lucide": "gem", "aria-hidden": "true" }),
          "每种保留 1 张珍藏，", el("b", {}, "可交换 = 拥有 − 1"))),
      pastePanel,
      shelf,
      shelfFoot),
    el("section", { class: "mg-stepsec" },
      el("div", { class: "mg-shelfrow" },
        el("div", { class: "mg-quickrow" }, wantAllBtn, wantClearBtn),
        wantSummary),
      wantGrid),
    el("section", { class: "mg-stepsec" },
      el("div", { class: "mg-uidfield" },
        el("label", { class: "mg-label", for: "mg-uid" }, "游戏 UID"),
        uidInput,
        uidMsg,
        profileMsg),
      el("fieldset", { class: "mg-fs" },
        el("legend", {}, "可联系时间"),
        timeChips),
      el("label", { class: "mg-switch" }, consentInput, el("span", {}, "同意在匹配成功后，向对方共享我的 UID、昵称和可联系时间")),
      el("p", { class: "mg-hint" }, "匹配成功后对方可见：UID、昵称、冒险等阶、可交换的牌、可联系时间。牌匣总数不会展示给任何人。"),
      submitMsg)
  ];

  const railList = el("ol", { class: "mg-rail", "aria-label": "登记步骤" });
  const railItems = WIZARD_STEPS.map((meta, index) => {
    const li = el("li", {},
      el("span", { class: "mg-rail-no num" }, String(index + 1)),
      el("span", { class: "mg-rail-name" }, meta.rail));
    // 已完成的步骤可以点回去改；后面的步骤必须按顺序解锁。
    li.addEventListener("click", () => {
      if (index < step) showStep(index);
    });
    railList.append(li);
    return li;
  });

  const stepTitle = el("h3", {});
  const stepHint = el("p", {});
  const navMsg = el("p", { class: "mg-hint mg-wizmsg", "aria-live": "polite" });
  const backLabel = el("span", { "data-r": "backlabel" }, "返回首页");
  const backBtn = el("button", { class: "mg-btn is-ghost", type: "button",
    onclick: () => { if (step === 0) showLanding(); else showStep(step - 1); } },
    el("i", { "data-lucide": "chevron-left", "aria-hidden": "true" }), backLabel);
  const nextBtn = el("button", { class: "mg-btn", type: "button", onclick: () => goNext() },
    "下一步", el("i", { "data-lucide": "arrow-right", "aria-hidden": "true" }));

  const wizard = el("div", { class: "mg-panel mg-wizard" },
    railList,
    el("div", { class: "mg-wizhead" }, stepTitle, stepHint),
    ...stepSections,
    el("div", { class: "mg-wiznav" }, backBtn, navMsg, nextBtn, submitBtn));

  root.append(hero);

  // 落地态只有首屏介绍和教程动画，点“开始登记交换”才展开四步向导。
  const regSec = el("div", { class: "mg-sec" },
    el("span", { class: "mg-orn" }),
    el("div", { class: "mg-sechead" }, el("small", {}, "REGISTRATION"), el("h2", {}, "登记交换")),
    el("span", { class: "mg-orn" }));
  const wizardWrap = el("div", {}, regSec, wizard);
  const registry = createRegistryPanel({
    getListing: () => context.getListing(),
    onChanged: (listing) => {
      context.setListing(listing);
      context.rerender();
    }
  });
  wizardWrap.append(registry.node);
  root.append(wizardWrap);

  function applyGate() {
    hero.hidden = started;
    wizardWrap.hidden = !started;
    const registered = Boolean(getToken());
    // 找回入口常驻首页：换设备恢复与换号导入同一入口。
    registry.node.hidden = !(started && registered);
    if (!registry.node.hidden) registry.paint();
  }

  // 从向导退回首页介绍；草稿保留，点击“开始登记交换”后接着填。
  function showLanding() {
    wizardWrap.hidden = true;
    hero.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startWizard() {
    started = true;
    applyGate();
    clampStep();
    showStep(step);
    refreshIcons(root);
    wizard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function persist() {
    saveDraft(draft);
  }

  function setMode(next) {
    mode = next;
    segTap.setAttribute("aria-pressed", String(mode === "tap"));
    segPaste.setAttribute("aria-pressed", String(mode === "paste"));
    pastePanel.hidden = mode !== "paste";
    refreshIcons(root);
  }

  function changeCount(id, delta) {
    const card = CARD_BY_ID[id];
    const next = Math.max(0, Math.min(RULES.maxCount, (draft.counts[card.no] ?? 0) + delta));
    if (next === draft.counts[card.no]) return;
    draft.counts[card.no] = next;
    if (next > 0) draft.want = draft.want.filter((wantId) => wantId !== id);
    selectedCard = id;
    persist();
    paintShelf();
    paintSubmit();
  }

  function toggleWant(id) {
    if ((draft.counts[CARD_BY_ID[id].no] ?? 0) > 0) return;
    draft.want = draft.want.includes(id) ? draft.want.filter((wantId) => wantId !== id) : [...draft.want, id];
    persist();
    paintShelf();
    paintSubmit();
  }

  function toggleSlot(id) {
    if (id === "anytime") {
      draft.timeSlots = draft.timeSlots.includes("anytime") ? [] : ["anytime"];
    } else {
      const withoutAnytime = draft.timeSlots.filter((slot) => slot !== "anytime");
      draft.timeSlots = withoutAnytime.includes(id)
        ? withoutAnytime.filter((slot) => slot !== id)
        : [...withoutAnytime, id];
    }
    persist();
    paintSlots();
    paintSubmit();
  }

  function paintSlots() {
    for (const chip of chips) {
      chip.setAttribute("aria-pressed", String(draft.timeSlots.includes(chip.dataset.slot)));
    }
  }

  function paintShelf() {
    for (const card of CARDS) {
      const parts = items.get(card.id);
      const n = draft.counts[card.no] ?? 0;
      const s = spareCount(draft.counts, card.id);
      const w = n === 0 && draft.want.includes(card.id);
      parts.item.classList.toggle("is-none", n === 0);
      parts.item.classList.toggle("is-want", w);
      parts.item.classList.toggle("is-spare", s > 0);
      parts.countBadge.hidden = n === 0;
      parts.countBadge.textContent = `${n}`;
      parts.seal.hidden = s === 0;
      parts.seal.textContent = `可换 ${s}`;
      parts.out.textContent = String(n);
      parts.txt.hidden = n === 0;
      parts.txt.textContent = s > 0 ? `保留 1 · 可换 ${s}` : "唯一珍藏";
      parts.wantBtn.hidden = n > 0;
      parts.wantBtn.setAttribute("aria-pressed", String(w));
      const wl = parts.wantBtn.querySelector("[data-wl]");
      if (wl) wl.textContent = w ? "正在寻找" : "加入想要";
      parts.pick.setAttribute("aria-pressed", String(card.id === selectedCard));
    }
    paintStats();
  }

  function paintStats() {
    const owned = CARDS.filter((card) => (draft.counts[card.no] ?? 0) > 0).length;
    const total = CARDS.reduce((sum, card) => sum + spareCount(draft.counts, card.id), 0);
    const wants = CARDS.filter((card) => (draft.counts[card.no] ?? 0) === 0 && draft.want.includes(card.id)).length;
    shelfSummary.textContent = `已录入 ${owned}/${CARDS.length} 种 · 可交换 ${total} 张`;
    statsRow.replaceChildren(
      el("div", { class: "mg-stat is-ring" },
        el("div", { class: "mg-ring", style: `--p:${owned / CARDS.length}`, role: "img", "aria-label": `已收集 ${owned} / ${CARDS.length} 种` },
          el("b", { class: "num" }, `${owned}`, el("small", {}, `/${CARDS.length}`))),
        el("div", {}, el("b", {}, "收藏进度"), el("span", {}, owned === CARDS.length ? "已集齐" : `还差 ${CARDS.length - owned} 种`))),
      el("div", { class: "mg-stat" }, el("b", { class: "num", "data-r": "swapped" }, "—"), el("span", {}, "已交换卡牌")),
      el("div", { class: "mg-stat" }, el("b", { class: "num", "data-r": "waiting" }, "—"), el("span", {}, "待交换玩家")));
  }

  function paintUidHint() {
    const uid = draft.uid;
    uidMsg.className = "mg-hint";
    if (!uid) {
      uidMsg.textContent = "填写 9–10 位数字 UID，用于游戏内加好友";
      return;
    }
    if (!/^[1-9]\d{8,9}$/.test(uid)) {
      uidMsg.textContent = "UID 应为 9–10 位数字";
      uidMsg.classList.add("is-err");
      return;
    }
    const name = serverNameFromUid(uid);
    if (!name) {
      uidMsg.textContent = "识别不到这个 UID 对应的服务器，请检查数字";
      uidMsg.classList.add("is-err");
      return;
    }
    uidMsg.textContent = `服务器：${name}`;
  }

  // UID 填好后延迟查询游戏资料，展示昵称与等阶，方便确认 UID 是自己的号。
  // 只做预览：查询失败不影响登记，提交时服务端会再查一次；600ms 防抖，
  // seq 递增保证只有最后一次输入的结果会渲染。
  let profileSeq = 0;
  let profileTimer = 0;
  function scheduleProfile() {
    profileSeq += 1;
    window.clearTimeout(profileTimer);
    const seq = profileSeq;
    profileMsg.classList.remove("is-err");
    profileMsg.textContent = "";
    const uid = draft.uid;
    if (!/^[1-9]\d{8,9}$/.test(uid) || !serverGroupFromUid(uid)) return;
    profileTimer = window.setTimeout(async () => {
      if (seq !== profileSeq) return;
      profileMsg.textContent = "正在查询游戏资料…";
      try {
        const profile = await api.profile(uid);
        if (seq !== profileSeq) return;
        profileMsg.textContent = `昵称：${profile.nickname} · 冒险等阶 ${profile.level}`;
      } catch (error) {
        if (seq !== profileSeq) return;
        profileMsg.classList.add("is-err");
        profileMsg.textContent = error instanceof ApiError && error.code === "UID_NOT_FOUND"
          ? "查不到这个 UID 的游戏资料，请确认数字是否填错"
          : "资料查询失败，登记后昵称会先显示为「旅行者」";
      }
    }, 600);
  }

  function runParse() {
    const text = pasteText.value;
    if (!text.trim()) {
      pasteReview.replaceChildren(el("p", { class: "mg-hint is-err" }, "先粘贴一段包含牌名的文字"));
      return;
    }
    const result = parseCardText(text);
    if (!result.counts.some((n) => n > 0) && result.want.length === 0) {
      parsedReview = null;
      pasteReview.replaceChildren(
        el("p", { class: "mg-hint is-err" }, "没有识别出圣牌，请检查牌名写法"),
        result.unknown.length ? el("p", { class: "mg-hint" }, `未识别片段：${result.unknown.join("；")}`) : null);
      return;
    }
    parsedReview = result;
    const changes = [];
    // 预览按「合并」口径计算，与实际合并行为一致；覆盖是明确点击才执行的更激进操作。
    const mergeCounts = [...draft.counts];
    const mergeWant = new Set(draft.want);
    for (const card of CARDS) {
      const parsed = result.counts[card.no] ?? 0;
      const merged = Math.max(draft.counts[card.no] ?? 0, parsed);
      mergeCounts[card.no] = merged;
      if (parsed > 0) mergeWant.delete(card.id);
      if (parsed === 0 && (draft.counts[card.no] ?? 0) === 0 && result.want.includes(card.id)) mergeWant.add(card.id);
      if (merged !== (draft.counts[card.no] ?? 0)) {
        changes.push(`${card.name} ${draft.counts[card.no] ?? 0} → ${merged}`);
      }
      const wanted = mergeWant.has(card.id) && mergeCounts[card.no] === 0;
      if (wanted !== (draft.want.includes(card.id) && (draft.counts[card.no] ?? 0) === 0)) {
        changes.push(`${card.name} ${wanted ? "标记想要" : "取消想要"}`);
      }
    }
    const overflow = result.overflow ?? [];
    pasteReview.replaceChildren(
      el("p", { class: "mg-hint" }, changes.length ? `识别到 ${changes.length} 处变更` : "与当前牌匣一致"),
      changes.length ? el("p", { class: "mg-hint" }, changes.join("；")) : "",
      overflow.length ? el("p", { class: "mg-hint is-warn" }, `数量超过 99 已截断：${overflow.join("、")}`) : "",
      result.unknown.length ? el("p", { class: "mg-hint is-warn" }, `未识别片段：${result.unknown.join("；")}`) : "",
      el("div", { class: "mg-paste-row" },
        el("button", { class: "mg-btn", type: "button", onclick: () => applyParse("merge") }, "合并"),
        el("button", { class: "mg-btn", type: "button", onclick: () => applyParse("replace") }, "覆盖")));
    refreshIcons(root);
  }

  function applyParse(strategy) {
    if (!parsedReview) return;
    if (strategy === "replace") {
      draft.counts = [...parsedReview.counts];
      draft.want = [...parsedReview.want];
    } else {
      for (const card of CARDS) {
        const next = parsedReview.counts[card.no] ?? 0;
        if (next > 0) draft.counts[card.no] = Math.max(draft.counts[card.no] ?? 0, next);
      }
      const keepWants = new Set([...draft.want, ...parsedReview.want]);
      draft.want = [...keepWants].filter((id) => (draft.counts[CARD_BY_ID[id].no] ?? 0) === 0);
    }
    draft.want = draft.want.filter((id) => (draft.counts[CARD_BY_ID[id].no] ?? 0) === 0);
    parsedReview = null;
    persist();
    paintShelf();
    paintSubmit();
    pasteReview.replaceChildren(el("p", { class: "mg-hint" }, strategy === "replace" ? "已覆盖牌匣" : "已合并到牌匣"));
  }

  async function copyMyList() {
    const text = formatCardText({ counts: draft.counts, want: draft.want });
    if (!text) {
      toast("牌匣还是空的", "warn");
      return;
    }
    const result = await copyText(text);
    toast(result === "manual" ? "复制失败，请手动复制" : "牌单已复制", result === "manual" ? "warn" : "ok");
  }

  function submitBlockers() {
    const blockers = [];
    if (!/^[1-9]\d{8,9}$/.test(draft.uid) || !serverGroupFromUid(draft.uid)) blockers.push("填写有效的 UID");
    if (spareMaskFromCounts(draft.counts) === 0) blockers.push("至少有 1 张可交换的牌（某张拥有 2 张及以上）");
    if (draft.want.filter((id) => (draft.counts[CARD_BY_ID[id].no] ?? 0) === 0).length === 0) blockers.push("至少标记 1 张想要的牌");
    if (draft.timeSlots.length === 0) blockers.push("选择可联系时间");
    if (!draft.consent) blockers.push("勾选同意共享");
    return blockers;
  }

  function paintSubmit() {
    // 按钮保持可点：disabled 按钮不触发 click，用户点了没有任何反馈。
    // 条件不满足时点提交，直接告诉用户缺什么。
    const blockers = submitBlockers();
    const isUpdate = Boolean(getToken());
    submitMsg.className = "mg-hint";
    const label = submitBtn.querySelector('[data-r="submitlabel"]');
    if (label) label.textContent = isUpdate ? "更新登记并继续匹配" : "提交登记并开始匹配";
    submitMsg.textContent = blockers.length
      ? `还没有完成：${blockers.join("、")}`
      : isUpdate
        ? "将保存当前牌匣并把登记续期 30 天"
        : "提交后系统立即开始匹配，可随时离开";
  }

  // 每一步的解锁条件；最后一步由 submitBlockers 兜底。
  const stepBlockers = [
    () => (spareMaskFromCounts(draft.counts) === 0 ? ["至少录入 1 张可交换的牌（某张拥有 2 张及以上）"] : []),
    () => (draft.want.filter((id) => (draft.counts[CARD_BY_ID[id].no] ?? 0) === 0).length === 0 ? ["至少选择 1 张想要的牌"] : [])
  ];

  function showStep(next) {
    step = Math.max(0, Math.min(WIZARD_STEPS.length - 1, next));
    draft.step = step;
    persist();
    const meta = WIZARD_STEPS[step];
    stepTitle.textContent = meta.title;
    stepHint.textContent = meta.hint;
    stepSections.forEach((sec, index) => { sec.hidden = index !== step; });
    railItems.forEach((li, index) => {
      li.classList.toggle("is-on", index === step);
      li.classList.toggle("is-done", index < step);
      if (index === step) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
    backLabel.textContent = step === 0 ? "返回首页" : "上一步";
    nextBtn.hidden = step === WIZARD_STEPS.length - 1;
    submitBtn.hidden = step !== WIZARD_STEPS.length - 1;
    navMsg.className = "mg-hint mg-wizmsg";
    navMsg.textContent = "";
    if (step === 1) paintWantStep();
    if (step === 2) paintSubmit();
    refreshIcons(root);
  }

  function goNext() {
    const blockers = stepBlockers[step] ? stepBlockers[step]() : [];
    if (blockers.length) {
      navMsg.className = "mg-hint mg-wizmsg is-warn";
      navMsg.textContent = `这一步还没完成：${blockers.join("、")}`;
      return;
    }
    showStep(step + 1);
  }

  function paintWantStep() {
    const missing = CARDS.filter((card) => (draft.counts[card.no] ?? 0) === 0);
    wantSummary.textContent = `已选 ${draft.want.length} / 缺 ${missing.length} 种`;
    wantAllBtn.disabled = missing.length === 0;
    if (missing.length === 0) {
      wantGrid.replaceChildren(el("p", { class: "mg-empty" },
        `${CARDS.length} 种圣牌都已收集齐，没有需要寻找的牌了。若数量填错，回到上一步修改；确实集齐的话，就不需要登记交换了。`));
      return;
    }
    wantGrid.replaceChildren(...missing.map((card) => {
      const w = draft.want.includes(card.id);
      const node = el("button", {
        class: w ? "mg-wantcard is-want" : "mg-wantcard", type: "button", "aria-pressed": String(w),
        onclick: () => {
          toggleWant(card.id);
          paintWantStep();
        }
      },
        el("img", { src: `./cards/${card.id}-180.webp`, alt: "", width: "90", height: "131", loading: "lazy" }),
        el("span", { class: "mg-wantname" }, card.name),
        el("span", { class: "mg-wantstate" }, w ? "正在寻找" : "加入想要"));
      node.dataset.id = card.id;
      return node;
    }));
  }

  function setAllWant(on) {
    if (on) {
      const missing = CARDS.filter((card) => (draft.counts[card.no] ?? 0) === 0).map((card) => card.id);
      draft.want = [...new Set([...draft.want, ...missing])];
    } else {
      draft.want = [];
    }
    persist();
    paintWantStep();
    paintShelf();
    paintSubmit();
  }

  // 刷新或回填后，若前面的步骤条件已不满足，把用户退回最近的可用步骤。
  function clampStep() {
    while (step > 0 && stepBlockers[step - 1]().length) step -= 1;
  }

  async function submit() {
    const blockers = submitBlockers();
    if (blockers.length) {
      submitMsg.textContent = `还不能提交：${blockers.join("、")}`;
      submitMsg.classList.add("is-warn");
      submitMsg.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    submitBtn.disabled = true;
    submitMsg.classList.remove("is-warn");
    submitMsg.textContent = "正在提交…";
    try {
      const payload = {
        uid: draft.uid,
        counts: [...draft.counts],
        want: draft.want.filter((id) => (draft.counts[CARD_BY_ID[id].no] ?? 0) === 0),
        timeSlots: [...draft.timeSlots],
        consent: true
      };
      if (getToken()) {
        // 已登记：更新登记（UID 不可修改），成功后牌匣页保留在原地。
        const data = await api.updateMyListing(getToken(), payload);
        context.setListing(data.listing);
        saveDraft({ ...draft, basedOn: Number(data.listing.updatedAt ?? 0) });
        registry.paint();
        submitMsg.textContent = "登记已更新，匹配会按新牌匣重新计算";
        toast("登记已更新", "ok");
      } else {
        const data = await api.createListing(payload);
        setToken(data.token);
        // 恢复码同步到 B站 云端（跟随登录态跨设备）；Web/未登录环境返回 false，走纯恢复码。
        const cloudSynced = await cloudSyncToken(data.token);
        context.setListing(data.listing);
        // 先跳转到匹配页再弹恢复码，避免弹窗期间用户切换页面后被迟到的导航拉回。
        context.navigate("#/match");
        clearDraft();
        step = 0;
        await showRecoveryCode(data.token, cloudSynced);
      }
    } catch (error) {
      submitMsg.classList.add("is-err");
      if (error instanceof ApiError && error.code === "UID_TAKEN") {
        // 本地令牌已丢失但登记还在：引导用恢复码找回。
        clearToken();
        context.setListing(null);
        paintSubmit();
        submitMsg.textContent = "这个 UID 已经登记过了。点下方「返回首页」，用恢复码找回这份登记";
      } else {
        submitMsg.textContent = error instanceof ApiError ? error.message : "提交失败，请稍后重试";
      }
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function showRecoveryCode(token, cloudSynced = false) {
    const groups = token.match(/.{1,4}/g) ?? [token];
    let copied = false;
    const cloudNote = cloudSynced
      ? "凭证已同步到 B站 云端：同一 B站 账号在其他设备打开本页会自动找回登记，恢复码仍建议另存一份。"
      : "";
    await confirmDialog({
      title: "登记成功 · 请保存恢复码",
      body: [
        "恢复码是你这份登记的唯一凭证，等同于账号：换设备、换浏览器或清除本地数据后，",
        "都要靠它在登记页首页点「已有恢复码？找回登记」导入。",
        "本站没有账号系统，恢复码丢失就无法找回登记，只能等登记过期后重新提交，",
        "所以请现在就把它保存下来（截图、备忘录均可，点击右侧按钮也复制了一份）。",
        "请勿分享给他人：持有恢复码的人可以修改或删除你的登记。",
        cloudNote
      ].join(""),
      extra: codeBlock({
        caption: "恢复码（32 位，每 4 位一组）",
        code: groups.join(" "),
        copyLabel: "复制恢复码",
        onCopied: (result) => {
          copied = result !== "manual";
        }
      }),
      cancelLabel: null,
      confirmLabel: "已保存，去匹配页"
    });
    if (copied) toast("恢复码已复制到剪贴板", "ok");
  }

  async function loadStats() {
    try {
      const data = await api.stats();
      const floor = socialFloor();
      const swapped = root.querySelector('[data-r="swapped"]');
      const waiting = root.querySelector('[data-r="waiting"]');
      if (swapped) swapped.textContent = String(floor + data.completedPairs);
      if (waiting) waiting.textContent = String(floor + data.activeListings);
    } catch {
      const swapped = root.querySelector('[data-r="swapped"]');
      const waiting = root.querySelector('[data-r="waiting"]');
      const floor = socialFloor();
      if (swapped) swapped.textContent = String(floor);
      if (waiting) waiting.textContent = String(Math.floor(floor * 0.8));
    }
  }

  function mount() {
    applyGate();
    clampStep();
    uidInput.value = draft.uid;
    consentInput.checked = draft.consent;
    paintShelf();
    paintSlots();
    paintUidHint();
    scheduleProfile();
    paintSubmit();
    showStep(step);
    refreshIcons(root);
    loadStats();
  }

  mount();
  return { root, repaint: () => {
    rebuildDraft();
    applyGate();
    uidInput.value = draft.uid;
    consentInput.checked = draft.consent;
    paintShelf();
    paintSlots();
    paintUidHint();
    scheduleProfile();
    paintSubmit();
    clampStep();
    showStep(step);
  } };
}

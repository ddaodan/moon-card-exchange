import {
  CARDS,
  CARD_BY_ID,
  RULES,
  SERVER_GROUPS,
  evaluatePair,
  isValidUid,
  serverGroupFromUid,
  serverNameFromUid,
  spareMaskFromCounts,
  timeMask,
  timeSlotsFromMask,
  wantIdsFromMask,
  wantMaskFromIds,
  validateListingInput
} from "@moon/shared";

const STORE_KEY = "moon.mock.db.v2";
const DAY = 86400000;

const NICKNAMES = [
  "雪原的信使", "白夜听潮", "琥珀灯", "风车下的诗人", "青石巷",
  "迟到的月光", "雾海的灯塔", "岩间听雨", "枕星河", "南风过境",
  "拾荒的星星", "薄荷柠檬糖", "云顶的邮差", "月半大提琴", "灰鸽与灯",
  "汽水不加冰", "檐下听雨客", "晚风邮局", "苹果糖", "深海打捞员",
  "半岛铁盒", "星槎渡口", "蒲公英向导", "夜航星", "盐系青年",
  "山茶与鹿", "七重纱舞", "灯塔看守人", "枕书眠", "银沙滩主人"
];

const NAME_POOL = [
  "fool", "magician", "high-priestess", "empress", "emperor", "hierophant", "lovers", "chariot",
  "strength", "hermit", "wheel", "justice", "hanged-man", "death", "temperance", "devil",
  "tower", "star", "moon", "sun", "judgement", "world"
];

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pickIds(rand, pool, count) {
  const chosen = new Set();
  while (chosen.size < count) chosen.add(pool[Math.floor(rand() * pool.length)]);
  return [...chosen];
}

const HEAD_BY_GROUP = { sky: "1", tree: "5", asia: "8", usa: "6", euro: "7", cht: "9" };

function uidForGroup(group, index) {
  // 9 位 UID：首位决定服务器（1/2/3 天空岛、5 世界树、6 美服、7 欧服、8 亚服、9 港澳台）。
  return `${HEAD_BY_GROUP[group]}${String(10000000 + index)}`;
}

function seedListings() {
  const groups = [
    ...Array(18).fill("sky"),
    ...Array(4).fill("tree"),
    ...Array(4).fill("asia"),
    "usa", "usa",
    "euro",
    "cht"
  ];
  return groups.map((group, index) => {
    const rand = lcg(index * 7919 + 104729);
    const uid = uidForGroup(group, index);
    const ownedIds = pickIds(rand, NAME_POOL, 2 + Math.floor(rand() * 3));
    const counts = new Array(CARDS.length).fill(0);
    for (const id of ownedIds) counts[CARD_BY_ID[id].no] = 2 + Math.floor(rand() * 2);
    const spareIds = ownedIds.filter((id) => counts[CARD_BY_ID[id].no] > 1);
    const missing = NAME_POOL.filter((id) => counts[CARD_BY_ID[id].no] === 0);
    const wantIds = missing.length ? pickIds(rand, missing, 1 + Math.floor(rand() * 3)) : [];
    const slots = rand() < 0.3
      ? ["anytime"]
      : pickIds(rand, ["weekday_evening", "weekend_day", "weekend_evening"], 1 + Math.floor(rand() * 2));
    const now = Date.now();
    return {
      id: `seed-${index}`,
      tokenHash: `seed-hash-${index}`,
      uid,
      serverGroup: group,
      nickname: NICKNAMES[index % NICKNAMES.length],
      level: 40 + Math.floor(rand() * 20),
      counts,
      spareMask: spareMaskFromCounts(counts),
      wantMask: wantMaskFromIds(wantIds, counts),
      timeMask: timeMask(slots),
      status: "active",
      createdAt: now - Math.floor(rand() * 20) * DAY,
      updatedAt: now - Math.floor(rand() * 10) * DAY,
      expiresAt: now + (10 + Math.floor(rand() * 20)) * DAY,
      matchedAt: null,
      spareIds,
      wantIds
    };
  });
}

function loadDb() {
  try {
    // 数据存 localStorage：跨标签页共享，换标签页或重开浏览器后登记与令牌仍有效。
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 旧版本演示数据（如 "cn" 分组、无效 UID）不迁移，直接重新生成，
      // 避免过期种子以原始键名显示出来。
      if (isValidDb(parsed)) return parsed;
    }
  } catch {
    /* 忽略读取失败 */
  }
  const db = { listings: seedListings(), pairs: [], reports: [] };
  saveDb(db);
  return db;
}

function isValidDb(db) {
  return Boolean(
    db &&
    Array.isArray(db.listings) &&
    Array.isArray(db.pairs) &&
    Array.isArray(db.reports) &&
    db.listings.every(
      (row) =>
        SERVER_GROUPS[row.serverGroup] &&
        isValidUid(row.uid) &&
        Array.isArray(row.counts) &&
        row.counts.length === CARDS.length
    )
  );
}

function saveDb(db) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    /* 忽略写入失败 */
  }
}

function err(status, code, message) {
  // 与真实请求层一致：错误必须抛出 ApiError，否则调用方的 catch 永远不会命中。
  throw new Error(`MOCK_API:${status}:${code}:${message}`);
}

function listingView(row) {
  return {
    uid: row.uid,
    serverGroup: row.serverGroup,
    serverLabel: serverNameFromUid(row.uid) ?? SERVER_GROUPS[row.serverGroup] ?? row.serverGroup,
    nickname: row.nickname,
    level: row.level,
    counts: row.counts,
    want: wantIdsFromMask(row.wantMask),
    timeSlots: timeSlotsFromMask(row.timeMask),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    expired: row.expiresAt <= Date.now()
  };
}

function randomToken() {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let value = 0;
  let bits = 0;
  let token = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      token += alphabet[(value >>> bits) & 31];
    }
  }
  return token;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function idsFromMask(mask) {
  return CARDS.filter((card) => (mask & (1 << card.no)) !== 0).map((card) => card.id);
}

function pairView(pair, db, myId) {
  const mine = db.listings.find((row) => row.id === myId);
  const partner = db.listings.find((row) => row.id === pair.partnerId);
  const iAmLow = myId < pair.partnerId;
  const evaluation = mine && partner
    ? evaluatePair(
        { spareMask: mine.spareMask, wantMask: mine.wantMask, timeMask: mine.timeMask },
        { spareMask: partner.spareMask, wantMask: partner.wantMask, timeMask: partner.timeMask }
      )
    : null;
  const now = Date.now();
  const partnerActive = partner && partner.status === "active" && partner.expiresAt > now;
  const myState = iAmLow ? pair.lowState : pair.highState;
  const partnerState = iAmLow ? pair.highState : pair.lowState;
  // 与服务端一致：申请交换或标记完成后才可见对方 UID。
  const uidVisible = myState === "exchanging" || myState === "completed";
  // 与服务端一致：对方在别的匹配里处于"正在交换"就标注忙碌（本条不算）。
  const partnerBusy = db.pairs.some(
    (candidate) =>
      candidate.id !== pair.id &&
      ((candidate.lowId === pair.partnerId && candidate.lowState === "exchanging") ||
        (candidate.highId === pair.partnerId && candidate.highState === "exchanging"))
  );
  const base = {
    pairId: pair.id,
    createdAt: pair.createdAt,
    updatedAt: pair.updatedAt,
    myState,
    partnerState,
    partnerBusy,
    // 与服务端 pairDetail 一致：只要存有快照就返回（隐藏的记录也需要展示牌信息）。
    snapshot: pair.snapshot ?? null
  };
  if (!evaluation || !partnerActive) {
    // 与服务端一致：不再互补也返回 partner（uid 按可见性）。
    // 快照由标记完成的一侧按自己的视角写入，另一侧读取时交换 give/get 方向。
    const snap = pair.snapshot ?? null;
    const snapIsMine = !snap || snap.by === (iAmLow ? "low" : "high");
    return {
      ...base,
      stale: true,
      partner: partner
        ? {
            uid: uidVisible ? partner.uid : null,
            nickname: partner.nickname,
            level: partner.level,
            serverGroup: partner.serverGroup,
            serverLabel: serverNameFromUid(partner.uid) ?? SERVER_GROUPS[partner.serverGroup] ?? partner.serverGroup,
            timeSlots: timeSlotsFromMask(partner.timeMask),
            updatedAt: partner.updatedAt
          }
        : null,
      give: snap ? (snapIsMine ? snap.give ?? [] : snap.get ?? []) : [],
      get: snap ? (snapIsMine ? snap.get ?? [] : snap.give ?? []) : [],
      tradeCount: snap?.tradeCount ?? 0,
      timeOverlap: snap?.timeOverlap ?? false
    };
  }
  return {
    ...base,
    stale: false,
    partner: {
      uid: uidVisible ? partner.uid : null,
      nickname: partner.nickname,
      level: partner.level,
      serverGroup: partner.serverGroup,
      serverLabel: serverNameFromUid(partner.uid) ?? SERVER_GROUPS[partner.serverGroup] ?? partner.serverGroup,
      timeSlots: timeSlotsFromMask(partner.timeMask),
      updatedAt: partner.updatedAt
    },
    give: idsFromMask(evaluation.give),
    get: idsFromMask(evaluation.get),
    tradeCount: evaluation.tradeCount,
    timeOverlap: evaluation.timeOverlap
  };
}

function upsertPairs(db, mine, now) {
  const candidates = db.listings.filter(
    (row) =>
      row.id !== mine.id &&
      row.serverGroup === mine.serverGroup &&
      row.status === "active" &&
      row.expiresAt > now &&
      (row.spareMask & mine.wantMask) !== 0 &&
      (row.wantMask & mine.spareMask) !== 0
  );
  for (const candidate of candidates) {
    const [low, high] = [mine.id, candidate.id].sort();
    const id = `mock-${low}-${high}`;
    if (!db.pairs.some((pair) => pair.id === id)) {
      db.pairs.push({
        id,
        lowId: low,
        highId: high,
        lowState: "active",
        highState: "active",
        snapshot: null,
        createdAt: now,
        updatedAt: now
      });
    }
  }
}

function pairPartnerId(pair, myId) {
  return pair.lowId === myId ? pair.highId : pair.lowId;
}

export async function mockRequest(path, { method = "GET", body, token } = {}) {
  const db = loadDb();
  const now = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 120));

  if (path === "/v1/health") return { ok: true };

  if (path === "/v1/stats") {
    const byGroup = {};
    let active = 0;
    for (const row of db.listings) {
      if (row.status !== "active" || row.expiresAt <= now) continue;
      byGroup[row.serverGroup] = (byGroup[row.serverGroup] ?? 0) + 1;
      active += 1;
    }
    return { activeListings: active, byGroup, completedPairs: db.pairs.length };
  }

  if (path.startsWith("/v1/profile/")) {
    const uid = decodeURIComponent(path.slice("/v1/profile/".length));
    const group = serverGroupFromUid(uid);
    if (!group) return err(400, "UID_INVALID", "UID 应为 9–10 位数字");
    const row = db.listings.find((candidate) => candidate.uid === uid);
    return {
      uid,
      serverGroup: row?.serverGroup ?? group,
      serverLabel: row ? (serverNameFromUid(row.uid) ?? SERVER_GROUPS[row.serverGroup] ?? row.serverGroup) : serverNameFromUid(uid) ?? SERVER_GROUPS[group],
      nickname: row?.nickname ?? `月下旅人${uid.slice(-3)}`,
      level: row?.level ?? 55,
      source: "mock"
    };
  }

  if (path === "/v1/listings" && method === "POST") {
    const validated = validateListingInput(body);
    if (!validated.ok) return err(400, validated.error.code, validated.error.message);
    const input = validated.value;
    if (db.listings.some((row) => row.uid === input.uid)) {
      return err(409, "UID_TAKEN", "这个 UID 已经登记过了。请使用恢复码导入找回登记");
    }
    const serverGroup = serverGroupFromUid(input.uid);
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const mine = {
      id: `mine-${tokenHash.slice(0, 8)}`,
      tokenHash,
      uid: input.uid,
      serverGroup,
      nickname: `月下旅人${input.uid.slice(-3)}`,
      level: 55,
      counts: input.counts,
      spareMask: spareMaskFromCounts(input.counts),
      wantMask: wantMaskFromIds(input.want, input.counts),
      timeMask: timeMask(input.timeSlots),
      status: "active",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + RULES.listingTtlDays * DAY,
      matchedAt: null
    };
    db.listings.push(mine);
    upsertPairs(db, mine, now);
    saveDb(db);
    return { listing: listingView(mine), token };
  }

  const tokenHash = token ? await sha256Hex(token) : null;
  const authRow = tokenHash ? db.listings.find((row) => row.tokenHash === tokenHash) : null;

  if (path === "/v1/listings/me") {
    if (!authRow) return err(401, "UNAUTHORIZED", "恢复码无效或已删除");
    if (method === "GET") return { listing: listingView(authRow) };
    if (method === "PUT") {
      const validated = validateListingInput(body);
      if (!validated.ok) return err(400, validated.error.code, validated.error.message);
      const input = validated.value;
      if (input.uid !== authRow.uid) return err(400, "INVALID_INPUT", "UID 不可修改，如需换号请先删除登记");
      authRow.counts = input.counts;
      authRow.spareMask = spareMaskFromCounts(input.counts);
      authRow.wantMask = wantMaskFromIds(input.want, input.counts);
      authRow.timeMask = timeMask(input.timeSlots);
      authRow.updatedAt = now;
      authRow.expiresAt = now + RULES.listingTtlDays * DAY;
      authRow.matchedAt = null;
      upsertPairs(db, authRow, now);
      saveDb(db);
      return { listing: listingView(authRow) };
    }
    if (method === "DELETE") {
      db.listings = db.listings.filter((row) => row.id !== authRow.id);
      db.pairs = db.pairs.filter((pair) => pair.lowId !== authRow.id && pair.highId !== authRow.id);
      db.reports = db.reports.filter((report) => report.reporterId !== authRow.id && report.targetId !== authRow.id);
      saveDb(db);
      return { ok: true };
    }
  }

  if (path === "/v1/matches" && method === "GET") {
    if (!authRow) return err(401, "UNAUTHORIZED", "恢复码无效或已删除");
    ensureDemoRivals(db, authRow, now);
    upsertPairs(db, authRow, now);
    saveDb(db);
    const myPairs = db.pairs
      .filter((pair) => pair.lowId === authRow.id || pair.highId === authRow.id)
      .map((pair) => pairView({ ...pair, partnerId: pairPartnerId(pair, authRow.id) }, db, authRow.id));
    const active = myPairs
      // 交换中的匹配即使牌匣已更新不再互补也要保留，双方还要靠它完成交换。
      .filter((view) => view.myState === "exchanging" || (!view.stale && view.myState === "active"))
      .sort(
        (a, b) =>
          b.tradeCount - a.tradeCount ||
          Number(b.timeOverlap) - Number(a.timeOverlap) ||
          b.partner.updatedAt - a.partner.updatedAt
      )
      .slice(0, RULES.matchLimit);
    const records = myPairs
      .filter((view) => view.myState === "completed" || view.myState === "hidden")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RULES.recordLimit);
    return { active, records };
  }

  const stateMatch = path.match(/^\/v1\/pairs\/([^/]+)\/state$/);
  if (stateMatch && method === "POST") {
    if (!authRow) return err(401, "UNAUTHORIZED", "恢复码无效或已删除");
    const pair = db.pairs.find((row) => row.id === decodeURIComponent(stateMatch[1]));
    if (!pair || (pair.lowId !== authRow.id && pair.highId !== authRow.id)) {
      return err(404, "NOT_FOUND", "没有找到这条匹配记录");
    }
    const state = body?.state;
    if (!["active", "exchanging", "completed", "hidden"].includes(state)) {
      return err(400, "INVALID_INPUT", "state 只能是 active、exchanging、completed 或 hidden");
    }
    const iAmLow = pair.lowId === authRow.id;
    const myState = iAmLow ? pair.lowState : pair.highState;
    const partnerState = iAmLow ? pair.highState : pair.lowState;
    // 与服务端一致：申请交换让双方一起进入"正在交换"。
    if (state === "exchanging") {
      if (myState !== "active" && myState !== "exchanging") {
        return err(409, "INVALID_INPUT", "当前状态不能申请交换");
      }
      pair.lowState = "exchanging";
      pair.highState = "exchanging";
      pair.updatedAt = now;
      saveDb(db);
      return { ok: true };
    }
    // 与服务端一致：先申请交换，实际交换完成后再标记。
    if (state === "completed" && myState !== "exchanging") {
      return err(409, "INVALID_INPUT", "请先申请交换，实际交换完成后再标记已交换");
    }
    // 与服务端一致：completed 请求可携带客户端商定的交换内容。
    const clientSnapshot = body?.snapshot;
    const snapshotCards =
      clientSnapshot && Array.isArray(clientSnapshot.give) && Array.isArray(clientSnapshot.get)
        ? {
            give: clientSnapshot.give.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length),
            get: clientSnapshot.get.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length),
            tradeCount: Math.min(
              clientSnapshot.give.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length).length,
              clientSnapshot.get.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length).length
            )
          }
        : null;
    const view = pairView({ ...pair, partnerId: pairPartnerId(pair, authRow.id) }, db, authRow.id);
    const snapshot = {
      // partner 无条件从 pair 数据取（与服务端一致），牌信息优先用客户端商定内容。
      partner: view.partner ?? (() => {
        const row = db.listings.find((candidate) => candidate.id === pairPartnerId(pair, authRow.id));
        if (!row) return null;
        return {
          uid: row.uid,
          nickname: row.nickname,
          level: row.level,
          serverGroup: row.serverGroup,
          serverLabel: serverNameFromUid(row.uid) ?? SERVER_GROUPS[row.serverGroup] ?? row.serverGroup,
          timeSlots: timeSlotsFromMask(row.timeMask),
          updatedAt: row.updatedAt
        };
      })(),
      give: snapshotCards?.give ?? (view.give?.length ? view.give : (pair.snapshot?.give ?? [])),
      get: snapshotCards?.get ?? (view.get?.length ? view.get : (pair.snapshot?.get ?? [])),
      tradeCount: snapshotCards?.tradeCount || view.tradeCount || pair.snapshot?.tradeCount || 0,
      timeOverlap: view.timeOverlap ?? pair.snapshot?.timeOverlap ?? false,
      completedAt: now,
      by: iAmLow ? "low" : "high"
    };
    if (iAmLow) {
      pair.lowState = state;
      if (state === "completed") pair.snapshot = snapshot;
    } else {
      pair.highState = state;
      if (state === "completed") pair.snapshot = snapshot;
    }
    // 双方都在交换中时，取消或隐藏会把对方一起放回匹配池。
    if ((state === "active" || state === "hidden") && myState === "exchanging" && partnerState === "exchanging") {
      if (iAmLow) pair.highState = "active";
      else pair.lowState = "active";
    }
    pair.updatedAt = now;
    saveDb(db);
    return { ok: true };
  }

  if (path === "/v1/reports" && method === "POST") {
    if (!authRow) return err(401, "UNAUTHORIZED", "恢复码无效或已删除");
    const pair = db.pairs.find((row) => row.id === body?.pairId);
    if (!pair || (pair.lowId !== authRow.id && pair.highId !== authRow.id)) {
      return err(404, "NOT_FOUND", "只能举报与自己匹配过的旅行者");
    }
    if (!["uid_invalid", "inventory_fake", "harassment"].includes(body?.reason)) {
      return err(400, "INVALID_INPUT", "举报理由只能从预设选项中选择");
    }
    const targetId = pairPartnerId(pair, authRow.id);
    if (!db.reports.some((report) => report.reporterId === authRow.id && report.targetId === targetId)) {
      db.reports.push({ reporterId: authRow.id, targetId, reason: body.reason, createdAt: now });
    }
    const distinct = new Set(
      db.reports.filter((report) => report.targetId === targetId).map((report) => report.reporterId)
    );
    if (distinct.size >= RULES.suspendReports) {
      const target = db.listings.find((row) => row.id === targetId);
      if (target && target.status === "active") target.status = "suspended";
    }
    saveDb(db);
    return { ok: true, reported: true };
  }

  return err(404, "NOT_FOUND", "接口不存在");
}

// 演示保底：种子是固定生成的，若同服务器里没有任何与当前登记互补的旅行者，
// 就合成两位牌友（持有我缺的牌、想要我多出的牌；一位时间必重叠，一位错开），
// 保证登记后一定能看到匹配与交换的完整流程。种子本身不变。
function ensureDemoRivals(db, mine, now) {
  const hasRival = db.listings.some(
    (row) =>
      row.id !== mine.id &&
      row.serverGroup === mine.serverGroup &&
      row.status === "active" &&
      row.expiresAt > now &&
      (row.spareMask & mine.wantMask) !== 0 &&
      (row.wantMask & mine.spareMask) !== 0
  );
  if (hasRival) return;
  const missing = CARDS.filter((card) => mine.counts[card.no] === 0);
  if (!missing.length || !mine.spareMask) return;
  const spareIds = CARDS.filter((card) => (mine.spareMask & (1 << card.no)) !== 0).map((card) => card.id);
  if (!spareIds.length) return;
  const head = { sky: "1", tree: "5", usa: "6", euro: "7", asia: "8", cht: "9" }[mine.serverGroup] ?? "1";
  // UID 由登记 id 派生，保证同组不冲突；9 位且倒数第 9 位为组首位，服务器判断正确。
  let hash = 0;
  for (const ch of mine.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const base = hash % 400000;
  for (let index = 0; index < 2; index += 1) {
    const giveCard = missing[(base + index * 7 + 3) % missing.length];
    const uid = `${head}${10000000 + base * 2 + index * 3 + 11}`;
    if (db.listings.some((row) => row.uid === uid || row.id === `demo-${mine.id}-${index}`)) continue;
    const counts = new Array(CARDS.length).fill(0);
    counts[giveCard.no] = 2;
    // 一位随时可约（与任何选择都重叠），一位周末白天（与工作日晚上等错开）。
    const timeSlots = index === 0 ? ["anytime"] : ["weekend_day"];
    db.listings.push({
      id: `demo-${mine.id}-${index}`,
      tokenHash: `demo-hash-${mine.id}-${index}`,
      uid,
      serverGroup: mine.serverGroup,
      nickname: NICKNAMES[(base + index * 5) % NICKNAMES.length],
      level: 45 + index * 7,
      counts,
      spareMask: spareMaskFromCounts(counts),
      wantMask: wantMaskFromIds([spareIds[0]], counts),
      timeMask: timeMask(timeSlots),
      status: "active",
      createdAt: now - 2 * DAY,
      updatedAt: now - DAY,
      expiresAt: now + 20 * DAY,
      matchedAt: null
    });
  }
}

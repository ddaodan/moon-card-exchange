import { CARDS, CARD_BY_ID, CARD_COUNT, CARD_INDEX } from "./cards.js";

export const RULES = {
  keep: 1,
  maxCount: 99,
  matchLimit: 20,
  recordLimit: 50,
  listingTtlDays: 30,
  purgeAfterDays: 30,
  matchCacheMinutes: 10,
  candidateLimit: 500,
  pairSeedLimit: 50,
  suspendReports: 3,
  profileTtlMs: 24 * 60 * 60 * 1000,
  profileFailTtlMs: 60 * 60 * 1000
};

export const SERVER_GROUPS = {
  sky: "天空岛",
  tree: "世界树",
  usa: "美服",
  euro: "欧服",
  asia: "亚服",
  cht: "港澳台"
};

// 9 位 UID 首位决定服务器；10 位 UID 目前只有 18 开头的亚服号段有效，
// 11–17、19、20 开头经 Enka 实测均返回"无效号段"。
// 天空岛与世界树是两个独立分组：官服与 B 服数据不互通，只在同一服务器内匹配。
const UID_DIGIT_GROUP = {
  1: "sky",
  2: "sky",
  3: "sky",
  5: "tree",
  6: "usa",
  7: "euro",
  8: "asia",
  9: "cht"
};

function uidServerGroup(uid) {
  if (typeof uid !== "string" || !/^[1-9]\d{8,9}$/.test(uid)) return null;
  if (uid.length === 10) return uid.startsWith("18") ? "asia" : null;
  return UID_DIGIT_GROUP[uid[0]] ?? null;
}

export function isValidUid(uid) {
  return uidServerGroup(uid) !== null;
}

export function serverGroupFromUid(uid) {
  return uidServerGroup(uid);
}

export function serverNameFromUid(uid) {
  const group = uidServerGroup(uid);
  if (!group) return null;
  return SERVER_GROUPS[group];
}

export function regionToServerGroup(region) {
  const map = { CN: "sky", B: "tree", NA: "usa", EU: "euro", ASIA: "asia", TW: "cht" };
  return map[region] ?? null;
}

const REGION_SERVER_NAME = { CN: "天空岛", B: "世界树", NA: "美服", EU: "欧服", ASIA: "亚服", TW: "港澳台" };

export function regionToServerName(region) {
  return REGION_SERVER_NAME[region] ?? null;
}

export const TIME_SLOTS = [
  { id: "weekday_day", label: "工作日白天" },
  { id: "weekday_evening", label: "工作日晚上" },
  { id: "weekday_late", label: "工作日深夜" },
  { id: "weekend_day", label: "周末白天" },
  { id: "weekend_evening", label: "周末晚上" },
  { id: "weekend_late", label: "周末深夜" },
  { id: "anytime", label: "随时可约" }
];
export const TIME_SLOT_IDS = TIME_SLOTS.map((slot) => slot.id);
const TIME_BIT = Object.fromEntries(TIME_SLOT_IDS.map((id, index) => [id, index]));

export function timeMask(slots) {
  let mask = 0;
  for (const id of slots) if (id in TIME_BIT) mask |= 1 << TIME_BIT[id];
  return mask;
}

export function timeOverlap(maskA, maskB) {
  const anytime = 1 << TIME_BIT.anytime;
  if ((maskA & anytime) !== 0 || (maskB & anytime) !== 0) return true;
  return (maskA & maskB) !== 0;
}

export function timeSlotsFromMask(mask) {
  return TIME_SLOT_IDS.filter((id) => (mask & (1 << TIME_BIT[id])) !== 0);
}

export function spareMaskFromCounts(counts) {
  let mask = 0;
  for (const card of CARDS) if ((counts[card.no] ?? 0) > RULES.keep) mask |= 1 << card.no;
  return mask;
}

export function wantMaskFromIds(wantIds, counts) {
  let mask = 0;
  for (const id of wantIds) {
    const card = CARD_BY_ID[id];
    if (!card || (counts?.[card.no] ?? 0) !== 0) continue;
    mask |= 1 << card.no;
  }
  return mask;
}

export function wantIdsFromMask(mask) {
  return CARDS.filter((card) => (mask & (1 << card.no)) !== 0).map((card) => card.id);
}

export function spareCount(counts, id) {
  return Math.max((counts[CARD_INDEX[id]] ?? 0) - RULES.keep, 0);
}

export function popcount(mask) {
  let count = 0;
  while (mask) {
    mask &= mask - 1;
    count += 1;
  }
  return count;
}

export function evaluatePair(a, b) {
  const give = a.spareMask & b.wantMask;
  const get = b.spareMask & a.wantMask;
  if (give === 0 || get === 0) return null;
  return {
    give,
    get,
    tradeCount: Math.min(popcount(give), popcount(get)),
    timeOverlap: timeOverlap(a.timeMask, b.timeMask)
  };
}

export function compareCandidates(x, y) {
  if (y.tradeCount !== x.tradeCount) return y.tradeCount - x.tradeCount;
  if (x.timeOverlap !== y.timeOverlap) return x.timeOverlap ? -1 : 1;
  return y.partner.updatedAt - x.partner.updatedAt;
}

export function defaultWantIds(counts) {
  return CARDS.filter((card) => (counts[card.no] ?? 0) === 0).map((card) => card.id);
}

export function canSubmitListing(input) {
  const { uid, counts, wantIds, timeSlots, consent } = input;
  return {
    ok:
      isValidUid(uid) &&
      spareMaskFromCounts(counts) !== 0 &&
      wantMaskFromIds(wantIds, counts) !== 0 &&
      timeSlots.length > 0 &&
      consent === true
  };
}

const LISTING_KEYS = ["uid", "counts", "want", "timeSlots", "consent"];

export function validateListingInput(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("请求体格式不正确");
  }
  for (const key of Object.keys(body)) {
    if (!LISTING_KEYS.includes(key)) return invalid(`不接受字段 ${key}`);
  }
  const { uid, counts, want, timeSlots, consent } = body;
  if (typeof uid !== "string" || !isValidUid(uid)) {
    return { ok: false, error: { code: "UID_INVALID", message: "UID 应为 9–10 位数字，且服务器可识别" } };
  }
  if (!Array.isArray(counts) || counts.length !== CARD_COUNT) {
    return invalid("counts 必须是包含 22 个整数的数组");
  }
  for (const count of counts) {
    if (!Number.isInteger(count) || count < 0 || count > RULES.maxCount) {
      return invalid("每张牌的数量必须是 0–99 的整数");
    }
  }
  if (!Array.isArray(want) || !want.every((id) => id in CARD_BY_ID)) {
    return invalid("want 只能包含圣牌 id");
  }
  for (const id of want) {
    if (counts[CARD_INDEX[id]] !== 0) {
      return invalid(`已拥有${CARD_BY_ID[id].name}，不能同时标记为想要`);
    }
  }
  if (!Array.isArray(timeSlots) || timeSlots.length === 0 || !timeSlots.every((id) => TIME_SLOT_IDS.includes(id))) {
    return invalid("可联系时间只能从预设选项中选择");
  }
  if (consent !== true) return invalid("需要勾选同意共享信息");
  return {
    ok: true,
    value: {
      uid,
      counts: [...counts],
      want: [...new Set(want)],
      timeSlots: [...new Set(timeSlots)],
      consent: true
    }
  };

  function invalid(message) {
    return { ok: false, error: { code: "INVALID_INPUT", message } };
  }
}

import { describe, expect, it } from "vitest";
import {
  CARD_COUNT,
  RULES,
  canSubmitListing,
  compareCandidates,
  defaultWantIds,
  evaluatePair,
  isValidUid,
  regionToServerGroup,
  regionToServerName,
  serverGroupFromUid,
  serverNameFromUid,
  spareMaskFromCounts,
  timeOverlap,
  timeSlotsFromMask,
  validateListingInput,
  wantIdsFromMask,
  wantMaskFromIds
} from "../src/index.js";

const zeroCounts = () => new Array(CARD_COUNT).fill(0);
const listing = (over = {}) => ({
  spareMask: spareMaskFromCounts(over.counts ?? zeroCounts()),
  wantMask: wantMaskFromIds(over.want ?? [], over.counts ?? zeroCounts()),
  timeMask: 0,
  ...over
});

describe("UID 与服务器", () => {
  it("9 位按首位分组，10 位只接受 18 开头的亚服号段", () => {
    expect(serverGroupFromUid("100000001")).toBe("sky");
    expect(serverGroupFromUid("550000001")).toBe("tree");
    expect(serverGroupFromUid("1800000001")).toBe("asia");
    expect(serverGroupFromUid("600000001")).toBe("usa");
    expect(serverGroupFromUid("1600000001")).toBeNull();
    expect(serverGroupFromUid("1500000001")).toBeNull();
    expect(serverGroupFromUid("1100000001")).toBeNull();
    expect(serverGroupFromUid("2000000001")).toBeNull();
    expect(isValidUid("700000001")).toBe(true);
    expect(isValidUid("400000001")).toBe(false);
    expect(isValidUid("12345678")).toBe(false);
    expect(isValidUid("023456789")).toBe(false);
  });

  it("服务器名按首位区分具体服务器", () => {
    expect(serverNameFromUid("100000000")).toBe("天空岛");
    expect(serverNameFromUid("130000000")).toBe("天空岛");
    expect(serverNameFromUid("150000000")).toBe("天空岛");
    expect(serverNameFromUid("550000000")).toBe("世界树");
    expect(serverNameFromUid("660000000")).toBe("美服");
    expect(serverNameFromUid("1800000001")).toBe("亚服");
    expect(serverNameFromUid("1600000001")).toBeNull();
    expect(serverNameFromUid("900000000")).toBe("港澳台");
    expect(serverNameFromUid("400000000")).toBeNull();
  });

  it("Enka region 优先于 UID 推断", () => {
    expect(regionToServerName("CN")).toBe("天空岛");
    expect(regionToServerName("B")).toBe("世界树");
    expect(regionToServerGroup("CN")).toBe("sky");
    expect(regionToServerGroup("B")).toBe("tree");
    expect(regionToServerGroup("NA")).toBe("usa");
    expect(regionToServerGroup("ASIA")).toBe("asia");
    expect(regionToServerGroup("XX")).toBeNull();
  });
});

describe("牌匣规则", () => {
  it("可交换掩码只在拥有 2 张及以上时置位", () => {
    const counts = zeroCounts();
    counts[0] = 1;
    counts[1] = 3;
    const mask = spareMaskFromCounts(counts);
    expect(mask & 1).toBe(0);
    expect(mask & (1 << 1)).not.toBe(0);
  });

  it("想要只能选择数量为 0 的牌", () => {
    const counts = zeroCounts();
    counts[0] = 2;
    const mask = wantMaskFromIds(["magician", "star"], counts);
    expect(mask & 1).toBe(0);
    expect(wantIdsFromMask(mask)).toEqual(["star"]);
  });

  it("默认想要全部缺少的牌", () => {
    const counts = zeroCounts();
    counts[4] = 1;
    const want = defaultWantIds(counts);
    expect(want).toHaveLength(CARD_COUNT - 1);
    expect(want).not.toContain("hierophant");
  });

  it("校验多余字段、数量范围与同意项", () => {
    const counts = zeroCounts();
    counts[0] = 2;
    counts[1] = 0;
    const good = validateListingInput({ uid: "100000001", counts, want: ["star"], timeSlots: ["anytime"], consent: true });
    expect(good.ok).toBe(true);
    expect(good.value.counts).toEqual(counts);
    expect(validateListingInput({ ...good.value, extra: 1 }).ok).toBe(false);
    const bad = [...counts];
    bad[3] = 100;
    expect(validateListingInput({ ...good.value, counts: bad }).ok).toBe(false);
    expect(validateListingInput({ ...good.value, consent: false }).ok).toBe(false);
    expect(validateListingInput({ ...good.value, want: ["magician"] }).ok).toBe(false);
    expect(validateListingInput({ ...good.value, uid: "400000001" }).error.code).toBe("UID_INVALID");
  });

  it("提交条件要求可交换、想要、时间与同意", () => {
    const counts = zeroCounts();
    counts[0] = 2;
    const base = { uid: "100000001", counts, wantIds: ["star"], timeSlots: ["anytime"], consent: true };
    expect(canSubmitListing(base).ok).toBe(true);
    expect(canSubmitListing({ ...base, wantIds: [] }).ok).toBe(false);
    const single = zeroCounts();
    single[0] = 1;
    expect(canSubmitListing({ ...base, counts: single, wantIds: ["star"] }).ok).toBe(false);
  });
});

describe("联系时间", () => {
  it("anytime 与任意组合重叠，具体时段需要交集", () => {
    expect(timeOverlap(0b1000000, 0b0000001)).toBe(true);
    expect(timeOverlap(0b0001, 0b0010)).toBe(false);
    expect(timeOverlap(0b0011, 0b0010)).toBe(true);
    expect(timeOverlap(0b0000010, 0b0000100)).toBe(false);
    expect(timeOverlap(0b0011000, 0b0001000)).toBe(true);
    expect(timeSlotsFromMask(0b1111111)).toEqual([
      "weekday_day",
      "weekday_evening",
      "weekday_late",
      "weekend_day",
      "weekend_evening",
      "weekend_late",
      "anytime"
    ]);
  });
});

describe("匹配", () => {
  const mine = listing({
    counts: (() => { const c = zeroCounts(); c[17] = 3; return c; })(),
    want: ["star", "sun"],
    timeMask: 0b0001,
    partner: { updatedAt: 100 }
  });
  const other = listing({
    counts: (() => { const c = zeroCounts(); c[16] = 2; c[18] = 2; return c; })(),
    want: ["moon"],
    timeMask: 0b0010,
    partner: { updatedAt: 200 }
  });

  it("双方互补才产生匹配，且结果对称", () => {
    const ab = evaluatePair(mine, other);
    const ba = evaluatePair(other, mine);
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab.tradeCount).toBe(ba.tradeCount);
    expect(ab.give).toBe(ba.get);
    expect(ab.get).toBe(ba.give);
    expect(ab.tradeCount).toBe(1);
    expect(ab.timeOverlap).toBe(false);
  });

  it("排序先按可交换数量、再看时间重叠、最后看更新时间", () => {
    const a = { tradeCount: 1, timeOverlap: true, partner: { updatedAt: 5 } };
    const b = { tradeCount: 1, timeOverlap: false, partner: { updatedAt: 9 } };
    const c = { tradeCount: 2, timeOverlap: false, partner: { updatedAt: 1 } };
    expect([a, b, c].sort(compareCandidates).map((x) => x.tradeCount)).toEqual([2, 1, 1]);
    expect([a, b].sort(compareCandidates)[0].timeOverlap).toBe(true);
  });

  it("互不互补时返回 null", () => {
    const lone = listing({ counts: (() => { const c = zeroCounts(); c[2] = 2; return c; })(), want: ["world"] });
    expect(evaluatePair(mine, lone)).toBeNull();
  });

  it("规则常量符合计划", () => {
    expect(RULES.keep).toBe(1);
    expect(RULES.listingTtlDays).toBe(30);
    expect(RULES.suspendReports).toBe(3);
  });
});

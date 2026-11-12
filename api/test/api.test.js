import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createApp } from "../src/index.js";
import { createMemoryStore } from "../src/store/memory.js";

// 需要晚于资料缓存 TTL（24 小时），保证 fake timers 下 PUT 会重新查询 Enka。
const NOW = Date.now() + 25 * 3600000;
const TEST_ENV = {
  RATE_SALT: "test-salt",
  ALLOWED_ORIGINS: "https://www.bilibili.com,http://localhost:5173,http://127.0.0.1:5173"
};

let store;
let app;

function request(path, init = {}) {
  return app.fetch(new Request(`https://test.moon-card${path}`, init));
}

// 按新目录顺序（魔法师下标 0 …愚者下标 21）构造 counts 数组。
function countAt(index, value) {
  const counts = new Array(22).fill(0);
  counts[index] = value;
  return counts;
}

function listingInput(uid, overrides = {}) {
  return {
    uid,
    counts: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    want: ["empress"],
    timeSlots: ["weekday_evening"],
    consent: true,
    ...overrides
  };
}

function enkaBody(nickname, region, level = 60) {
  return {
    playerInfo: { nickname, level },
    region
  };
}

// 用 vi.stubGlobal 模拟外发的 Enka 请求，同时拦截任何误发的数据层直连请求。
function mockEnka(urlMatcher, status, body) {
  const originalFetch = globalThis.__originalFetch ?? globalThis.fetch;
  const stub = vi.fn(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://enka.network/") && urlMatcher(url)) {
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`测试不允许外发请求：${url}`);
  });
  stub.originalFetch = originalFetch;
  globalThis.fetch = stub;
}

async function createListing(uid, overrides = {}, withMock = true) {
  if (withMock) {
    mockEnka((url) => url === `https://enka.network/api/uid/${uid}?info`, 200, enkaBody(`旅行者${uid.slice(-4)}`, "CN"));
  }
  const response = await request("/v1/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
    body: JSON.stringify(listingInput(uid, overrides))
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function pairState(token, pairId, state, snapshot) {
  return request(`/v1/pairs/${pairId}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(snapshot ? { state, snapshot } : { state })
  });
}

async function debugUpdateListingByUid(uid, patch) {
  const row = await store.getListingByUid(uid);
  expect(row).toBeTruthy();
  return store.updateListingFields(row.id, patch);
}

function uidForGroup(group) {
  // 9 位 UID 首位决定服务器组（天空岛与世界树是独立分组）。
  const digits = { sky: "1", tree: "5", usa: "6", euro: "7", asia: "8", cht: "9" };
  return `${digits[group]}00000001`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  store = createMemoryStore();
  app = createApp(TEST_ENV, store);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("健康与统计", () => {
  it("health 返回 ok", async () => {
    const response = await request("/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("stats 汇总活跃登记", async () => {
    await createListing(uidForGroup("sky"));
    const response = await request("/v1/stats");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.activeListings).toBe(1);
    expect(data.byGroup.sky).toBe(1);
  });
});

describe("资料查询", () => {
  it("Enka 正常时返回昵称和等级", async () => {
    mockEnka(() => true, 200, enkaBody("阿贝多", "ASIA", 60));
    const response = await request("/v1/profile/1800000001");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.nickname).toBe("阿贝多");
    expect(data.level).toBe(60);
    expect(data.serverGroup).toBe("asia");
    expect(data.source).toBe("enka");
  });

  it("Enka 404 时返回 UID_NOT_FOUND", async () => {
    mockEnka(() => true, 404, "not found");
    const response = await request("/v1/profile/1800000002");
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("UID_NOT_FOUND");
  });

  it("Enka 500 时降级为旅行者", async () => {
    mockEnka(() => true, 500, "boom");
    const response = await request("/v1/profile/1800000003");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.nickname).toBe("旅行者");
    expect(data.source).toBe("fallback");
    expect(data.serverGroup).toBe("asia");
  });

  it("region 未知时按 UID 判断服务器", async () => {
    mockEnka(() => true, 200, enkaBody("星", "UNKNOWN_REGION"));
    const response = await request("/v1/profile/1800000004");
    const data = await response.json();
    expect(data.serverGroup).toBe("asia");
  });
});

describe("登记", () => {
  it("创建登记并返回 32 位恢复码", async () => {
    const data = await createListing(uidForGroup("usa"));
    expect(data.token).toMatch(/^[0-9A-HJKLMNPQRSTVWXYZ]{32}$/);
    expect(data.listing.uid).toBe(uidForGroup("usa"));
    expect(data.listing.counts[0]).toBe(2);
    expect(data.listing.want).toEqual(["empress"]);
  });

  it("重复 UID 返回 UID_TAKEN", async () => {
    await createListing("600000008");
    const response = await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.11" },
      body: JSON.stringify(listingInput("600000008"))
    });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("UID_TAKEN");
  });

  it("拒绝多余字段", async () => {
    const response = await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.12" },
      body: JSON.stringify({ ...listingInput("600000009"), memo: "hello" })
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
  });

  it("拥有数量大于 0 的牌不能加入想要", async () => {
    const response = await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.13" },
      body: JSON.stringify(listingInput("600000010", { want: ["magician"] }))
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
  });

  it("Enka 404 时拒绝创建", async () => {
    mockEnka(() => true, 404, "not found");
    const response = await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.14" },
      body: JSON.stringify(listingInput("600000011"))
    });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("UID_NOT_FOUND");
  });

  it("查询资料并更新登记会续期", async () => {
    const created = await createListing("600000012");
    vi.useFakeTimers({ now: NOW });
    mockEnka(() => true, 200, enkaBody("更新者", "CN", 55));
    const response = await request("/v1/listings/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify(
        listingInput("600000012", {
          counts: [3, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          want: ["emperor"]
        })
      )
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.listing.level).toBe(55);
    expect(data.listing.counts[2]).toBe(2);
    expect(data.listing.expiresAt).toBe(NOW + 30 * 86400000);
  });

  it("删除登记后原令牌失效", async () => {
    const created = await createListing("600000013");
    const deleted = await request("/v1/listings/me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${created.token}` }
    });
    expect(deleted.status).toBe(200);
    const response = await request("/v1/listings/me", {
      headers: { Authorization: `Bearer ${created.token}` }
    });
    expect(response.status).toBe(401);
  });
});

describe("匹配", () => {
  it("双方互相补缺时各自看到同一个 pair", async () => {
    const a = await createListing("600000020", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000021", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    for (const token of [a.token, b.token]) {
      const response = await request("/v1/matches", { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      expect(data.active).toHaveLength(1);
      const match = data.active[0];
      // 申请交换前 UID 对双方都是隐藏的。
      expect(match.partner.uid).toBeNull();
      expect(match.tradeCount).toBe(1);
    }
    // A 申请后，双方都能看到对方 UID。
    const pairId = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json()).active[0].pairId;
    await pairState(a.token, pairId, "exchanging");
    for (const [token, partnerUid] of [[a.token, "600000021"], [b.token, "600000020"]]) {
      const data = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${token}` } })).json();
      expect(data.active[0].partner.uid).toBe(partnerUid);
    }
    const mineA = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json()).active[0];
    const mineB = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json()).active[0];
    expect(mineA.pairId).toBe(mineB.pairId);
    expect(mineA.give).toEqual(["fool"]);
    expect(mineA.get).toEqual(["magician"]);
    expect(mineB.give).toEqual(["magician"]);
    expect(mineB.get).toEqual(["fool"]);
  });

  it("更新牌匣后不再互补的匹配消失", async () => {
    const a = await createListing("600000022", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    await createListing("600000023", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    vi.useFakeTimers({ now: NOW });
    await request("/v1/listings/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify(
        listingInput("600000022", {
          counts: countAt(21, 1),
          want: ["empress"]
        })
      )
    });
    const response = await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } });
    const data = await response.json();
    expect(data.active).toHaveLength(0);
  });

  it("不同服务器组之间不匹配", async () => {
    const a = await createListing("600000024", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    mockEnka((url) => url.includes("1800000025"), 200, enkaBody("亚服人", "ASIA"));
    await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.15" },
      body: JSON.stringify(
        listingInput("1800000025", {
          counts: countAt(0, 2),
          want: ["fool"]
        })
      )
    });
    const response = await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } });
    const data = await response.json();
    expect(data.active).toHaveLength(0);
  });

  it("天空岛与世界树互不匹配", async () => {
    const a = await createListing("100000070", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    mockEnka((url) => url.includes("500000071"), 200, enkaBody("世界树旅行者", "B"));
    await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.17" },
      body: JSON.stringify(
        listingInput("500000071", {
          counts: countAt(0, 2),
          want: ["fool"]
        })
      )
    });
    const response = await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } });
    const data = await response.json();
    expect(data.active).toHaveLength(0);
  });

  it("过期登记不参与匹配", async () => {
    const a = await createListing("600000026", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000027", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    await debugUpdateListingByUid("600000027", { expires_at: Date.now() - 1000 });
    const response = await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } });
    const data = await response.json();
    expect(data.active).toHaveLength(0);
    expect(b.token).toBeTruthy();
  });

  it("状态切换写入快照并出现在记录里", async () => {
    const a = await createListing("600000028", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000029", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    const matchesA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    const pairId = matchesA.active[0].pairId;
    // 申请前看不到对方 UID，也不能绕过申请直接标记完成。
    expect(matchesA.active[0].partner.uid).toBeNull();
    const early = await pairState(a.token, pairId, "completed");
    expect(early.status).toBe(409);
    await pairState(a.token, pairId, "exchanging");
    const appliedA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(appliedA.active[0].myState).toBe("exchanging");
    expect(appliedA.active[0].partner.uid).toBe("600000029");
    vi.useFakeTimers({ now: NOW });
    const completed = await pairState(a.token, pairId, "completed");
    expect(completed.status).toBe(200);
    const recordsA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(recordsA.records).toHaveLength(1);
    expect(recordsA.records[0].snapshot.give).toEqual(["fool"]);
    expect(recordsA.records[0].snapshot.partner.uid).toBe("600000029");
    const matchesB = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(matchesB.active[0].partnerState).toBe("completed");
  });

  it("申请交换后双方进入交换状态，取消后回到匹配中", async () => {
    const a = await createListing("600000060", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000061", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    const matchesA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(matchesA.active).toHaveLength(1);
    expect(matchesA.active[0].partner.uid).toBeNull();
    await pairState(a.token, matchesA.active[0].pairId, "exchanging");
    const appliedA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(appliedA.active[0].myState).toBe("exchanging");
    expect(appliedA.active[0].partnerState).toBe("exchanging");
    expect(appliedA.active[0].partner.uid).toBe("600000061");
    const matchesB = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(matchesB.active[0].myState).toBe("exchanging");
    expect(matchesB.active[0].partner.uid).toBe("600000060");
    // 取消交换：双方回到匹配中，UID 重新隐藏。
    await pairState(a.token, matchesA.active[0].pairId, "active");
    const cancelledA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(cancelledA.active[0].myState).toBe("active");
    expect(cancelledA.active[0].partner.uid).toBeNull();
    const cancelledB = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(cancelledB.active[0].partnerState).toBe("active");
  });

  it("对方正在和他人交换时返回忙碌标记，申请不会被拦截", async () => {
    const a = await createListing("600000062", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000063", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    const c = await createListing("600000064", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const matchesA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    await pairState(a.token, matchesA.active[0].pairId, "exchanging");
    // c 看到的 b 正在和别人交换：有忙碌标记，UID 仍隐藏。
    const matchesC = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${c.token}` } })).json();
    expect(matchesC.active[0].partner.uid).toBeNull();
    expect(matchesC.active[0].partnerBusy).toBe(true);
    // 忙碌只提醒不拦截：c 仍可申请并与 b 进入交换。
    const applied = await pairState(c.token, matchesC.active[0].pairId, "exchanging");
    expect(applied.status).toBe(200);
    const appliedC = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${c.token}` } })).json();
    expect(appliedC.active[0].myState).toBe("exchanging");
    expect(appliedC.active[0].partner.uid).toBe("600000063");
    expect(b.token).toBeTruthy();
  });

  it("交换中隐藏会把对方放回匹配池", async () => {
    const a = await createListing("600000065", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000066", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    const matchesA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    const pairId = matchesA.active[0].pairId;
    await pairState(a.token, pairId, "exchanging");
    await pairState(a.token, pairId, "hidden");
    const matchesB = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(matchesB.active[0].myState).toBe("active");
    const recordsA = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json();
    expect(recordsA.records[0].myState).toBe("hidden");
  });

  it("一方完成交换更新牌匣后，另一方仍能靠快照完成标记", async () => {
    const a = await createListing("600000080", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000081", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    const pairId = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json()).active[0].pairId;
    await pairState(a.token, pairId, "exchanging");
    // A 标记完成时牌匣未变：快照记录 A 交出愚者、获得魔法师。
    await pairState(a.token, pairId, "completed");
    // A 更新牌匣（愚者 2→1、魔法师 0→1），双方不再互补。
    const updatedCounts = countAt(21, 1);
    updatedCounts[0] = 1;
    await debugUpdateListingByUid("600000080", {
      counts: JSON.stringify(updatedCounts),
      spare_mask: 0,
      want_mask: 0
    });
    // B 的交换中匹配保留，牌面从 A 的快照换向得到。
    const bView = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json()).active[0];
    expect(bView.myState).toBe("exchanging");
    expect(bView.partnerState).toBe("completed");
    // 顶层 give/get 也必须回退到换向快照，确认框与卡片展示保持一致。
    expect(bView.give).toEqual(["magician"]);
    expect(bView.get).toEqual(["fool"]);
    expect(bView.tradeCount).toBe(1);
    expect(bView.snapshot.give).toEqual(["magician"]);
    expect(bView.snapshot.get).toEqual(["fool"]);
    // B 标记完成。客户端拿到空牌面时仍提交空数组，服务端必须忽略空快照，
    // 用换向快照补全 B 的记录。
    await pairState(b.token, pairId, "completed", { give: [], get: [] });
    const bRecords = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json()).records;
    expect(bRecords).toHaveLength(1);
    expect(bRecords[0].give).toEqual(["magician"]);
    expect(bRecords[0].get).toEqual(["fool"]);
    expect(bRecords[0].snapshot.give).toEqual(["magician"]);
    expect(bRecords[0].snapshot.get).toEqual(["fool"]);
    const aRecords = (await (await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } })).json()).records;
    expect(aRecords[0].snapshot.give).toEqual(["fool"]);
    expect(aRecords[0].snapshot.get).toEqual(["magician"]);
  });

  it("举报 3 次后暂停登记", async () => {
    const target = await createListing("600000030", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const reporters = [];
    for (const uid of ["600000031", "600000032", "600000033"]) {
      reporters.push(
        await createListing(uid, {
          counts: countAt(0, 2),
          want: ["fool"]
        })
      );
    }
    for (const reporter of reporters) {
      const matches = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${reporter.token}` } })).json();
      const pairId = matches.active[0].pairId;
      const response = await request("/v1/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${reporter.token}` },
        body: JSON.stringify({ pairId, reason: "inventory_fake" })
      });
      expect(response.status).toBe(200);
    }
    const row = await store.getListingByUid("600000030");
    expect(row.status).toBe("suspended");
    const matchesTarget = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${target.token}` } })).json();
    expect(matchesTarget.active).toHaveLength(0);
  });
});

describe("CORS 与限频", () => {
  it("白名单来源回显 Origin", async () => {
    const response = await request("/v1/health", {
      headers: { Origin: "http://localhost:5173" }
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("非白名单来源不回显 Origin", async () => {
    const response = await request("/v1/health", {
      headers: { Origin: "https://evil.example.com" }
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("预检请求返回 204 和允许头", async () => {
    const response = await request("/v1/health", { method: "OPTIONS", headers: { Origin: "https://www.bilibili.com" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("同一 IP 创建登记每天最多 5 次", async () => {
    mockEnka((url) => /\/api\/uid\/60000004\d\?info/.test(url), 200, enkaBody("批量", "CN"));
    let last;
    for (let index = 0; index < 6; index += 1) {
      last = await request("/v1/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
        body: JSON.stringify(listingInput(`6000000${40 + index}`))
      });
      if (index < 5) expect(last.status).toBe(200);
    }
    expect(last.status).toBe(429);
    const data = await last.json();
    expect(data.error.code).toBe("RATE_LIMITED");
  });

  it("限频 key 使用 HMAC，不暴露 IP", async () => {
    mockEnka((url) => /\/api\/uid\/600000050\?info/.test(url), 200, enkaBody("哈希", "CN"));
    await request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
      body: JSON.stringify(listingInput("600000050"))
    });
    const rows = store.debugRateLimits();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).toMatch(/^(profile|create|w):[0-9a-f]{64}$/);
      expect(row.key).not.toContain("203.0.113.77");
    }
  });
});

describe("定时清理", () => {
  it("删除过期超过 30 天的登记及关联数据", async () => {
    const a = await createListing("600000060", {
      counts: countAt(21, 2),
      want: ["magician"]
    });
    const b = await createListing("600000061", {
      counts: countAt(0, 2),
      want: ["fool"]
    });
    await request("/v1/matches", { headers: { Authorization: `Bearer ${a.token}` } });
    vi.useFakeTimers({ now: Date.now() + 31 * 86400000 + 1000 });
    await request("/v1/listings/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify(listingInput("600000060"))
    });
    vi.useRealTimers();
    const stale = await store.getListingByUid("600000060");
    await store.updateListingFields(stale.id, { expires_at: Date.now() - 31 * 86400000 });
    await cleanup(store);
    const gone = await store.getListingByUid("600000060");
    expect(gone).toBeNull();
    // 与 a 相关的 pair 应一并删除：b 再查匹配时不应出现任何记录。
    const matchesB = await (await request("/v1/matches", { headers: { Authorization: `Bearer ${b.token}` } })).json();
    expect(matchesB.active).toHaveLength(0);
    expect(matchesB.records).toHaveLength(0);
    expect(b.token).toBeTruthy();
  });
});

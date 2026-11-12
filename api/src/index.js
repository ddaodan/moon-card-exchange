import { Hono } from "hono";
import {
  CARDS,
  CARD_BY_ID,
  RULES,
  SERVER_GROUPS,
  compareCandidates,
  evaluatePair,
  regionToServerGroup,
  regionToServerName,
  serverGroupFromUid,
  serverNameFromUid,
  spareMaskFromCounts,
  timeMask,
  timeSlotsFromMask,
  validateListingInput,
  wantIdsFromMask,
  wantMaskFromIds
} from "@moon/shared";

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
// 32 位 Crockford Base32（去掉容易混淆的 I、L、O、U）。
const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REPORT_REASONS = ["uid_invalid", "inventory_fake", "harassment"];
const DEFAULT_TTL = RULES.listingTtlDays * DAY;

function err(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(digest);
}

async function hmacHex(salt, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(signature);
}

// 对外暴露的 pairId 由内部组合键哈希得到，避免把双方的令牌哈希直接发给浏览器。
async function publicPairId(pairKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pair:${pairKey}`));
  return bytesToHex(digest).slice(0, 24);
}

function randomToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let accumulator = 0;
  let bits = 0;
  let token = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      token += TOKEN_ALPHABET[(accumulator >>> bits) & 31];
    }
  }
  return token;
}

function idsFromMask(mask) {
  return CARDS.filter((card) => (mask & (1 << card.no)) !== 0).map((card) => card.id);
}

function sanitizeNickname(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 16);
  return cleaned || "旅行者";
}

// 优先使用 CF-Connecting-IP（Workers / 测试）；FC 入口会删除不可信的
// x-forwarded-for，再用受信代理的值回填，因此此处读取是安全的。
function clientIp(c) {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

function listingView(row) {
  return {
    uid: row.uid,
    serverGroup: row.server_group,
    serverLabel: serverNameFromUid(row.uid) ?? SERVER_GROUPS[row.server_group] ?? row.server_group,
    nickname: row.nickname,
    level: row.level,
    counts: JSON.parse(row.counts),
    want: wantIdsFromMask(row.want_mask),
    timeSlots: timeSlotsFromMask(row.time_mask),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    expired: row.expires_at <= Date.now()
  };
}

function toPairInput(row) {
  return { spareMask: row.spare_mask, wantMask: row.want_mask, timeMask: row.time_mask };
}

// 把 pairs 行（已拼上双方 listing 字段）换算成当前用户视角的匹配详情。
function pairDetail(pair, myId) {
  const iAmLow = pair.a_id === myId;
  const mine = iAmLow
    ? toPairInput({ spare_mask: pair.a_spare, want_mask: pair.a_want, time_mask: pair.a_time })
    : toPairInput({ spare_mask: pair.b_spare, want_mask: pair.b_want, time_mask: pair.b_time });
  const partnerRow = iAmLow
    ? {
        uid: pair.b_uid,
        nickname: pair.b_nickname,
        level: pair.b_level,
        server_group: pair.b_group,
        updated_at: pair.b_updated,
        spare_mask: pair.b_spare,
        want_mask: pair.b_want,
        time_mask: pair.b_time,
        status: pair.b_status,
        expires_at: pair.b_expires
      }
    : {
        uid: pair.a_uid,
        nickname: pair.a_nickname,
        level: pair.a_level,
        server_group: pair.a_group,
        updated_at: pair.a_updated,
        spare_mask: pair.a_spare,
        want_mask: pair.a_want,
        time_mask: pair.a_time,
        status: pair.a_status,
        expires_at: pair.a_expires
      };
  const evaluation = evaluatePair(mine, toPairInput(partnerRow));
  const partnerActive = partnerRow.status === "active" && partnerRow.expires_at > Date.now();
  const myState = iAmLow ? pair.low_state : pair.high_state;
  // 申请交换（或标记完成）后才可见对方 UID；未申请的匹配只展示昵称与牌面。
  const uidVisible = myState === "exchanging" || myState === "completed";
  // 先完成的一方更新牌匣后双方可能不再互补，实时计算为空。
  // 自己还没有快照时借用对方快照并互换 give/get，让另一方也能看到同一批牌并完成标记。
  const mySnapshotRaw = iAmLow ? pair.low_snapshot : pair.high_snapshot;
  const partnerSnapshotRaw = iAmLow ? pair.high_snapshot : pair.low_snapshot;
  let snapshot = mySnapshotRaw ? JSON.parse(mySnapshotRaw) : null;
  if (!snapshot && partnerSnapshotRaw) {
    const fromPartner = JSON.parse(partnerSnapshotRaw);
    snapshot = { ...fromPartner, give: fromPartner.get, get: fromPartner.give };
  }
  return {
    pairKey: pair.id,
    partnerId: iAmLow ? pair.b_id : pair.a_id,
    partner: {
      uid: uidVisible ? partnerRow.uid : null,
      nickname: partnerRow.nickname,
      level: partnerRow.level,
      serverGroup: partnerRow.server_group,
      serverLabel: serverNameFromUid(partnerRow.uid) ?? SERVER_GROUPS[partnerRow.server_group] ?? partnerRow.server_group,
      timeSlots: timeSlotsFromMask(partnerRow.time_mask),
      updatedAt: partnerRow.updated_at
    },
    // 实时计算为空时同样回退到快照（可能来自对方的换向快照），
    // 保证标记完成、确认框拿到的顶层 give/get 与卡片展示一致。
    give: evaluation ? idsFromMask(evaluation.give) : (snapshot?.give ?? []),
    get: evaluation ? idsFromMask(evaluation.get) : (snapshot?.get ?? []),
    tradeCount: evaluation?.tradeCount ?? snapshot?.tradeCount ?? 0,
    timeOverlap: evaluation?.timeOverlap ?? snapshot?.timeOverlap ?? false,
    myState,
    partnerState: iAmLow ? pair.high_state : pair.low_state,
    createdAt: pair.created_at,
    updatedAt: pair.updated_at,
    snapshot,
    stale: !evaluation || !partnerActive
  };
}

function cleanPairView(detail, pairId) {
  return {
    pairId,
    partner: detail.partner,
    give: detail.give,
    get: detail.get,
    tradeCount: detail.tradeCount,
    timeOverlap: detail.timeOverlap,
    myState: detail.myState,
    partnerState: detail.partnerState,
    partnerBusy: detail.partnerBusy ?? false,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    snapshot: detail.snapshot
  };
}

function buildSnapshot(pair, myId) {
  const detail = pairDetail(pair, myId);
  return {
    // 标记完成时双方牌匣可能已更新而不再互补，partner 无条件取自 pair 数据，
    // 牌信息优先用客户端提交的商定内容，重新计算结果兜底。
    partner: {
      uid: detail.partner.uid,
      nickname: detail.partner.nickname,
      level: detail.partner.level,
      serverLabel: detail.partner.serverLabel,
      timeSlots: detail.partner.timeSlots,
      updatedAt: detail.partner.updatedAt
    },
    // 实时计算为空（对方先完成并更新了牌匣）时退回换向后的快照。
    give: detail.give.length ? detail.give : (detail.snapshot?.give ?? []),
    get: detail.get.length ? detail.get : (detail.snapshot?.get ?? []),
    tradeCount: detail.tradeCount || detail.snapshot?.tradeCount || 0,
    timeOverlap: detail.give.length ? detail.timeOverlap : (detail.snapshot?.timeOverlap ?? false),
    completedAt: Date.now()
  };
}

async function findPairFor(store, listingId, pairId) {
  const pairs = await store.listPairsWithListings(listingId);
  for (const pair of pairs) {
    if ((await publicPairId(pair.id)) === pairId) return pair;
  }
  return null;
}

async function fetchProfile(env, store, uid) {
  const now = Date.now();
  const cached = await store.getProfile(uid);
  if (cached) {
    const ttl = cached.source === "enka" ? RULES.profileTtlMs : RULES.profileFailTtlMs;
    if (now - cached.fetched_at < ttl) return cached;
  }
  let profile;
  try {
    const base = env.ENKA_BASE ?? "https://enka.network";
    const response = await fetch(`${base}/api/uid/${uid}?info`, {
      headers: { "User-Agent": env.ENKA_UA ?? "moon-card-exchange/1.0" },
      signal: AbortSignal.timeout(4000)
    });
    if (response.status === 404) {
      return { error: { code: "UID_NOT_FOUND", message: "查不到这个 UID，请确认后重试" } };
    }
    if (!response.ok) throw new Error(`enka ${response.status}`);
    const data = await response.json();
    profile = {
      uid,
      nickname: sanitizeNickname(data.playerInfo?.nickname),
      level: data.playerInfo?.level ?? null,
      region: data.region ?? null,
      source: "enka",
      fetched_at: now
    };
  } catch {
    profile = { uid, nickname: "旅行者", level: null, region: null, source: "fallback", fetched_at: now };
  }
  await store.upsertProfile(profile);
  return profile;
}

export async function cleanup(store) {
  const now = Date.now();
  const purgeBefore = now - RULES.purgeAfterDays * DAY;
  const ids = await store.listExpiredListingIds(purgeBefore);
  for (const id of ids) {
    await store.deletePairsForListing(id);
    await store.deleteReportsForListing(id);
    await store.deleteListing(id);
  }
  await store.deleteProfilesBefore(now - 7 * DAY);
  await store.deleteRateLimitsBefore(now - 2 * DAY);
}

export function createApp(env = {}, store) {
  if (!store) throw new Error("createApp 需要传入 store");
  const app = new Hono();
  // 函数实例常驻期间复用统计结果；冷启动后自动重算。
  let statsCache = { at: 0, payload: null };

  const allowedOrigins = () =>
    String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

  app.use("/v1/*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && allowedOrigins().includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      c.header("Access-Control-Max-Age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  const auth = async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return err(401, "UNAUTHORIZED", "缺少恢复码令牌");
    const hash = await sha256Hex(token);
    const row = await store.getListingByTokenHash(hash);
    if (!row) return err(401, "UNAUTHORIZED", "恢复码无效或已删除");
    c.set("listing", row);
    c.set("tokenHash", hash);
    await next();
  };

  const limitWrites = async (c, next) => {
    const count = await store.incrementRateLimit(`w:${c.get("tokenHash")}`, Date.now(), HOUR);
    if (count > 60) return err(429, "RATE_LIMITED", "操作太频繁了，请稍后再试");
    await next();
  };

  app.onError((error, c) => {
    console.error(error);
    return err(500, "INTERNAL", "服务器开小差了，请稍后再试");
  });
  app.notFound((c) => err(404, "NOT_FOUND", "接口不存在"));

  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.get("/v1/stats", async (c) => {
    const now = Date.now();
    c.header("Cache-Control", "public, max-age=600");
    if (statsCache.payload && now - statsCache.at < RULES.matchCacheMinutes * MINUTE) {
      return c.json(statsCache.payload);
    }
    const byGroup = await store.countActiveListings(now);
    const payload = {
      activeListings: Object.values(byGroup).reduce((sum, n) => sum + n, 0),
      byGroup,
      completedPairs: await store.countCompletedPairs()
    };
    statsCache = { at: now, payload };
    return c.json(payload);
  });

  app.get("/v1/profile/:uid", async (c) => {
    const uid = c.req.param("uid");
    if (!serverGroupFromUid(uid)) return err(400, "UID_INVALID", "UID 应为 9–10 位数字");
    const ipKey = await hmacHex(env.RATE_SALT ?? "dev-salt", clientIp(c));
    const count = await store.incrementRateLimit(`profile:${ipKey}`, Date.now(), MINUTE);
    if (count > 30) return err(429, "RATE_LIMITED", "查询太频繁了，请稍后再试");
    const profile = await fetchProfile(env, store, uid);
    if (profile.error) return err(404, profile.error.code, profile.error.message);
    const group = regionToServerGroup(profile.region) ?? serverGroupFromUid(uid);
    return c.json({
      uid,
      serverGroup: group,
      serverLabel: regionToServerName(profile.region) ?? serverNameFromUid(uid) ?? SERVER_GROUPS[group] ?? group,
      nickname: profile.nickname,
      level: profile.level,
      source: profile.source
    });
  });

  app.post("/v1/listings", async (c) => {
    const ipKey = await hmacHex(env.RATE_SALT ?? "dev-salt", clientIp(c));
    const count = await store.incrementRateLimit(`create:${ipKey}`, Date.now(), DAY);
    if (count > 5) return err(429, "RATE_LIMITED", "今天创建的登记太多了，请明天再来");
    const body = await c.req.json().catch(() => null);
    const validated = validateListingInput(body);
    if (!validated.ok) return err(400, validated.error.code, validated.error.message);
    const input = validated.value;
    const profile = await fetchProfile(env, store, input.uid);
    if (profile.error) return err(404, profile.error.code, profile.error.message);
    const now = Date.now();
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const serverGroup = regionToServerGroup(profile.region) ?? serverGroupFromUid(input.uid);
    const row = {
      id: tokenHash,
      token_hash: tokenHash,
      uid: input.uid,
      server_group: serverGroup,
      nickname: profile.nickname,
      level: profile.level ?? 0,
      profile_source: profile.source,
      counts: JSON.stringify(input.counts),
      spare_mask: spareMaskFromCounts(input.counts),
      want_mask: wantMaskFromIds(input.want, input.counts),
      time_mask: timeMask(input.timeSlots),
      status: "active",
      created_at: now,
      updated_at: now,
      expires_at: now + DEFAULT_TTL,
      matched_at: null
    };
    try {
      await store.createListing(row);
    } catch (error) {
      if (error?.code === "UID_TAKEN") {
        return err(409, "UID_TAKEN", "这个 UID 已经登记过了。请使用恢复码导入找回登记");
      }
      throw error;
    }
    return c.json({ listing: listingView(row), token });
  });

  app.use("/v1/listings/me", auth);
  app.get("/v1/listings/me", (c) => c.json({ listing: listingView(c.get("listing")) }));
  app.put("/v1/listings/me", limitWrites, async (c) => {
    const row = c.get("listing");
    const body = await c.req.json().catch(() => null);
    const validated = validateListingInput(body);
    if (!validated.ok) return err(400, validated.error.code, validated.error.message);
    const input = validated.value;
    if (input.uid !== row.uid) return err(400, "INVALID_INPUT", "UID 不可修改，如需换号请先删除登记");
    const profile = await fetchProfile(env, store, row.uid);
    const now = Date.now();
    const updated = await store.updateListingFields(row.id, {
      counts: JSON.stringify(input.counts),
      spare_mask: spareMaskFromCounts(input.counts),
      want_mask: wantMaskFromIds(input.want, input.counts),
      time_mask: timeMask(input.timeSlots),
      nickname: profile.error ? row.nickname : profile.nickname,
      level: profile.error ? row.level : (profile.level ?? 0),
      profile_source: profile.error ? row.profile_source : profile.source,
      updated_at: now,
      expires_at: now + DEFAULT_TTL,
      matched_at: null
    });
    return c.json({ listing: listingView(updated ?? row) });
  });
  app.delete("/v1/listings/me", limitWrites, async (c) => {
    const row = c.get("listing");
    await store.deletePairsForListing(row.id);
    await store.deleteReportsForListing(row.id);
    await store.deleteListing(row.id);
    return c.json({ ok: true });
  });

  app.use("/v1/matches", auth);
  app.get("/v1/matches", async (c) => {
    const row = c.get("listing");
    const now = Date.now();
    const rowActive = row.status === "active" && row.expires_at > now;
    const cacheValid =
      row.matched_at != null &&
      row.matched_at !== 0 &&
      now - row.matched_at < RULES.matchCacheMinutes * MINUTE &&
      row.updated_at <= row.matched_at;
    if (!cacheValid && rowActive) {
      const candidates = await store.listCandidates({
        serverGroup: row.server_group,
        excludeId: row.id,
        wantMask: row.want_mask,
        spareMask: row.spare_mask,
        now,
        limit: RULES.candidateLimit
      });
      const scored = candidates
        .map((candidate) => {
          const evaluation = evaluatePair(toPairInput(row), toPairInput(candidate));
          return evaluation
            ? {
                candidate,
                tradeCount: evaluation.tradeCount,
                timeOverlap: evaluation.timeOverlap,
                partner: { updatedAt: candidate.updated_at }
              }
            : null;
        })
        .filter(Boolean)
        .sort(compareCandidates)
        .slice(0, RULES.pairSeedLimit);
      for (const entry of scored) {
        const [lowId, highId] = [row.id, entry.candidate.id].sort();
        await store.insertPairIfAbsent({
          id: `${lowId}|${highId}`,
          low_id: lowId,
          high_id: highId,
          low_state: "active",
          high_state: "active",
          low_snapshot: "",
          high_snapshot: "",
          created_at: now,
          updated_at: now
        });
      }
      await store.updateListingFields(row.id, { matched_at: now });
    }
    const pairs = await store.listPairsWithListings(row.id);
    const ids = new Map();
    for (const pair of pairs) ids.set(pair.id, await publicPairId(pair.id));
    const details = pairs.map((pair) => pairDetail(pair, row.id));
    // 一次性收集所有处于"正在交换"一侧的登记，用于给匹配标注对方忙碌。
    const engagedIds = new Set(await store.listEngagedListingIds());
    for (const detail of details) {
      detail.partnerBusy = engagedIds.has(detail.partnerId);
    }
    const active = details
      // 交换中的匹配即使牌匣已更新不再互补也要保留，双方还要靠它完成交换。
      .filter((view) => rowActive && (view.myState === "exchanging" || (!view.stale && view.myState === "active")))
      .sort(
        (a, b) =>
          b.tradeCount - a.tradeCount ||
          Number(b.timeOverlap) - Number(a.timeOverlap) ||
          b.partner.updatedAt - a.partner.updatedAt
      )
      .slice(0, RULES.matchLimit)
      .map((view) => cleanPairView(view, ids.get(view.pairKey)));
    const records = details
      .filter((view) => view.myState === "completed" || view.myState === "hidden")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RULES.recordLimit)
      .map((view) => cleanPairView(view, ids.get(view.pairKey)));
    return c.json({ active, records });
  });

  app.use("/v1/pairs/:id/state", auth, limitWrites);
  app.post("/v1/pairs/:id/state", async (c) => {
    const row = c.get("listing");
    const pairId = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const state = body?.state;
    if (!["active", "exchanging", "completed", "hidden"].includes(state)) {
      return err(400, "INVALID_INPUT", "state 只能是 active、exchanging、completed 或 hidden");
    }
    // completed 请求可携带客户端商定的交换内容（give/get 为牌 id 数组）。
    const clientSnapshot = body?.snapshot;
    let snapshotCards = null;
    if (clientSnapshot && Array.isArray(clientSnapshot.give) && Array.isArray(clientSnapshot.get)) {
      // 牌数上限 22：只接受合法牌 id，截断异常长的数组。
      const giveIds = clientSnapshot.give.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length);
      const getIds = clientSnapshot.get.filter((id) => CARD_BY_ID[id]).slice(0, CARDS.length);
      // 双侧牌面都确认非空才采用客户端快照；任一侧为空时
      // 退回服务端重新计算（或换向快照）的结果，避免空数组覆盖。
      if (giveIds.length && getIds.length) {
        snapshotCards = { give: giveIds, get: getIds, tradeCount: Math.min(giveIds.length, getIds.length) };
      }
    }
    const pair = await findPairFor(store, row.id, pairId);
    if (!pair) return err(404, "NOT_FOUND", "没有找到这条匹配记录");
    const iAmLow = pair.a_id === row.id;
    const myState = iAmLow ? pair.low_state : pair.high_state;
    const partnerState = iAmLow ? pair.high_state : pair.low_state;
    const now = Date.now();
    // 申请交换：双方一起进入"正在交换"，此后互相可见 UID。
    if (state === "exchanging") {
      if (myState !== "active" && myState !== "exchanging") {
        return err(409, "INVALID_INPUT", "当前状态不能申请交换");
      }
      await store.updatePairFields(pair.id, {
        updated_at: now,
        low_state: "exchanging",
        high_state: "exchanging"
      });
      return c.json({ ok: true });
    }
    // 标记完成必须在申请交换之后，避免绕过申请直接改动牌匣。
    if (state === "completed" && myState !== "exchanging") {
      return err(409, "INVALID_INPUT", "请先申请交换，实际交换完成后再标记已交换");
    }
    const patch = { updated_at: now, [iAmLow ? "low_state" : "high_state"]: state };
    // 双方都在交换中时，取消或隐藏会把对方一起放回匹配池。
    if ((state === "active" || state === "hidden") && myState === "exchanging" && partnerState === "exchanging") {
      patch[iAmLow ? "high_state" : "low_state"] = "active";
    }
    if (state === "completed") {
      const snapshot = buildSnapshot(pair, row.id);
      if (snapshotCards) {
        snapshot.give = snapshotCards.give;
        snapshot.get = snapshotCards.get;
        snapshot.tradeCount = snapshotCards.tradeCount;
      }
      patch[iAmLow ? "low_snapshot" : "high_snapshot"] = JSON.stringify(snapshot);
    }
    await store.updatePairFields(pair.id, patch);
    return c.json({ ok: true });
  });

  app.use("/v1/reports", auth, limitWrites);
  app.post("/v1/reports", async (c) => {
    const row = c.get("listing");
    const body = await c.req.json().catch(() => null);
    const pairId = body?.pairId;
    const reason = body?.reason;
    if (!REPORT_REASONS.includes(reason)) return err(400, "INVALID_INPUT", "举报理由只能从预设选项中选择");
    const pair = await findPairFor(store, row.id, pairId);
    if (!pair) return err(404, "NOT_FOUND", "只能举报与自己匹配过的旅行者");
    const targetId = pair.a_id === row.id ? pair.b_id : pair.a_id;
    await store.insertReportIfAbsent({ reporterId: row.id, targetId, reason, createdAt: Date.now() });
    const reporters = await store.countDistinctReporters(targetId);
    if (reporters >= RULES.suspendReports) {
      const target = await store.getListingById(targetId);
      if (target && target.status === "active") {
        await store.updateListingFields(targetId, { status: "suspended" });
      }
    }
    return c.json({ ok: true, reported: true });
  });

  return app;
}

// 生产入口用：按环境变量组装运行时存储（Tablestore），测试与本地开发直接
// 传入 createMemoryStore()。动态引入避免测试包加载 Tablestore SDK。
export async function createDefaultApp(env = {}) {
  const module = await import("./store/runtime.js");
  return createApp(env, module.createRuntimeStore(env));
}

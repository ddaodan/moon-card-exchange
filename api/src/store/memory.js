// 内存存储实现：与 Tablestore 生产实现共用同一套接口。
// 测试环境使用（每个用例新建一个实例），本地开发也可以用它跑通全部接口。

function uid() {
  return crypto.randomUUID();
}

export function createMemoryStore() {
  const listings = new Map(); // id -> row
  const pairs = new Map(); // `${lowId}|${highId}` -> row
  const reports = []; // { reporter_id, target_id, reason, created_at }
  const profiles = new Map(); // uid -> row
  const rateLimits = new Map(); // key -> { window_start, count }

  const store = {
    // ---------- listings ----------
    async createListing(row) {
      for (const existing of listings.values()) {
        if (existing.uid === row.uid) {
          const error = new Error("UID_TAKEN");
          error.code = "UID_TAKEN";
          throw error;
        }
      }
      const withId = { ...row, id: row.id ?? uid() };
      listings.set(withId.id, { ...withId });
      return { ...withId };
    },

    async getListingById(id) {
      const row = listings.get(id);
      return row ? { ...row } : null;
    },

    async getListingByTokenHash(tokenHash) {
      for (const row of listings.values()) {
        if (row.token_hash === tokenHash) return { ...row };
      }
      return null;
    },

    async getListingByUid(targetUid) {
      for (const row of listings.values()) {
        if (row.uid === targetUid) return { ...row };
      }
      return null;
    },

    // patch 为部分字段覆盖，测试也用它直接改 expires_at / status 等。
    async updateListingFields(id, patch) {
      const row = listings.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },

    async deleteListing(id) {
      listings.delete(id);
    },

    async listCandidates({ serverGroup, excludeId, wantMask, spareMask, now, limit }) {
      const rows = [...listings.values()]
        .filter(
          (row) =>
            row.server_group === serverGroup &&
            row.status === "active" &&
            row.expires_at > now &&
            row.id !== excludeId &&
            (row.spare_mask & wantMask) !== 0 &&
            (row.want_mask & spareMask) !== 0
        )
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return rows.map((row) => ({ ...row }));
    },

    async listExpiredListingIds(purgeBefore) {
      return [...listings.values()].filter((row) => row.expires_at < purgeBefore).map((row) => row.id);
    },

    async countActiveListings(now) {
      const byGroup = {};
      for (const row of listings.values()) {
        if (row.status !== "active" || row.expires_at <= now) continue;
        byGroup[row.server_group] = (byGroup[row.server_group] ?? 0) + 1;
      }
      return byGroup;
    },

    // ---------- pairs ----------
    // id 由调用方按 `${lowId}|${highId}` 生成，天然唯一；已存在时返回 false。
    async insertPairIfAbsent(row) {
      const key = row.id;
      if (pairs.has(key)) return false;
      pairs.set(key, { ...row });
      return true;
    },

    async getPairById(id) {
      const row = pairs.get(id);
      return row ? { ...row } : null;
    },

    // 返回与 listingId 相关的全部 pair，并拼上双方 listing 字段（对齐原 SQL JOIN 结果）。
    async listPairsWithListings(listingId) {
      const result = [];
      for (const pair of pairs.values()) {
        if (pair.low_id !== listingId && pair.high_id !== listingId) continue;
        const low = listings.get(pair.low_id);
        const high = listings.get(pair.high_id);
        if (!low || !high) continue; // 清理任务保证不会出现，防御性跳过
        result.push({
          ...pair,
          a_id: low.id,
          a_spare: low.spare_mask,
          a_want: low.want_mask,
          a_time: low.time_mask,
          a_status: low.status,
          a_expires: low.expires_at,
          a_uid: low.uid,
          a_nickname: low.nickname,
          a_level: low.level,
          a_group: low.server_group,
          a_updated: low.updated_at,
          b_id: high.id,
          b_spare: high.spare_mask,
          b_want: high.want_mask,
          b_time: high.time_mask,
          b_status: high.status,
          b_expires: high.expires_at,
          b_uid: high.uid,
          b_nickname: high.nickname,
          b_level: high.level,
          b_group: high.server_group,
          b_updated: high.updated_at
        });
      }
      return result;
    },

    async updatePairFields(id, patch) {
      const row = pairs.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },

    async deletePairsForListing(listingId) {
      for (const [key, pair] of [...pairs]) {
        if (pair.low_id === listingId || pair.high_id === listingId) pairs.delete(key);
      }
    },

    async countCompletedPairs() {
      let count = 0;
      for (const pair of pairs.values()) {
        if (pair.low_state === "completed" || pair.high_state === "completed") count += 1;
      }
      return count;
    },

    // 处于"正在交换"一侧的登记 id 集合（一次遍历），用于给匹配列表标注对方忙碌。
    async listEngagedListingIds() {
      const ids = new Set();
      for (const pair of pairs.values()) {
        if (pair.low_state === "exchanging") ids.add(pair.low_id);
        if (pair.high_state === "exchanging") ids.add(pair.high_id);
      }
      return [...ids];
    },

    // ---------- reports ----------
    // 同一举报人对同一目标只计一次；已存在时返回 false。
    async insertReportIfAbsent({ reporterId, targetId, reason, createdAt }) {
      const exists = reports.some(
        (report) => report.reporter_id === reporterId && report.target_id === targetId
      );
      if (exists) return false;
      reports.push({ reporter_id: reporterId, target_id: targetId, reason, created_at: createdAt });
      return true;
    },

    async countDistinctReporters(targetId) {
      return new Set(reports.filter((report) => report.target_id === targetId).map((report) => report.reporter_id))
        .size;
    },

    async deleteReportsForListing(listingId) {
      for (const [index, report] of [...reports.entries()].reverse()) {
        if (report.target_id === listingId) reports.splice(index, 1);
      }
    },

    // ---------- profiles ----------
    async getProfile(targetUid) {
      const row = profiles.get(targetUid);
      return row ? { ...row } : null;
    },

    async upsertProfile(profile) {
      profiles.set(profile.uid, { ...profile });
    },

    async deleteProfilesBefore(beforeTs) {
      for (const [key, row] of [...profiles]) {
        if (row.fetched_at < beforeTs) profiles.delete(key);
      }
    },

    // ---------- rate limits ----------
    // 固定窗口计数：窗口过期则重置。返回当前窗口内的计数。
    // 内存实现运行在单线程事件循环里，读改写之间没有 await，天然原子。
    async incrementRateLimit(key, now, windowMs) {
      const existing = rateLimits.get(key);
      if (!existing || now - existing.window_start >= windowMs) {
        rateLimits.set(key, { window_start: now, count: 1 });
        return 1;
      }
      existing.count += 1;
      return existing.count;
    },

    async deleteRateLimitsBefore(beforeTs) {
      for (const [key, row] of [...rateLimits]) {
        if (row.window_start < beforeTs) rateLimits.delete(key);
      }
    },

    // ---------- 测试辅助 ----------
    debugRateLimits() {
      return [...rateLimits.entries()].map(([key, value]) => ({ key, ...value }));
    }
  };

  return store;
}

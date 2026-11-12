// 阿里云 Tablestore（OTS）存储实现：宽表模型，接口与 memory.js 完全一致。
// 建表脚本见 api/scripts/create-tables.mjs
// 表结构：listings / pairs / reports / profiles / rate_limits

import TableStore from "tablestore";

function call(fn) {
  return new Promise((resolve, reject) => {
    fn((error, data) => (error ? reject(error) : resolve(data)));
  });
}

function toPlain(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber();
  return value;
}

export function rowToObject(row) {
  const obj = {};
  // 主键列是 {name, value}；属性列是 {columnName, columnValue}（SDK 差异）。
  for (const part of row?.primaryKey ?? []) obj[part.name] = toPlain(part.value);
  for (const attr of row?.attributes ?? []) obj[attr.columnName] = toPlain(attr.columnValue);
  return obj;
}

function isEmptyRow(row) {
  return !row || ((row.attributes?.length ?? 0) === 0 && (row.primaryKey?.length ?? 0) === 0);
}

export function normalizeListing(row) {
  return {
    ...row,
    id: row.id ?? row.token_hash,
    spare_mask: Number(row.spare_mask),
    want_mask: Number(row.want_mask),
    time_mask: Number(row.time_mask),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    expires_at: Number(row.expires_at),
    matched_at: row.matched_at ? Number(row.matched_at) : null
  };
}

function normalizePair(row) {
  return {
    ...row,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    low_snapshot: row.low_snapshot || null,
    high_snapshot: row.high_snapshot || null
  };
}

function listingColumns(row) {
  return {
    uid: row.uid,
    server_group: row.server_group,
    nickname: row.nickname,
    level: row.level ?? 0,
    profile_source: row.profile_source,
    counts: row.counts,
    spare_mask: row.spare_mask,
    want_mask: row.want_mask,
    time_mask: row.time_mask,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    matched_at: row.matched_at ?? 0
  };
}

function isConditionFailed(error) {
  return /condition/i.test(String(error?.name ?? "") + String(error?.message ?? ""));
}

// SDK 的 attributeColumns 元素只取第一个键作为列名（见 writeColumns 的 break），
// 必须传 [{列名: 值}]，不能传 [{name, value}]。
export function toAttributeColumns(columns) {
  return Object.entries(columns).map(([name, value]) => ({ [name]: value }));
}

export function createTablestoreStore(env) {
  const client = new TableStore.Client({
    accessKeyId: env.OTS_ACCESS_KEY_ID,
    secretAccessKey: env.OTS_ACCESS_KEY_SECRET,
    endpoint: env.OTS_ENDPOINT,
    instancename: env.OTS_INSTANCE,
    maxRetries: 3
  });

  async function getRow(table, pkName, pkValue) {
    const data = await call((cb) =>
      client.getRow({ tableName: table, primaryKey: [{ [pkName]: pkValue }] }, cb)
    );
    return isEmptyRow(data.row) ? null : rowToObject(data.row);
  }

  async function putRowExpectNotExist(table, pkName, pkValue, columns) {
    await call((cb) =>
      client.putRow(
        {
          tableName: table,
          condition: new TableStore.Condition(TableStore.RowExistenceExpectation.EXPECT_NOT_EXIST, null),
          primaryKey: [{ [pkName]: pkValue }],
          attributeColumns: toAttributeColumns(columns)
        },
        cb
      )
    );
  }

  // 读出整行、合并补丁后整行覆盖写入。玩具规模下读改写延迟可以接受。
  async function putRowExpectExist(table, pkName, pkValue, columns) {
    await call((cb) =>
      client.putRow(
        {
          tableName: table,
          condition: new TableStore.Condition(TableStore.RowExistenceExpectation.EXPECT_EXIST, null),
          primaryKey: [{ [pkName]: pkValue }],
          attributeColumns: toAttributeColumns(columns)
        },
        cb
      )
    );
  }

  async function deleteRow(table, pkName, pkValue) {
    await call((cb) =>
      client.deleteRow(
        {
          tableName: table,
          primaryKey: [{ [pkName]: pkValue }],
          // SDK 要求显式条件，不传会在编码阶段抛 TypeError。
          condition: new TableStore.Condition(TableStore.RowExistenceExpectation.IGNORE, null)
        },
        cb
      )
    );
  }

  // 全表扫描（含翻页）。玩具规模下（登记 ≤ 数百条）足够。
  async function scan(table, pkName) {
    const rows = [];
    let inclusiveStart = TableStore.INF_MIN;
    for (let page = 0; page < 200; page += 1) {
      const data = await call((cb) =>
        client.getRange(
          {
            tableName: table,
            direction: TableStore.Direction.FORWARD,
            inclusiveStartPrimaryKey: [{ [pkName]: inclusiveStart }],
            exclusiveEndPrimaryKey: [{ [pkName]: TableStore.INF_MAX }],
            limit: 100
          },
          cb
        )
      );
      for (const row of data.rows) rows.push(rowToObject(row));
      const next = data.next_start_primary_key?.find((part) => part.name === pkName);
      if (!next) return rows;
      inclusiveStart = toPlain(next.value);
    }
    throw new Error(`扫描 ${table} 超过页数上限`);
  }

  const store = {
    // ---------- listings ----------
    async createListing(row) {
      // uid 不是主键，扫全表过滤查重（玩具规模可接受）；主键 token_hash 的
      // 唯一性由 EXPECT_NOT_EXIST 条件写兜底。
      const all = await scan("listings", "token_hash");
      const byUid = all.map(normalizeListing).find((item) => item.uid === row.uid);
      if (byUid) {
        const error = new Error("UID_TAKEN");
        error.code = "UID_TAKEN";
        throw error;
      }
      try {
        await putRowExpectNotExist("listings", "token_hash", row.token_hash, listingColumns(row));
      } catch (error) {
        if (isConditionFailed(error)) {
          const taken = new Error("UID_TAKEN");
          taken.code = "UID_TAKEN";
          throw taken;
        }
        throw error;
      }
      return normalizeListing(row);
    },

    async getListingById(id) {
      const row = await getRow("listings", "token_hash", id);
      return row ? normalizeListing(row) : null;
    },

    async getListingByTokenHash(tokenHash) {
      return store.getListingById(tokenHash);
    },

    async getListingByUid(targetUid) {
      const all = await scan("listings", "token_hash");
      const row = all.map(normalizeListing).find((item) => item.uid === targetUid);
      return row ?? null;
    },

    async updateListingFields(id, patch) {
      const row = await getRow("listings", "token_hash", id);
      if (!row) return null;
      const merged = normalizeListing({ ...row, ...patch });
      await putRowExpectExist("listings", "token_hash", id, listingColumns(merged));
      return merged;
    },

    async deleteListing(id) {
      requireId(id, "登记");
      await deleteRow("listings", "token_hash", id);
    },

    async listCandidates({ serverGroup, excludeId, wantMask, spareMask, now, limit }) {
      const all = await scan("listings", "token_hash");
      return all
        .map(normalizeListing)
        .filter(
          (row) =>
            row.server_group === serverGroup &&
            row.status === "active" &&
            row.expires_at > now &&
            row.token_hash !== excludeId &&
            (row.spare_mask & wantMask) !== 0 &&
            (row.want_mask & spareMask) !== 0
        )
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
    },

    async listExpiredListingIds(purgeBefore) {
      const all = await scan("listings", "token_hash");
      return all
        .map(normalizeListing)
        .filter((row) => row.expires_at < purgeBefore)
        .map((row) => row.token_hash);
    },

    async countActiveListings(now) {
      const all = await scan("listings", "token_hash");
      const byGroup = {};
      for (const row of all.map(normalizeListing)) {
        if (row.status !== "active" || row.expires_at <= now) continue;
        byGroup[row.server_group] = (byGroup[row.server_group] ?? 0) + 1;
      }
      return byGroup;
    },

    // ---------- pairs ----------
    async insertPairIfAbsent(row) {
      try {
        await putRowExpectNotExist("pairs", "id", row.id, {
          low_id: row.low_id,
          high_id: row.high_id,
          low_state: row.low_state,
          high_state: row.high_state,
          low_snapshot: row.low_snapshot ?? "",
          high_snapshot: row.high_snapshot ?? "",
          created_at: row.created_at,
          updated_at: row.updated_at
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async getPairById(id) {
      const row = await getRow("pairs", "id", id);
      return row ? normalizePair(row) : null;
    },

    // 扫描过滤出与我相关的 pair，再逐条取双方 listing 拼成与原 SQL JOIN 一致的形状。
    async listPairsWithListings(listingId) {
      const all = await scan("pairs", "id");
      const related = all
        .map(normalizePair)
        .filter((pair) => pair.low_id === listingId || pair.high_id === listingId);
      const result = [];
      for (const pair of related) {
        const low = await getRow("listings", "token_hash", pair.low_id);
        const high = await getRow("listings", "token_hash", pair.high_id);
        if (!low || !high) continue;
        const a = normalizeListing(low);
        const b = normalizeListing(high);
        result.push({
          ...pair,
          a_id: a.token_hash,
          a_spare: a.spare_mask,
          a_want: a.want_mask,
          a_time: a.time_mask,
          a_status: a.status,
          a_expires: a.expires_at,
          a_uid: a.uid,
          a_nickname: a.nickname,
          a_level: a.level,
          a_group: a.server_group,
          a_updated: a.updated_at,
          b_id: b.token_hash,
          b_spare: b.spare_mask,
          b_want: b.want_mask,
          b_time: b.time_mask,
          b_status: b.status,
          b_expires: b.expires_at,
          b_uid: b.uid,
          b_nickname: b.nickname,
          b_level: b.level,
          b_group: b.server_group,
          b_updated: b.updated_at
        });
      }
      return result;
    },

    async updatePairFields(id, patch) {
      const row = await getRow("pairs", "id", id);
      if (!row) return null;
      const current = normalizePair(row);
      const merged = normalizePair({ ...current, ...patch });
      await putRowExpectExist("pairs", "id", id, {
        low_id: merged.low_id,
        high_id: merged.high_id,
        low_state: merged.low_state,
        high_state: merged.high_state,
        low_snapshot: merged.low_snapshot ?? "",
        high_snapshot: merged.high_snapshot ?? "",
        created_at: merged.created_at,
        updated_at: merged.updated_at
      });
      return merged;
    },

    async deletePairsForListing(listingId) {
      requireId(listingId, "匹配");
      const all = await scan("pairs", "id");
      for (const pair of all.map(normalizePair)) {
        if (pair.low_id === listingId || pair.high_id === listingId) {
          await deleteRow("pairs", "id", pair.id);
        }
      }
    },

    async countCompletedPairs() {
      const all = await scan("pairs", "id");
      return all.map(normalizePair).filter(
        (pair) => pair.low_state === "completed" || pair.high_state === "completed"
      ).length;
    },

    // 处于"正在交换"一侧的登记 id 集合（一次扫描），用于给匹配列表标注对方忙碌。
    async listEngagedListingIds() {
      const all = await scan("pairs", "id");
      const ids = new Set();
      for (const pair of all.map(normalizePair)) {
        if (pair.low_state === "exchanging") ids.add(pair.low_id);
        if (pair.high_state === "exchanging") ids.add(pair.high_id);
      }
      return [...ids];
    },

    // ---------- reports ----------
    // 主键为 reporter_id，同一举报人的多条举报存在同一行里时会冲突，
    // 因此这里用「reporter_id + target_id 拼键」保证唯一：见 insertReportIfAbsent。
    async insertReportIfAbsent({ reporterId, targetId, reason, createdAt }) {
      const key = `${reporterId}|${targetId}`;
      try {
        await putRowExpectNotExist("reports", "key", key, {
          reporter_id: reporterId,
          target_id: targetId,
          reason,
          created_at: createdAt
        });
        return true;
      } catch (error) {
        if (isConditionFailed(error)) return false;
        throw error;
      }
    },

    async countDistinctReporters(targetId) {
      const all = await scan("reports", "key");
      return new Set(all.filter((row) => row.target_id === targetId).map((row) => row.reporter_id)).size;
    },

    async deleteReportsForListing(listingId) {
      requireId(listingId, "举报");
      const all = await scan("reports", "key");
      for (const row of all) {
        if (row.target_id === listingId) await deleteRow("reports", "key", row.key);
      }
    },

    // ---------- profiles ----------
    async getProfile(targetUid) {
      const row = await getRow("profiles", "uid", targetUid);
      return row ? { ...row, fetched_at: Number(row.fetched_at) } : null;
    },

    async upsertProfile(profile) {
      const existing = await getRow("profiles", "uid", profile.uid);
      const columns = {
        nickname: profile.nickname,
        level: profile.level ?? 0,
        region: profile.region ?? "",
        source: profile.source,
        fetched_at: profile.fetched_at
      };
      if (existing) await putRowExpectExist("profiles", "uid", profile.uid, columns);
      else await putRowExpectNotExist("profiles", "uid", profile.uid, columns);
    },

    async deleteProfilesBefore(beforeTs) {
      const all = await scan("profiles", "uid");
      for (const row of all) {
        requireId(row.uid, "资料缓存");
        if (Number(row.fetched_at) < beforeTs) await deleteRow("profiles", "uid", row.uid);
      }
    },

    // ---------- rate limits ----------
    // 固定窗口计数，用条件更新保证跨实例并发安全：
    // 窗口过期时写回 count=1，否则 count+1；条件不满足则重试。
    async incrementRateLimit(key, now, windowMs) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await getRow("rate_limits", "key", key);
        if (!row) {
          try {
            await putRowExpectNotExist("rate_limits", "key", key, { window_start: now, count: 1 });
            return 1;
          } catch (error) {
            if (!isConditionFailed(error)) throw error;
            continue;
          }
        }
        const windowStart = Number(row.window_start);
        const count = Number(row.count);
        // 历史脏数据（NaN 计数）或过期窗口都按新窗口重新计数。
        const isNewWindow =
          !Number.isFinite(windowStart) || !Number.isFinite(count) || now - windowStart >= windowMs;
        const nextCount = isNewWindow ? 1 : count + 1;
        const nextStart = isNewWindow ? now : windowStart;
        try {
          await putRowExpectExist("rate_limits", "key", key, { window_start: nextStart, count: nextCount });
          return nextCount;
        } catch (error) {
          if (!isConditionFailed(error)) throw error;
        }
      }
      // 极端并发下保守拒绝，避免放大写入。
      return Number.MAX_SAFE_INTEGER;
    },

    async deleteRateLimitsBefore(beforeTs) {
      const all = await scan("rate_limits", "key");
      for (const row of all) {
        requireId(row.key, "限频记录");
        if (Number(row.window_start) < beforeTs) await deleteRow("rate_limits", "key", row.key);
      }
    }
  };

  return store;
}

function requireId(value, action) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`删除${action}需要有效的行 id`);
  }
}

// 清空 Tablestore 五张表里的全部数据（登记、匹配、举报、资料缓存、限频记录）。
// 用于上线前清理测试数据：node scripts/clear-data.mjs
// 环境变量：OTS_ENDPOINT、OTS_INSTANCE、OTS_ACCESS_KEY_ID、OTS_ACCESS_KEY_SECRET。
import TableStore from "tablestore";

const endpoint = process.env.OTS_ENDPOINT;
const instance = process.env.OTS_INSTANCE;
const accessKeyId = process.env.OTS_ACCESS_KEY_ID;
const accessKeySecret = process.env.OTS_ACCESS_KEY_SECRET;
if (!endpoint || !instance || !accessKeyId || !accessKeySecret) {
  console.error("请先设置 OTS_ENDPOINT、OTS_INSTANCE、OTS_ACCESS_KEY_ID、OTS_ACCESS_KEY_SECRET");
  process.exit(1);
}

const client = new TableStore.Client({
  accessKeyId,
  accessKeySecret,
  endpoint,
  instancename: instance,
  maxRetries: 3
});

function call(fn) {
  return new Promise((resolve, reject) => {
    fn((error, data) => (error ? reject(error) : resolve(data)));
  });
}

const TABLES = [
  { name: "listings", primaryKey: "token_hash" },
  { name: "pairs", primaryKey: "id" },
  { name: "reports", primaryKey: "key" },
  { name: "profiles", primaryKey: "uid" },
  { name: "rate_limits", primaryKey: "key" }
];

for (const table of TABLES) {
  let deleted = 0;
  let inclusiveStart = null;
  let hasMore = true;
  while (hasMore) {
    const range = await call((cb) =>
      client.getRange(
        {
          tableName: table.name,
          direction: TableStore.Direction.FORWARD,
          inclusiveStartPrimaryKey: inclusiveStart ?? [
            { [table.primaryKey]: TableStore.INF_MIN }
          ],
          exclusiveEndPrimaryKey: [{ [table.primaryKey]: TableStore.INF_MAX }],
          limit: 200
        },
        cb
      )
    );
    const rows = range.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      // getRange 返回 [{name, value}]，deleteRow 只认 [{列名: 值}]。
      const primaryKey = row.primaryKey.map((column) => ({ [column.name]: column.value }));
      await call((cb) =>
        client.deleteRow(
          {
            tableName: table.name,
            primaryKey,
            condition: {
              rowExistenceExpectation: TableStore.RowExistenceExpectation.IGNORE
            }
          },
          cb
        )
      );
      deleted += 1;
    }
    const nextStart = range.next_start_primary_key;
    if (!nextStart || nextStart.length === 0) {
      hasMore = false;
    } else {
      inclusiveStart = nextStart.map((column) => ({ [column.name]: column.value }));
    }
  }
  console.log(`${table.name}: 已删除 ${deleted} 行`);
}

console.log("清理完成");

// 在 Tablestore 实例里创建五张表（已存在则跳过）。
// 用法：node scripts/create-tables.mjs
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

const RESERVE = 0;

const tables = [
  {
    name: "listings",
    primaryKeys: [{ name: "token_hash", type: TableStore.PrimaryKeyType.STRING }]
  },
  {
    name: "pairs",
    primaryKeys: [{ name: "id", type: TableStore.PrimaryKeyType.STRING }]
  },
  {
    name: "reports",
    primaryKeys: [{ name: "key", type: TableStore.PrimaryKeyType.STRING }]
  },
  {
    name: "profiles",
    primaryKeys: [{ name: "uid", type: TableStore.PrimaryKeyType.STRING }]
  },
  {
    name: "rate_limits",
    primaryKeys: [{ name: "key", type: TableStore.PrimaryKeyType.STRING }]
  }
];

for (const table of tables) {
  try {
    await call((cb) =>
      client.createTable(
        {
          tableMeta: { tableName: table.name, primaryKey: table.primaryKeys },
          reservedThroughput: {
            capacityUnit: { read: RESERVE, write: RESERVE }
          },
          tableOptions: { timeToLive: -1, maxVersions: 1 }
        },
        cb
      )
    );
    console.log(`已创建表 ${table.name}`);
  } catch (error) {
    if (String(error?.name ?? "").includes("OTSObjectAlreadyExist") || String(error?.message ?? "").includes("already exist")) {
      console.log(`表已存在，跳过：${table.name}`);
    } else {
      throw error;
    }
  }
}

console.log("建表完成。");

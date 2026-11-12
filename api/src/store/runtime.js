// 生产运行时装配：读环境变量创建 Tablestore 存储。
// 环境变量：OTS_ENDPOINT、OTS_INSTANCE、OTS_ACCESS_KEY_ID、OTS_ACCESS_KEY_SECRET。
import { createTablestoreStore } from "./tablestore.js";

export function createRuntimeStore(env) {
  const required = ["OTS_ENDPOINT", "OTS_INSTANCE", "OTS_ACCESS_KEY_ID", "OTS_ACCESS_KEY_SECRET"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`缺少 Tablestore 环境变量：${missing.join(", ")}`);
  }
  return createTablestoreStore(env);
}

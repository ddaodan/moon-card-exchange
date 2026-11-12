// 一键部署：阿里云 FC（HTTP + 定时）+ Tablestore 实例与表。
//
// 用法：
//   $env:ALIBABA_CLOUD_ACCESS_KEY_ID = "你的 AccessKeyId"
//   $env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "你的 AccessKeySecret"
//   npm run deploy
//
// 可选环境变量：
//   FC_REGION            默认 cn-hangzhou
//   FC_FUNCTION_PREFIX   默认 moon-card-exchange
//   OTS_INSTANCE         默认 moon-card
//   RATE_SALT            不传则自动生成并提示保存
//   TOY_ORIGIN           追加到 ALLOWED_ORIGINS 的 Toy 来源

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);

// ─── 参数 ─────────────────────────────────────────────────────────────────────

const akId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const akSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;

if (!akId || !akSecret) {
  console.error("请先设置阿里云 AccessKey 环境变量：");
  console.error('  $env:ALIBABA_CLOUD_ACCESS_KEY_ID = "..."');
  console.error('  $env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "..."');
  console.error("建议使用 RAM 子账号，授予 AliyunOTSFullAccess 和 AliyunFCFullAccess。");
  process.exit(1);
}

const region = process.env.FC_REGION || "cn-hangzhou";
const prefix = process.env.FC_FUNCTION_PREFIX || "moon-card-exchange";
const otsInstanceName = process.env.OTS_INSTANCE || "moon-card";
const rateSalt = process.env.RATE_SALT || randomBytes(32).toString("hex");
const toyOrigin = process.env.TOY_ORIGIN || "";

const FC2 = require("@alicloud/fc2");
const STSPkg = require("@alicloud/sts20150401");
const OTSPkg = require("@alicloud/ots20160620");

let fcClient = null;
let accountId = null;

const otsClient = new OTSPkg.default({
  accessKeyId: akId,
  accessKeySecret: akSecret,
  endpoint: `ots.${region}.aliyuncs.com`,
  regionId: region
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(error) {
  const name = String(error?.name ?? "");
  const message = error?.message ?? String(error);
  const lower = message.toLowerCase();
  if (name.includes("SignatureDoesNotMatch") || lower.includes("signaturenotmatch")) {
    return "AccessKey Secret 不正确，请核对 ALIBABA_CLOUD_ACCESS_KEY_SECRET。";
  }
  if (name.includes("InvalidAccessKeyId") || lower.includes("invalidaccesskeyid")) {
    return "AccessKeyId 不存在，请核对 ALIBABA_CLOUD_ACCESS_KEY_ID。";
  }
  if (lower.includes("forbidden") || lower.includes("not authorized")) {
    return "当前 AccessKey 没有这个操作的权限，请确认 RAM 子账号已授予 AliyunOTSFullAccess 和 AliyunFCFullAccess。";
  }
  if (lower.includes("econnrefused") || lower.includes("etimedout") || lower.includes("enotfound") || lower.includes("econnreset")) {
    return "网络连接失败，请检查本机能否访问阿里云 API。";
  }
  return `${name}: ${message}`;
}

async function step(label, fn) {
  process.stdout.write(`\n[${label}] ... `);
  try {
    const result = await fn();
    console.log("完成");
    return result;
  } catch (error) {
    console.log("失败");
    console.error(`  ${describeError(error)}`);
    throw error;
  }
}

// ─── 函数计算 FC（2.0 API，走 fc.<region> 端点）──────────────────────────────

const serviceName = prefix;

function isNotFound(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  return code.includes("NotFound") || message.includes("not found");
}

async function initFc() {
  const sts = new STSPkg.default({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: "sts.aliyuncs.com"
  });
  const identity = await sts.getCallerIdentity();
  accountId = identity?.body?.accountId;
  if (!accountId) {
    throw new Error("无法通过 STS 获取阿里云账号 ID。");
  }
  fcClient = new FC2(accountId, {
    accessKeyID: akId,
    accessKeySecret: akSecret,
    region,
    secure: true
  });
}

async function ensureFcService() {
  try {
    await fcClient.getService(serviceName);
    console.log("（服务已存在，跳过创建）");
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  await fcClient.createService(serviceName, { description: "月谕圣牌交换站" });
  console.log(`（已创建服务 ${serviceName}）`);
}

// ─── Tablestore 服务与实例 ────────────────────────────────────────────────────

async function ensureOtsService() {
  try {
    const status = await otsClient.getOtsServiceStatus(new OTSPkg.GetOtsServiceStatusRequest({}));
    if (status?.body?.data === true) {
      return; // 已开通。
    }
  } catch {
    // 查询失败继续尝试开通。
  }
  try {
    await otsClient.openOtsService();
    console.log("（已调用开通接口）");
  } catch (error) {
    const msg = String(error?.message ?? "").toLowerCase();
    if (!msg.includes("already") && !msg.includes("opened") && !msg.includes("exist")) {
      throw error;
    }
  }
}

async function ensureOtsInstance() {
  try {
    const found = await otsClient.getInstance(
      new OTSPkg.GetInstanceRequest({ instanceName: otsInstanceName })
    );
    if (found?.body?.instanceInfo?.instanceName === otsInstanceName) {
      console.log("（实例已存在，跳过创建）");
      return;
    }
  } catch {
    // 404 或查询失败都继续尝试创建。
  }
  await otsClient.insertInstance(
    new OTSPkg.InsertInstanceRequest({
      clusterType: "HYBRID",
      instanceName: otsInstanceName,
      description: "月谕圣牌交换站数据存储"
    })
  );
  console.log(`（已创建实例 ${otsInstanceName}）`);
  // 实例创建是异步的，轮询直到可访问。
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    try {
      await otsClient.getInstance(
        new OTSPkg.GetInstanceRequest({ instanceName: otsInstanceName })
      );
      return;
    } catch {
      // 继续等。
    }
  }
  throw new Error("Tablestore 实例创建后长时间不可访问，请稍后到控制台检查状态。");
}

// ─── Tablestore 建表 ──────────────────────────────────────────────────────────

const TableStore = require("tablestore");

const TABLES = [
  { name: "listings", primaryKeys: [{ name: "token_hash", type: TableStore.PrimaryKeyType.STRING }] },
  { name: "pairs", primaryKeys: [{ name: "id", type: TableStore.PrimaryKeyType.STRING }] },
  { name: "reports", primaryKeys: [{ name: "key", type: TableStore.PrimaryKeyType.STRING }] },
  { name: "profiles", primaryKeys: [{ name: "uid", type: TableStore.PrimaryKeyType.STRING }] },
  { name: "rate_limits", primaryKeys: [{ name: "key", type: TableStore.PrimaryKeyType.STRING }] }
];

function callTs(fn) {
  return new Promise((resolve, reject) => {
    fn((error, data) => (error ? reject(error) : resolve(data)));
  });
}

async function createTables() {
  const client = new TableStore.Client({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `https://${otsInstanceName}.${region}.ots.aliyuncs.com`,
    instancename: otsInstanceName,
    maxRetries: 3
  });
  for (const table of TABLES) {
    try {
      await callTs((cb) =>
        client.createTable(
          {
            tableMeta: { tableName: table.name, primaryKey: table.primaryKeys },
            reservedThroughput: { capacityUnit: { read: 0, write: 0 } },
            tableOptions: { timeToLive: -1, maxVersions: 1 }
          },
          cb
        )
      );
      console.log(`（已创建表 ${table.name}）`);
    } catch (error) {
      const msg = String(error?.message ?? "").toLowerCase();
      if (msg.includes("already exist")) {
        console.log(`（表已存在，跳过：${table.name}）`);
      } else {
        throw error;
      }
    }
  }
}

// ─── 打包 FC 代码 ─────────────────────────────────────────────────────────────

const apiRoot = join(fileURLToPath(import.meta.url), "..", "..");
const distFcDir = join(apiRoot, "dist", "fc");
const zipPath = join(apiRoot, "dist", "fc.zip");

async function buildFc() {
  execFileSync(process.execPath, [join(apiRoot, "scripts/build-fc.mjs")], {
    stdio: "inherit",
    cwd: apiRoot
  });
}

async function copyDeps() {
  const nmDir = join(distFcDir, "node_modules");
  mkdirSync(nmDir, { recursive: true });
  // 递归收集 tablestore 的完整依赖闭包，从根 node_modules（workspaces 提升后的扁平结构）复制。
  const rootNm = join(apiRoot, "..", "node_modules");
  const collected = new Set();
  const collect = (name) => {
    if (collected.has(name)) return;
    collected.add(name);
    const pkgPath = join(rootNm, name, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error(`依赖缺失：${name}（请先 npm install）`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const child of Object.keys(pkg.dependencies ?? {})) {
      collect(child);
    }
  };
  collect("tablestore");
  const deps = [...collected];
  for (const dep of deps) {
    const src = join(apiRoot, "..", "node_modules", dep);
    const dst = join(nmDir, dep);
    if (existsSync(src)) {
      await copyDir(src, dst);
    } else {
      throw new Error(`依赖缺失：${dep}（请先 npm install）`);
    }
  }
  console.log(`（共复制 ${deps.length} 个依赖包）`);
}

async function copyDir(src, dst) {
  await import("node:fs/promises").then((fs) => fs.cp(src, dst, { recursive: true }));
}

async function createZip() {
  rmSync(zipPath, { force: true });
  const archiver = (await import("archiver")).default;
  const { createWriteStream } = await import("node:fs");
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  archive.directory(distFcDir, false);
  await archive.finalize();
  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });
}

// ─── FC 函数与触发器 ──────────────────────────────────────────────────────────

const httpFnName = `${prefix}-http`;
const timerFnName = `${prefix}-timer`;

function readZipBase64() {
  return readFileSync(zipPath).toString("base64");
}

function fcEnv() {
  const origins = [
    "https://www.bilibili.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ];
  if (toyOrigin) {
    origins.push(toyOrigin);
  }
  return {
    OTS_ENDPOINT: `https://${otsInstanceName}.${region}.ots.aliyuncs.com`,
    OTS_INSTANCE: otsInstanceName,
    OTS_ACCESS_KEY_ID: akId,
    OTS_ACCESS_KEY_SECRET: akSecret,
    DEBUG_ERRORS: process.env.DEBUG_ERRORS ?? "0",
    RATE_SALT: rateSalt,
    ENKA_UA: "moon-card-exchange/1.0",
    ALLOWED_ORIGINS: origins.join(",")
  };
}

async function deployHttpFunction() {
  const zipFile = readZipBase64();
  const env = fcEnv();
  const body = {
    description: "HTTP 接口",
    runtime: "nodejs20",
    handler: "index.fcHandler",
    memorySize: 512,
    timeout: 60,
    code: { zipFile },
    environmentVariables: env
  };
  try {
    await fcClient.getFunction(serviceName, httpFnName);
    // 已存在，更新代码与环境变量。
    await fcClient.updateFunction(serviceName, httpFnName, body);
    console.log("（函数已存在，已更新代码）");
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await fcClient.createFunction(serviceName, { ...body, functionName: httpFnName });
    console.log("（已创建函数）");
  }
}

async function deployTimerFunction() {
  const zipFile = readZipBase64();
  const env = fcEnv();
  const body = {
    description: "每日定时清理",
    runtime: "nodejs20",
    handler: "fc-timer.fcTimerHandler",
    memorySize: 512,
    timeout: 300,
    code: { zipFile },
    environmentVariables: env
  };
  try {
    await fcClient.getFunction(serviceName, timerFnName);
    await fcClient.updateFunction(serviceName, timerFnName, body);
    console.log("（函数已存在，已更新代码）");
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    await fcClient.createFunction(serviceName, { ...body, functionName: timerFnName });
    console.log("（已创建函数）");
  }
}

async function deployHttpTrigger() {
  try {
    const found = await fcClient.getTrigger(serviceName, httpFnName, "http");
    if (found?.data?.triggerName === "http") {
      console.log("（触发器已存在，跳过）");
      return;
    }
  } catch {
    // 404 继续创建。
  }
  await fcClient.createTrigger(serviceName, httpFnName, {
    triggerName: "http",
    triggerType: "http",
    triggerConfig: {
      authType: "anonymous",
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"]
    }
  });
  console.log("（已创建 HTTP 触发器）");
}

async function deployTimerTrigger() {
  const triggerName = "daily-purge";
  const triggerConfig = {
    // FC 定时触发器为 6 字段（秒 分 时 日 月 周），按 UTC 解析：
    // UTC 20:00 = 北京时间次日 04:00。
    cronExpression: "0 0 20 * * *",
    enable: true,
    payload: "{}"
  };
  try {
    const found = await fcClient.getTrigger(serviceName, timerFnName, triggerName);
    if (found?.data?.triggerName === triggerName) {
      await fcClient.updateTrigger(serviceName, timerFnName, triggerName, {
        triggerConfig
      });
      console.log("（定时触发器已更新）");
      return;
    }
  } catch {
    // 404 继续创建。
  }
  await fcClient.createTrigger(serviceName, timerFnName, {
    triggerName,
    triggerType: "timer",
    triggerConfig
  });
  console.log("（已创建定时触发器）");
}

async function getHttpUrl() {
  // FC 2.0 的 HTTP 触发器公网地址格式固定：https://<accountId>.<region>.fc.aliyuncs.com/<version>/proxy/<service>/<function>/。
  return `https://${accountId}.${region}.fc.aliyuncs.com/2016-08-15/proxy/${serviceName}/${httpFnName}/`;
}

async function smokeTest(url) {
  const base = url.replace(/\/$/, "");
  const response = await fetch(`${base}/v1/health`, {
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok || !text.includes('"ok":true')) {
    throw new Error(`健康检查未通过：HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  // /v1/stats 会读 Tablestore，用来提前暴露 OTS 连通性问题。
  const statsResponse = await fetch(`${base}/v1/stats`, {
    signal: AbortSignal.timeout(15000)
  });
  const statsText = await statsResponse.text();
  if (!statsResponse.ok || !statsText.includes("activeListings")) {
    throw new Error(
      `统计接口（读 Tablestore）未通过：HTTP ${statsResponse.status} ${statsText.slice(0, 200)}。` +
        "若报网络错误，请到 Tablestore 控制台检查实例是否允许公网/VPC 访问。"
    );
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("月谕圣牌交换站 · 一键部署（阿里云 FC + Tablestore）");
  console.log(`地域：${region}   函数前缀：${prefix}   OTS 实例：${otsInstanceName}`);
  if (!process.env.RATE_SALT) {
    console.log(`自动生成 RATE_SALT：${rateSalt}`);
    console.log("请妥善保存这个值，重复部署不传会改变限频 key 的散列结果。");
  }

  await step("开通 Tablestore 服务", ensureOtsService);
  await step("创建 Tablestore 实例", ensureOtsInstance);
  await step("创建数据表", createTables);
  await step("获取阿里云账号 ID", initFc);
  await step("创建 FC 服务", ensureFcService);
  await step("打包 FC 代码", buildFc);
  await step("复制 tablestore 依赖", copyDeps);
  await step("压缩为 ZIP", createZip);
  await step("部署 HTTP 函数", deployHttpFunction);
  await step("部署定时函数", deployTimerFunction);
  await step("创建 HTTP 触发器", deployHttpTrigger);
  await step("创建定时触发器", deployTimerTrigger);

  const url = await getHttpUrl();
  console.log(`\nAPI 地址：${url}`);
  await step("健康检查", () => smokeTest(url));

  console.log("\n部署完成。下一步：");
  console.log(`  $env:VITE_API_BASE = "${url}"`);
  console.log("  npm run build");
  console.log("  然后把 web/dist 上传到 Toy。");
}

main().catch((error) => {
  console.error(`\n部署失败：${describeError(error)}`);
  process.exit(1);
});

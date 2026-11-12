// 用 esbuild CLI 把 FC 双入口（HTTP + 定时）打包成 CommonJS 产物：
//   dist/fc/index.js        HTTP 函数（handler: index.fcHandler）
//   dist/fc/fc-timer.js     定时函数（handler: fc-timer.fcTimerHandler）
// tablestore SDK 保持 external，需要与 index.js 一起上传（node_modules）。
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 以脚本所在目录为基准解析路径，从仓库任何位置运行都可用。
const apiRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const require = createRequire(import.meta.url);
const esbuildBin = require.resolve("esbuild/bin/esbuild");

mkdirSync("dist/fc", { recursive: true });
rmSync("dist/fc", { recursive: true, force: true });
mkdirSync("dist/fc", { recursive: true });

execFileSync(
  process.execPath,
  [
    esbuildBin,
    join(apiRoot, "src/fc-http.js"),
    join(apiRoot, "src/fc-timer.js"),
    "--bundle",
    "--platform=node",
    "--target=node18",
    "--format=cjs",
    `--outdir=${join(apiRoot, "dist/fc")}`,
    "--external:tablestore",
    "--log-level=info"
  ],
  { stdio: "inherit" }
);

renameSync(join(apiRoot, "dist/fc/fc-http.js"), join(apiRoot, "dist/fc/index.js"));
// fc-timer.js 保持原名（handler 为 fc-timer.fcTimerHandler）。
// api/package.json 声明了 "type": "module"，会让 .js 产物被当作 ESM 加载，
// 导致 module.exports 失效。在产物目录放一个 CJS 声明保证 require 能拿到导出。
writeFileSync(
  join(apiRoot, "dist/fc/package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n"
);

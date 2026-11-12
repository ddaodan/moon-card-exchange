# 部署（阿里云函数计算 FC + Tablestore）

后端运行在阿里云函数计算 FC（内地地域），数据存储在 Tablestore（OTS），
两者都有免费额度，且平台默认域名 `*.fcapp.run` 不需要备案。

## 一键部署（推荐）

前置条件：

1. 已有阿里云账号，且开通了函数计算 FC 和 Tablestore（控制台点一次即可）。
2. 创建一个 RAM 子账号，仅授予 `AliyunOTSFullAccess` 和 `AliyunFCFullAccess`
   两个权限，为它生成 AccessKey。
3. 本机能访问阿里云 API（国内网络即可）。

然后执行两条命令：

```powershell
$env:ALIBABA_CLOUD_ACCESS_KEY_ID = "你的 AccessKeyId"
$env:ALIBABA_CLOUD_ACCESS_KEY_SECRET = "你的 AccessKeySecret"
npm run deploy
```

脚本会自动完成：开通 Tablestore 服务、创建实例和数据表、打包 FC 代码、
上传并创建 HTTP 函数与定时函数、创建 HTTP 触发器（匿名访问）和定时触发器
（北京时间每天 4 点清理）、最后跑健康检查（含一次读 Tablestore 的统计接口，
提前暴露连通性问题）。全程不需要打开控制台。

输出末尾会给出 API 地址（FC 2.0 格式，形如
`https://<账号ID>.<region>.fc.aliyuncs.com/2016-08-15/proxy/<服务名>/<函数名>/`），
以及前端构建需要的环境变量。

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FC_REGION` | `cn-hangzhou` | FC 和 OTS 的地域 |
| `FC_FUNCTION_PREFIX` | `moon-card-exchange` | 函数名前缀 |
| `OTS_INSTANCE` | `moon-card` | Tablestore 实例名 |
| `RATE_SALT` | 自动生成 | 不传则每次随机生成；重复部署请传同一个值，否则限频 key 会变 |
| `TOY_ORIGIN` | 无 | Toy 页面的实际 Origin，会追加到 `ALLOWED_ORIGINS` |

注意事项：

- Tablestore 实例的网络访问默认可能不允许公网调用。如果统计接口报网络错误，
  到 Tablestore 控制台把实例的网络类型改为「允许公网访问」（或按需配置 VPC）。
- 自动生成的 `RATE_SALT` 只在输出里出现一次，请复制保存。
- 再次部署时，函数和触发器会更新代码与配置，不会重复创建。

## 1. 准备

```powershell
npm install
npm test
```

Node 版本要求 24。仓库根目录提供 `package-lock.json`。

## 2. 开通服务

1. 开通[函数计算 FC](https://www.aliyun.com/product/fc)（按量付费，有免费额度）。
2. 开通[表格存储 Tablestore](https://www.aliyun.com/product/ots)（有免费额度）。
3. 创建 Tablestore 实例（推荐华东 1 或华南 1，与 FC 同地域），实例名称记为
   `OTS_INSTANCE`，实例的 endpoint 记为 `OTS_ENDPOINT`
   （形如 `https://xxx.cn-hangzhou.ots.aliyuncs.com`）。
4. 创建 RAM 用户（仅授予 `AliyunOTSFullAccess`），生成 AccessKey，记为
   `OTS_ACCESS_KEY_ID` / `OTS_ACCESS_KEY_SECRET`。

## 3. 建表

```powershell
cd api
$env:OTS_ENDPOINT = "https://xxx.cn-hangzhou.ots.aliyuncs.com"
$env:OTS_INSTANCE = "你的实例名"
$env:OTS_ACCESS_KEY_ID = "你的 AK"
$env:OTS_ACCESS_KEY_SECRET = "你的 SK"
npm run create-tables
```

脚本会创建 5 张表：`listings`（主键 `token_hash`）、`pairs`（主键 `id`）、
`reports`（主键 `key`）、`profiles`（主键 `uid`）、`rate_limits`（主键 `key`）。
已存在时跳过，可重复执行。

## 4. 打包 FC 函数

```powershell
npm run build:fc
```

产物在 `api/dist/fc/`：

| 文件 | 用途 | Handler |
| --- | --- | --- |
| `index.js` | HTTP 函数 | `index.fcHandler` |
| `fc-timer.js` | 定时函数 | `fc-timer.fcTimerHandler` |

`tablestore` SDK 保持 external。上传前把 `api/node_modules/tablestore`
（含其依赖）复制到 `api/dist/fc/node_modules/`，或在 FC 控制台安装依赖。

## 5. 创建 FC 函数

### 5.1 HTTP 函数

在 FC 控制台创建函数：

1. 运行环境：Node.js 18（或 20）。
2. 请求处理程序（Handler）：`index.fcHandler`。
3. 上传 `api/dist/fc/` 目录（或通过 OSS）。
4. 环境变量：

| 变量 | 说明 |
| --- | --- |
| `OTS_ENDPOINT` | Tablestore 实例 endpoint |
| `OTS_INSTANCE` | Tablestore 实例名 |
| `OTS_ACCESS_KEY_ID` | RAM 用户的 AK |
| `OTS_ACCESS_KEY_SECRET` | RAM 用户的 SK |
| `RATE_SALT` | 任意随机字符串，用于限频 key 的 HMAC 加盐 |
| `ALLOWED_ORIGINS` | 逗号分隔的允许来源，含 Toy 页面来源（见下） |
| `ENKA_UA` | 请求 Enka 用的 UA，例如 `moon-card-exchange/1.0` |

`ALLOWED_ORIGINS` 先填：

```
https://www.bilibili.com,http://localhost:5173,http://127.0.0.1:5173
```

上线前把 Toy 预览和发布环境的实际 Origin 加进去。

5. 触发器：创建 HTTP 触发器，认证方式选「不需要认证」，请求路由 `/*`。
6. 部署后得到默认域名 `https://<函数名>.<region>.fcapp.run`，先浏览器访问
   `/v1/health`，应返回 `{"ok":true}`。

### 5.2 定时函数

再创建一个函数（可与 HTTP 函数同应用）：

1. Handler：`fc-timer.fcTimerHandler`，上传同一目录。
2. 环境变量与 HTTP 函数相同。
3. 触发器：定时触发器，Cron `0 0 20 * * *`（FC 按 UTC 解析，即北京时间每天 4 点），
   负载可选 `{}`。

定时任务删除过期超过 30 天的登记及其 pairs、举报，并清理 7 天前的资料缓存
和过期限频记录。

## 6. 前端构建

```powershell
$env:VITE_API_BASE = "https://<函数名>.<region>.fcapp.run"
npm run build
npm run check:toy
```

`VITE_API_BASE` 必须是 HTTPS 地址，且不能包含占位符 `<`。产物位于 `web/dist`，
根目录只有 `index.html`，资源全部使用相对路径，总体积需小于 50MB。

本地演示使用 mock 数据：

```powershell
npm run dev:web:mock
```

运行端到端测试前，先构建 mock 产物（`npm run build` 的生产构建会覆盖它）：

```powershell
npm run build:mock --workspace web
npm run test:e2e
```

本地联调：

```powershell
npm run dev:api
$env:VITE_API_BASE = "http://localhost:8787"
npm run dev:web
```

## 7. Toy 预览与提交

1. 把 `web/dist` 上传到 Toy，slug 确认为 `ys-moon-card-swap`（发布后不可修改）。
2. 先以「链接可见」方式预览，跑通登记、匹配、交换、删除。
3. **部署后第一件事**：在 Toy 页面实测跨域调用（含 OPTIONS 预检）。
   FC 默认域名有防滥用机制，如果预检被拦，需要回到备案 + 自定义域名路线。
4. 在 Toy 环境确认实际请求 Origin，并加入 `ALLOWED_ORIGINS`。
5. 准备 1200×900 的 4:3 封面和独立图标。
6. 提交前用 Toy 管理页的预览功能自测一遍；`npm run check:toy` 已覆盖包体积与资源路径检查。

## 8. 成本控制

1. FC 和 Tablestore 都有免费额度，本项目流量很小，正常使用应为 0 元。
2. 在费用中心设置预算告警（例如 ¥5/月），防止意外。
3. Tablestore 建表脚本把预留读写 CU 设为 0，按实际用量计费，正常流量在免费额度内。

# 接口约定

所有接口都挂在 `VITE_API_BASE` 指定的 HTTPS 域名下（生产为 FC 默认域名
`*.fcapp.run`），返回 JSON。错误统一为：

```json
{ "error": { "code": "INVALID_INPUT", "message": "中文提示" } }
```

错误码：`INVALID_INPUT`、`UID_INVALID`、`UID_NOT_FOUND`、`UID_TAKEN`、`UNAUTHORIZED`、
`NOT_FOUND`、`RATE_LIMITED`、`LISTING_EXPIRED`、`INTERNAL`。

## 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 健康检查，返回 `{ok:true}` |
| GET | `/v1/stats` | `{activeListings, byGroup, completedPairs}`，服务端内存缓存 10 分钟 |
| GET | `/v1/profile/:uid` | `{uid, serverGroup, serverLabel, nickname, level, source}`；同一 IP 每分钟 30 次 |
| POST | `/v1/listings` | 创建登记，返回 `{listing, token}`；同一 IP 每天 5 次 |

客户端 IP 取自 FC 的 `context.clientIP`（由入口写入 `cf-connecting-ip` 头）。

### 创建登记

请求体只允许以下字段，多余字段返回 `INVALID_INPUT`：

```json
{
  "uid": "160000001",
  "counts": [2, 1, 0, "…共 22 个 0–99 的整数"],
  "want": ["empress"],
  "timeSlots": ["weekday_evening", "weekend_evening"],
  "consent": true
}
```

- `counts` 按 22 张牌的目录顺序排列（与 BWIKI「月谕圣牌」页面一致：魔法师第 1 张 … 愚者第 22 张，对应下标 0–21），`keep = 1`，`spare = count - 1`。
- `want` 只能包含当前数量为 0 的牌。
- `timeSlots` 可选：`weekday_day`、`weekday_evening`、`weekday_late`、`weekend_day`、`weekend_evening`、`weekend_late`、`anytime`；`anytime` 与其他选项互斥。
- `consent` 必须为 `true`。
- UID 与服务器：9 位按首位判断（1/2/3 天空岛、5 世界树、6 美服、7 欧服、8 亚服、9 港澳台，4 开头无效）；
  10 位目前只有 `18` 开头的亚服号段有效（其余 1X、20 开头经 Enka 实测均为无效号段）。
  Enka 返回 region 时优先用 region 推导具体服务器名。
- `serverGroup` 取值：`sky`（天空岛）、`tree`（世界树）、`usa`、`euro`、`asia`、`cht`。
  天空岛与世界树是两个独立分组：官服与 B 服数据不互通，只在同一服务器组内匹配。

## 需要恢复码的接口

请求头：`Authorization: Bearer <32 位 Crockford Base32 恢复码>`。
同一令牌每小时最多 60 次写操作。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/listings/me` | 返回 `{listing}` |
| PUT | `/v1/listings/me` | 更新牌匣，UID 不可改；有效期延长 30 天 |
| DELETE | `/v1/listings/me` | 删除登记及关联 pairs、举报记录 |
| GET | `/v1/matches` | 返回 `{active: Match[], records: Match[]}` |
| POST | `/v1/pairs/:id/state` | 请求体 `{state:"active"|"exchanging"|"completed"|"hidden"}`；`exchanging` 为申请交换，作用于双方 |
| POST | `/v1/reports` | 请求体 `{pairId, reason}`，`reason` 为 `uid_invalid`、`inventory_fake`、`harassment` |

### Match

```json
{
  "pairId": "24 位十六进制",
  "partner": {
    "uid": "160000002",
    "nickname": "旅行者",
    "level": 60,
    "serverGroup": "sky",
    "serverLabel": "天空岛",
    "timeSlots": ["weekday_evening"],
    "updatedAt": 1760000000000
  },
  "give": ["fool"],
  "get": ["magician"],
  "tradeCount": 1,
  "timeOverlap": true,
  "myState": "active",
  "partnerState": "active",
  "partnerBusy": false,
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000,
  "snapshot": null
}
```

`pairId` 是内部组合键（双方令牌哈希的字典序组合）加盐哈希后的 24 位十六进制，
不直接暴露令牌哈希。双方对同一条 pair 看到相同的 `pairId`。

匹配采用申请制：

- 未申请时 `partner.uid` 返回 `null`，前端显示"申请交换后可见"。
- 任一方对 pair 提交 `state:"exchanging"` 后，双方都进入"正在交换"，互相可见 UID。
- `completed` 必须在 `exchanging` 之后提交（409 拒绝跳过申请直接完成）。
- 双方都在交换中时，`active`（取消）或 `hidden` 会把双方一起放回匹配池。
- `partnerBusy` 表示对方正在其他匹配中交换；前端据此提醒"可能会换不到"，但申请不会被拦截。

匹配只比较同一服务器组（天空岛与世界树互不匹配），且要求 `give = 我的 spare & 对方 want` 与
`get = 对方 spare & 我的 want` 同时非空。

## 数据存储

数据存放在 Tablestore（阿里云 OTS），共 5 张表：

| 表 | 主键 | 说明 |
| --- | --- | --- |
| `listings` | `token_hash` | 登记主表；`uid` 为属性列（查重用全表扫描，玩具规模可接受） |
| `pairs` | `id` | 内部组合键 `${lowId}|${highId}`（双方令牌哈希的字典序） |
| `reports` | `key` | `${reporterId}|${targetId}`，同一举报人对同一目标只计一次 |
| `profiles` | `uid` | Enka 查询缓存 |
| `rate_limits` | `key` | 固定窗口限频计数 |

登记以令牌 SHA-256 为主键，明文令牌只在创建响应中出现一次。

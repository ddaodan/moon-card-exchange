# 月谕圣牌交换站（Moonlit Oracle Exchange）

[![测试](https://github.com/ddaodan/moon-card-exchange/actions/workflows/ci.yml/badge.svg)](https://github.com/ddaodan/moon-card-exchange/actions/workflows/ci.yml)

B 站 Toy 页面：原神「月谕圣牌」交换信息共享站。旅行者登记 UID、牌匣、想要的牌和可联系时间，系统在同一服务器组内自动匹配互相补缺的玩家，双方互相看到信息后自行在游戏内加好友交换。

> 非官方玩家工具，与米哈游/HoYoverse 无关。「月谕圣牌」牌面图片来源于[原神 BWIKI](https://wiki.biligame.com/ys/%E6%9C%88%E8%B0%95%E5%9C%A3%E7%89%8C)，版权归米哈游所有。

## 结构

- `shared/` 前后端共用的规则与数据（牌目录、掩码匹配、文字识别）。
- `web/` Toy 前端（Vite + 原生 JS，深色月夜展廊视觉）。
- `api/` 阿里云函数计算 FC + Hono + Tablestore。
- `docs/` 接口约定与部署说明。

## 功能

- 22 张月谕圣牌的牌匣录入（按钮加减、粘贴文字识别、复制牌单）。
- 登记后自动在同服务器组（天空岛/世界树/亚/美/欧/港澳台）内查找双方互缺的旅行者。
- 申请交换 → 双方可见 UID → 游戏内加好友 → 标记已交换（牌匣自动增减）。
- 交换名片（可隐藏 UID）生成 PNG 保存/下载，附 Toy 页面二维码。
- 无注册登录：恢复码即凭证，支持 B 站 Toy 云端同步自动找回。
- 举报与 3 人暂停、限频、定时清理过期登记。

## 常用命令

```
npm install
npm run test          # shared + api 单元测试
npm run dev:web       # 本地前端（默认 mock API）
npm run dev:api       # 本地 Node 服务器（内存存储）
npm run build         # 构建前端到 web/dist
npm run check:toy     # Toy 包预检
```

## 开发

```powershell
npm install
npm run dev:web:mock   # 前端 + 内置演示数据（无需后端）
npm run dev:api        # 本地 API（内存存储，联调真实接口）
```

联调真实 API 时新建 `web/.env.development.local`（不入库）：

```
VITE_API_BASE=https://你的-api-地址/
```

生产构建需要设置 `VITE_API_BASE`（必须是 HTTPS 地址）。部署见 [docs/deploy.md](docs/deploy.md)。

## 接口

接口约定见 [docs/api.md](docs/api.md)。错误码、限频规则、匹配算法（掩码 + 双方互缺）都在 `shared/` 中有单元测试覆盖。

## 许可

代码以 [MIT](LICENSE) 发布。牌面图片版权归原作者（米哈游）所有，本项目使用仅出于玩家信息共享目的，不作商业用途，如有侵权请联系删除。

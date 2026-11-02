# my-pi 详细设计文档

> 文档基线：2026-11-01。本文整理仓库当前实现：目录与文件职责、运行时请求流转、业务数据流，以及从构建到部署的对应关系。  
> 系统上下文、Pi session 生命周期、生产化差距的展开说明见 [技术架构与部署设计](./architecture-and-deployment.md)。

---

## 1. 文档目的与范围

本文回答三件事：

1. 仓库里每个核心目录/文件做什么，彼此如何依赖。
2. 一次请求如何从进程入口走到页面显示（以及表单如何写回）。
3. 从构建、检查到部署，哪些文件进入产物、哪些只服务开发/CI、Shopify 配置与 Node 服务如何分开发布。

不在本文展开：未来队列、多地点归因、供应商/MOQ、采购订单、店铺级 Agent Memory。这些在架构文档中列为未实现。

---

## 2. 产品与系统边界

my-pi 是嵌在 Shopify Admin 中的应用。一个 Node.js Web 服务可被多家店铺安装；`shop` 是业务数据租户边界。

| 能力 | 当前状态 | 写 Shopify？ |
| --- | --- | --- |
| StockPilot 库存诊断与补货建议 | 主功能，商家手动选地点并全量同步 | 否。只读库存/订单/地点；决策只存在本应用库 |
| AI 商品文案生成与确认写回 | 代码保留；`PRODUCT_COPY_ENABLED = false` 时入口隐藏、直接访问重定向 | 仅在商家确认后 `productUpdate` 标题和描述 |

约束：

- Shopify 用户 session 用于认证和 Admin API，不是 Pi Agent 会话。
- 文案每次任务创建一次性、无工具的 Pi session，任务结束即释放。
- 库存销量、风险、采购数量由确定性 TypeScript 计算，AI 不参与。
- 模型 Provider / API Key 目前全店共用服务端环境变量，无商家 BYOK。

---

## 3. 技术栈

| 层 | 当前技术 |
| --- | --- |
| 运行时 | Node.js `>=22.19.0`、TypeScript、npm |
| Web | React 18、React Router 7（loader/action + SSR）、Vite 7 |
| Shopify | `@shopify/shopify-app-react-router`、App Bridge、Admin GraphQL `2026-10` |
| UI | Shopify Web Components（`s-*`）+ `app/styles/app-shell.css` |
| 数据 | Prisma 6 + PostgreSQL（`env("DATABASE_URL")`，本地开发指向 Supabase） |
| 后台调度 | 独立 Node worker（`worker/index.ts`）+ node-cron，esbuild 打包到 `build-worker/` |
| 文案模型 | `@earendil-works/pi-coding-agent` 1.4.0、Zod 4 |
| 本地开发 | Shopify CLI；临时 HTTPS 隧道 |
| 测试 | Node.js `node:test`（`tests/*.test.ts`） |

系统上下文：

```text
商家 → Shopify Admin（嵌入 iframe）
         → mypi React Router 服务
              → Shopify Admin GraphQL API
              → Prisma / PostgreSQL
              → Pi SDK → 模型 Provider（仅文案路径）
         ← Shopify 签名 Webhook（orders/*、inventory_levels/update 增量重算）
后台 worker 进程 → PostgreSQL + Shopify Admin GraphQL（offline token，cron 定时快照与销量重建）
```

---

## 4. 仓库目录总图

```text
myPi/
├── app/                      # 运行时业务：会打进 build/
│   ├── lib/                  # 纯计算与规则模块（无 I/O，可单测）
│   └── routes/               # 一个文件一条 URL
├── prisma/                   # 数据模型与迁移；setup 时执行
├── tests/                    # 单元测试；不进生产包
├── docs/                     # 设计文档
├── package.json              # 脚本与依赖
├── package-lock.json         # npm 锁文件
├── vite.config.ts            # 开发服务器与生产打包
├── tsconfig.json             # 类型检查（noEmit）
├── env.d.ts                  # Vite / React Router 类型
├── shopify.app.toml          # Shopify 应用配置（deploy 对象）
├── shopify.web.toml          # 本地 web 进程命令
├── Dockerfile                # Node 服务镜像草稿
├── .env.example              # 模型环境变量模板
├── .github/                  # CI 与模板仓库协作文件
├── .claude/ .cursor/ .gemini/ .mcp.json  # IDE / Agent，不进运行时
└── README.md / LICENSE.md
```

工作区声明了 `extensions/*`，当前仓库几乎无扩展代码。`extensions/*/dist` 已 gitignore。

> **命名硬约束**：`app/` 根目录下的模块名会占用 `/app/<name>` 这条 URL。Vite 开发服务器先按文件路径回源码（`content-type: text/javascript`），SSR 路由拿不到请求——`app/data-health.ts` 曾把 `/app/data-health` 页面整页吞成 JS。因此**纯逻辑模块一律放 `app/lib/`**，只有 `.server.ts` 与路由文件留在 `app/` 根。

---

## 5. 构建与运行控制面

这些文件不渲染页面，但决定如何安装、编译、启动、以及绑定哪一个 Shopify 应用。

### 5.1 包与脚本

`package.json` 是所有 npm 命令入口。关键脚本：

| 脚本 | 实际行为 | 何时用 |
| --- | --- | --- |
| `dev` | `shopify app dev` | 本地：隧道 + 按 `shopify.web.toml` 起服务 |
| `build` | `react-router build` → `build/` | 生产构建、CI |
| `start` | `react-router-serve ./build/server/index.js` | 运行已构建服务 |
| `setup` | `prisma generate && prisma migrate deploy` | 生成 Client、执行迁移 |
| `docker-start` | `setup` 然后 `start` | Dockerfile `CMD` |
| `deploy` | `shopify app deploy` | 只发布应用配置，不托管 Node |
| `typecheck` | `react-router typegen` + `tsc --noEmit` | 检查 |
| `test` / `lint` | 单元测试 / ESLint | 检查 |
| `graphql-codegen` | 按 `.graphqlrc.ts` 生成 Admin API 类型 | 按需 |

`.npmrc` 设置 `engine-strict=true`，与 `engines.node` 一起卡住不兼容的 Node。`package-lock.json` 供 `npm ci` 复现依赖。

### 5.2 打包与类型

| 文件 | 职责 | 产物关系 |
| --- | --- | --- |
| `vite.config.ts` | React Router 插件、端口、HMR、隧道 host、`fs.allow: app` | `dev` / `build` |
| `tsconfig.json` | `strict`、`noEmit`、bundler resolution | 只做检查，JS 由 Vite 发出 |
| `env.d.ts` | 引用 `vite/client`、`@react-router/node` | 仅类型 |
| `.graphqlrc.ts` | Admin GraphQL codegen，扫描 `app/**`，输出 `./app/types` | 按需生成 |

`build/`、`build-worker/`、`.react-router/`、`.shopify/`、`.env` 均 gitignore，不是源码。

### 5.3 Shopify 配置 vs Web 进程

| 文件 | 发布对象 | 内容 |
| --- | --- | --- |
| `shopify.app.toml` | Shopify Dev Dashboard（`shopify app deploy`） | `client_id`、嵌入式、`application_url`、scopes、webhook、redirect |
| `shopify.web.toml` | 仅本地 `npm run dev` | `predev`: `prisma generate`；`dev`: migrate + `react-router dev` |

当前 scopes：`read_products,write_products,read_inventory,read_orders,read_locations`。未申请受限的 `read_all_orders`，销量最多约 60 天。

Webhook 订阅与路由必须一致：

| toml URI | 路由文件 |
| --- | --- |
| `/webhooks/app/uninstalled` | `app/routes/webhooks.app.uninstalled.tsx` |
| `/webhooks/app/scopes_update` | `app/routes/webhooks.app.scopes_update.tsx` |
| `/webhooks/customers/data_request` | `app/routes/webhooks.customers.data_request.tsx` |
| `/webhooks/customers/redact` | `app/routes/webhooks.customers.redact.tsx` |
| `/webhooks/shop/redact` | `app/routes/webhooks.shop.redact.tsx` |

生产更换公网域名后必须重新 deploy 配置，否则 Shopify 仍回调旧 URL。

### 5.4 环境变量

`.env.example` 只列出模型侧模板。Shopify 相关变量由 CLI / 托管平台注入。

| 变量 | 读取位置 | 用途 |
| --- | --- | --- |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` / `SCOPES` | `shopify.server.ts` | 应用身份与鉴权 |
| `PI_API_KEY` / `PI_PROVIDER` / `PI_MODEL` | `product-copy.server.ts` → `pi.server.ts` | 仅服务端模型调用；不回传浏览器、不入库 |

密钥变更只需重启进程，不必 rebuild。`features.ts` 是编译期常量，改开关必须重新 `build`。

### 5.5 容器草稿

`Dockerfile`：`node:22-alpine`，安装 openssl，`npm ci --omit=dev`，`COPY` 源码后 `npm run build`，暴露 3000，`CMD npm run docker-start`。`.dockerignore` 排除 `.cache`、`build`、`node_modules`。

这是把 Node 服务打成镜像的草稿：仓库没有编排、secret 注入流水线，镜像也只跑 Web 服务——后台 worker 需要单独的进程/容器与健康检查。数据库已外置为 PostgreSQL（多副本共享），容器重建不再丢数据。

---

## 6. 运行时：`app/` 文件职责与依赖

`app/` 是唯一打进 `build/` 的业务代码。约定：`*.server.ts` 只进服务端 bundle，避免密钥进入浏览器包。

### 6.1 框架与 Shopify 接入

```text
HTTP
  → entry.server.tsx          SSR；调用 shopify.server 加嵌入响应头
  → root.tsx                  <html lang="zh-CN"> 外壳、字体、<Outlet />
  → routes.ts                 flatRoutes()，文件名即 URL
  → routes/*                  loader → 组件；POST 走 action
```

| 文件 | 职责 |
| --- | --- |
| `entry.server.tsx` | `handleRequest`：`addDocumentResponseHeaders` + `renderToPipeableStream(ServerRouter)`。不选路由、不做业务。爬虫 `onAllReady`，用户 `onShellReady`。 |
| `root.tsx` | 文档壳。无 loader，不碰 Shopify。 |
| `routes.ts` | `@react-router/fs-routes` 的 `flatRoutes()`。 |
| `globals.d.ts` | `declare module "*.css"`。 |
| `styles/app-shell.css` | 侧栏/顶栏/工作台布局，由 `routes/app.tsx` 引入。 |
| `shopify.server.ts` | `shopifyApp()`：API `2026-10`、**offline token**（`useOnlineTokens: false`）、Prisma session storage、导出 `authenticate` / `login` / `addDocumentResponseHeaders`。进程内单例。 |
| `db.server.ts` | PrismaClient 单例；开发态挂 `global` 避免热更新重复连接。 |
| `features.ts` | `PRODUCT_COPY_ENABLED`。只控制 `copy` / `history` 两个路由的访问；侧栏 `NAV_ITEMS` 是写死列表，不读该开关，`settings` 已独立不再受控。 |

`shopify.server.ts` 依赖 `db.server.ts`。几乎所有 `/app/*` 与 webhook 路由依赖 `authenticate`。

### 6.2 路由文件与 URL

嵌套关系：

```text
root.tsx
  ├── routes/_index/route.tsx          GET /
  ├── routes/auth.login/route.tsx      /auth/login
  ├── routes/auth.$.tsx                /auth/*
  ├── routes/webhooks.*.tsx            /webhooks/*
  └── routes/app.tsx                   /app 布局（鉴权 + AppProvider + 侧栏）
        ├── app._index.tsx             /app
        ├── app.inventory.tsx          /app/inventory
        ├── app.data-health.tsx        /app/data-health
        ├── app.copy.tsx               /app/copy
        ├── app.history.tsx            /app/history
        └── app.settings.tsx           /app/settings
```

商家主入口是 Shopify Admin 打开的 `/app`，不是 `/`。

| 文件 | 路径 | 职责 |
| --- | --- | --- |
| `routes/_index/route.tsx` | `/` | 有 `?shop=` 则重定向 `/app`；否则显示填店名登录表单（开发用）。 |
| `routes/_index/styles.module.css` | — | 仅落地页样式。 |
| `routes/auth.$.tsx` | `/auth/*` | OAuth 回调：`authenticate.admin`。redirect URL 必须能打到此路径。 |
| `routes/auth.login/route.tsx` | `/auth/login` | 调用 `login()`；表单提交店名。 |
| `routes/auth.login/error.server.tsx` | — | 把登录错误映射为字段文案。 |
| `routes/app.tsx` | `/app` 布局 | `authenticate.admin`；向客户端只返回 `apiKey` 与 `session.shop`（无 token）。`AppProvider`、导航、`<Outlet />`。文案三页是否进导航看功能开关。 |
| `routes/app._index.tsx` | `/app` | 库存工作台首页：指标卡、优先建议、Data Health 摘要与最近决策都取自 `getInventoryDashboard` / `getRecentRecommendationAudit`；尚未实现的能力只写「Not enabled yet」，不放占位数字。 |
| `routes/app.inventory.tsx` | `/app/inventory` | 六态 Action Board、地点选择、同步、置信度与公式解释、补货决策、决策审计、CSV 导出。loader/action 委托 `inventory.server.ts`。 |
| `routes/app.data-health.tsx` | `/app/data-health` | 数据健康检查清单、暂停原因与恢复动作、同步任务台账（`recentJobs`）。 |
| `routes/app.copy.tsx` | `/app/copy` | 商品列表、生成草稿、确认写回。开关关闭则 `redirect("/app/inventory")`。 |
| `routes/app.history.tsx` | `/app/history` | 本店最近 100 条 `ProductDraft`。 |
| `routes/app.settings.tsx` | `/app/settings` | 模型配置状态；仅 `account_owner` 可测连接。 |
| `routes/webhooks.app.uninstalled.tsx` | 卸载 | 删除该 `shop` 的 session 与全部业务表。 |
| `routes/webhooks.app.scopes_update.tsx` | 权限变更 | 更新 session scope。 |
| `routes/webhooks.customers.*` | 客户合规 | 本应用不存客户数据，校验后记日志。 |
| `routes/webhooks.shop.redact.tsx` | 商店删除 | 与卸载共用 `webhook-sync.server.ts` 的 `purgeShopBusinessData(shop)`：按 `shop` 删净包括 `RecommendationAudit` 在内的全部业务表，并把每张表行数写进日志。**新增业务模型必须同步加进那张清单**，否则合规删除会漏数据。 |

路由统一使用 `boundary.headers` / `ErrorBoundary`，以便 Shopify 库抛出的 Response 头能回到客户端（嵌入/鉴权跳转需要）。

### 6.3 业务模块

**StockPilot**

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `inventory.server.ts` | GraphQL：地点、店铺时区/币种、变体库存、订单。手动全量同步；内存拼完整结果后 Prisma 事务替换快照与日销量。组装 dashboard（含置信度、Action Board 归类、Data Health）、同步后登记 pending 与审计、`buildReorderExport` 出 CSV。 | `db.server`、`lib/*` |
| `lib/inventory-calculations.ts` | Observed Demand（按可见样本天数折算日均）、补货点/目标库存/建议量、覆盖天数、8 种健康状态与公式文案。无 I/O、无 AI。 | 无 |
| `lib/reorder-confidence.ts` | Reorder Confidence 三档（high/medium/low）与逐条降信原因：hard 直接 low、soft 累计 1 条 medium / 2 条 low、info 只披露不降档。 | `lib/inventory-calculations` |
| `lib/data-health.ts` | 6 项检查清单 + `paused` 判定（只有 `blocksRecommendations` 的 critical 才暂停）。纯派生，不落库。 | 无 |
| `lib/reorder-action-board.ts` | 六态归类（ordered 永远保留、建议消失时 accepted/edited 留、其余出榜、needsReview 打回 pending）、计数与采纳率口径。 | `lib/reorder-recommendations` |
| `lib/reorder-export.ts` | 27 列 CSV 序列化：CRLF、引号/逗号/换行转义、`= + - @` 前缀加护栏、空值出空串。 | 无 |
| `lib/reorder-recommendations.ts` | 决策状态 `pending / accepted / edited / ignored / ordered`、intent 校验、审计动作映射、操作者常量、正整数数量解析。 | 无 |
| `sync-jobs.server.ts` | `withSyncJob` 台账包装、`hasRunningJob` 并发去重、`consecutiveFailures`、`lastSucceededAt`、`recentJobs`。 | `db.server` |
| `webhook-sync.server.ts` | `inventory_levels/update` 与 `orders/*` 的增量重算入口（payload 只当失效信号，数值回 Admin 重读）；也是 `app/uninstalled` 与 `shop/redact` 共用的 `purgeShopBusinessData()` 所在地。 | `inventory.server`、`sync-jobs.server`、`db.server` |

同步口径要点：库存按所选地点；销量按全店已支付订单、`processedAt`、不扣减退货；无 `read_all_orders` 时不把 60 天销量当成 90 天，并用「可见样本天数」而不是窗口天数做分母。补货决策按 `(shop, locationId, variantId)` 持久化，每次变更在同一个事务里追加一行 `RecommendationAudit`；不创建 Shopify 采购单。

所有交互式写入走 `withTransaction()`（`timeout: 30_000, maxWait: 10_000`）：数据库是远程 Postgres，每条语句一次往返，用 Prisma 默认 5s 预算会在整批快照/销量写入时撞出 `P2028: Transaction already closed`。

**商品文案**

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `product-copy.server.ts` | 读 `PI_*`、Zod schema（标题 1–255、描述 1–20000）、错误归一化、90s 超时包装。 | Zod、环境变量 |
| `pi.server.ts` | `generateProductCopy` / `testModelConnection`：临时目录 + 无工具 AgentSession + `prompt` + `dispose`。 | `product-copy.server`、Pi SDK |

生成与写回分离：模型只产建议；`app.copy.tsx` 在商家确认后才 `productUpdate`，写回前比对原标题/描述，冲突则 `conflicted`。

### 6.4 模块依赖图

```text
entry.server.tsx ──► shopify.server.ts ──► db.server.ts ──► Prisma
                         ▲
routes/app.tsx ──────────┤
routes/app._index.tsx ───┤
routes/auth.*.tsx ───────┤
routes/webhooks.*.tsx ───┤──► db.server.ts
routes/app.inventory.tsx ┤──► inventory.server.ts ──► Shopify Admin
routes/app.data-health.tsx┤         ├── sync-jobs.server.ts
                          │         ├── lib/inventory-calculations.ts
                          │         ├── lib/reorder-confidence.ts
                          │         ├── lib/data-health.ts
                          │         ├── lib/reorder-action-board.ts
                          │         ├── lib/reorder-export.ts
                          │         └── lib/reorder-recommendations.ts
routes/app.copy.tsx ─────┤──► pi.server.ts ──► product-copy.server.ts
                         └──► db.server.ts（ProductDraft）
routes/app.history.tsx ──► db.server.ts
routes/app.settings.tsx ─► product-copy.server.ts / pi.server.ts
features.ts ◄── app.tsx（导航）、copy/history/settings（访问控制）
```

---

## 7. 请求流转：入口到页面显示

### 7.1 进程启动（开发）

```text
npm run dev
  → Shopify CLI 读 shopify.app.toml + shopify.web.toml
  → prisma generate
  → prisma migrate deploy
  → react-router dev（Vite）
  → 临时 HTTPS 隧道
  → Admin 预览链接（iframe 打开 /app）
```

生产等价：`npm run build` → `npm run setup` → `npm run start`（或 Docker `docker-start`）。`start` 后每个 HTML 请求进入 `entry.server.tsx`。

### 7.2 打开库存页（GET `/app/inventory`）

```text
Shopify Admin iframe
  GET /app/inventory
    React Router 匹配 nested routes
      1. root.tsx                 无 loader
      2. app.tsx loader           authenticate.admin → { apiKey, shop }
      3. app.inventory.tsx loader authenticate.admin
           → fetchInventoryLocations(admin)
           → getInventoryDashboard(shop, locations, canReadAllOrders)
                Prisma 读 settings / snapshot / sales / recommendations
                lib/* 算出健康度、置信度、Action Board 归类与 Data Health
           → getRecentRecommendationAudit(shop) 拿最近决策流水
    entry.server.tsx
      加 Shopify 嵌入响应头
      renderToPipeableStream(ServerRouter)
    浏览器 HTML + hydrate

组件树：
  root → app.tsx（侧栏、顶栏店铺名、AppProvider）
           → app.inventory.tsx（useLoaderData 渲染看板）
```

`app.tsx` 已鉴权；子路由再鉴权一次，是为拿到 `admin` GraphQL 客户端和 `session.shop`。未登录时官方库转到 `/auth/...`。

### 7.3 `/` 与 OAuth（非嵌入主路径）

```text
浏览器打开 /
  有 ?shop=  → redirect /app?...
  无         → 落地页表单 POST /auth/login
                login() → Shopify OAuth
                /auth/* 回调 authenticate.admin
                进入 /app
```

`/` 给开发者手动填店名；商家日常不走这条路。

### 7.4 库存页交互（同一路由的 action）

页面用表单 / `useFetcher` POST 回 `app.inventory.tsx` 的 `action`，不经过 `entry.server` 的「选页」逻辑，也不调用 Pi。

| `intent` | 服务函数 | 效果 |
| --- | --- | --- |
| `select-location` | `saveInventoryLocation` | 记下本店地点 |
| `sync` | `syncInventoryAndSales` | 分页拉 Shopify；成功后事务替换快照与销量，并把正数建议登记为 pending + `created` 审计 |
| `accept-recommendation` 等 | `saveReorderRecommendation` | 只改应用内决策，同时追加一行审计（操作者记 `merchant`） |
| `export-csv` | `buildReorderExport` | 返 `{ fileName, csv, rowCount }` JSON；前端用 Blob 下载，不做整页导航（嵌入式 iframe 里会丢会话） |

action 结束后 Router 重新跑 loader，界面用新数据绘制。同步失败不提交半份新快照。

决策类 intent 在 action 里**重算一次 dashboard**：`dataHealth.paused` 为 true 直接返回错误，不接受任何接受/调整/忽略/已采购。UI 把按钮置灰只是体验，服务端重算才是约束。

### 7.5 文案路径（开关打开时）

```text
GET /app/copy
  开关关闭 → redirect /app/inventory
  开关打开 → GraphQL 前 50 个商品 + 可选 draftId
POST intent=generate
  重读商品 → 幂等 ProductDraft(generating)
  → pi.server 临时 session → Zod 校验 → pending
POST intent=apply
  CAS pending→applying → 比对原内容
  变化则 conflicted；否则 productUpdate → applied
```

模型配置测试只允许在线 session 的店铺所有者，不创建草稿。

### 7.6 `entry.server.tsx` 在链路中的位置

它是 **SSR 渲染入口**，不是产品入口。产品入口是 Admin 打开 `/app`。没有 `handleRequest`，loader 数据无法变成 HTML；没有各路由 loader，它也没有可渲染的业务树。

---

## 8. 数据模型与租户隔离

源：`prisma/schema.prisma`。数据源：`postgresql`，URL 取自 `DATABASE_URL`（SSR 进程靠 `app/db.server.ts` 顶部的 `import "dotenv/config"` 读到 `.env`）。迁移：`prisma/migrations/`（切库时的 6 份 SQLite 迁移已作废，现为 `init_postgres_baseline` + `add_data_foundation` 两条基线）。

| 模型 | 用途 | 隔离 |
| --- | --- | --- |
| `Session` | OAuth token 与用户身份 | Shopify session id；含 `shop` |
| `ProductDraft` | 原文、建议、状态 | 查询按 `shop`；`@@unique([shop, requestId])` |
| `InventorySettings` | 地点、交期/安全库存/检查周期、时区、同步状态 | `shop` 主键 |
| `Location` | 店铺启用中的库存地点目录 | `@@unique([shop, shopifyLocationId])` |
| `InventorySnapshot` | 地点×变体×日的可售/在途/在手时间序列 | `@@unique([shop, locationId, variantId, snapshotDate])`；`id` 为确定性复合 id |
| `InventoryEvent` | 只追加的可售变化事件流 | 按 `shop`；`occurredAt` 索引，`source + externalId` 供对账 |
| `DataSyncJob` | 同步任务台账（queued/running/succeeded/failed） | 按 `shop + jobType`；`hasRunningJob` 去重 |
| `SalesDaily` | 每日已支付销量 | `@@unique([shop, variantId, date])`；与地点无关 |
| `ReorderRecommendation` | 建议量快照与商家决策（pending 由同步登记） | `@@unique([shop, locationId, variantId])` |
| `RecommendationAudit` | 只追加的决策流水：动作、前后态、建议量/确认量、置信度、操作者 | 按 `shop`；`(shop, locationId, variantId, createdAt)` 索引 |

草稿状态：`generating → pending → applying → applied`，并可能 `failed` / `conflicted`。快照改为按日 upsert 的时间序列，切换库存地点不再清空历史。卸载与 `shop/redact` 按 `shop` 删除上述业务行。

默认计算参数（可存在 settings，初始为系统估算）：交期 14 天、安全库存 7 天、检查周期 14 天。

```text
可见样本天数   = min(窗口天数, 从 salesWindowStart 到今天的天数)
Observed Demand = 窗口内销量 / 可见样本天数        日均（不用窗口天数做分母）
覆盖天数     = 可售 / 日均（零销量不计算）
补货点       = 日均 × (交期 + 安全天数)
目标库存     = 日均 × (交期 + 检查周期 + 安全天数)
建议补货量   = max(0, ceil(目标库存 - 可售 - 在途))
```

---

## 9. 从构建到部署：文件进哪一条链路

仓库存在 **两条必须分别完成的发布**：

```text
A. Shopify 应用配置
   源：shopify.app.toml
   命令：shopify app deploy
   结果：scopes、application_url、webhook、OAuth redirect

B. Node Web 服务
   源：app/ + prisma/ + package.json + vite.config.ts
   命令：build → setup → start（或 Dockerfile）
   结果：HTTPS 上提供 /app、/auth、/webhooks
         出站 Admin API 与（可选）模型 Provider
         持久化数据库
```

`shopify app deploy` 不会把 `build/` 推到云上。本地 `dev` 把 A 的 URL 临时指到隧道，B 跑在本机。

### 9.1 变更后要做什么

| 改动 | 需要 |
| --- | --- |
| `app/**`、`vite.config.ts`、依赖 | `npm run build`，重启 Node |
| `prisma/schema.prisma` 或 `migrations/` | `setup`（generate + migrate deploy），重启 |
| `shopify.app.toml` | `shopify app deploy`；scopes 变更后店铺重新授权 |
| `.env` / 平台 Secret | 重启进程 |
| `features.ts` | rebuild |
| 仅 `tests/`、`docs/`、`.github` 模板 | 不部署运行时 |

### 9.2 不进生产包的目录

| 路径 | 角色 |
| --- | --- |
| `tests/` | 计算、文案校验、密钥不泄漏 |
| `.eslintrc.cjs`、`.eslintignore`、`.prettierignore`、`.editorconfig` | 质量与编辑器 |
| `.github/workflows/ci.yml` | push/PR：Node 22/24 × npm/yarn/pnpm，tsc、lint、prisma validate、build。**无 deploy job** |
| `docs/`、`README.md`、`LICENSE.md` | 人读 |
| `.claude/`、`.cursor/`、`.gemini/`、`.mcp.json` | 开发辅助 |

### 9.3 当前部署成熟度

已闭环：本机 `dev`、`typecheck` / `lint` / `test` / `build`、Prisma 迁移、Docker **镜像能编出来**。

未闭环：worker 尚未纳入镜像/编排、toml 中的公网 URL 仍为占位、无平台 Secret、CI 停在 build、无失败重试队列（同步仍是请求内/调度内直接执行，靠 `DataSyncJob` 台账而非队列）。PostgreSQL 可多实例共享，但 cron 任务需要跨进程去重（目前只有同店同类任务的 `hasRunningJob` 检查）。

---

## 10. 质量与验证对应关系

| 检查 | 覆盖 | 不代表 |
| --- | --- | --- |
| `tests/inventory-calculations.test.ts` | Observed Demand 口径、公式、建议量与状态边界、日期天数 | 未与真实店铺对账 |
| `tests/reorder-confidence.test.ts` | 三档置信度与 hard/soft/info 降信规则 | 未验证 UI 阅读体验 |
| `tests/data-health.test.ts` | 6 项检查、暂停阈值、不阻断项 | 未验证真实故障场景 |
| `tests/reorder-action-board.test.ts` | 六态归类矩阵、计数与采纳率分母 | 未验证筛选交互 |
| `tests/reorder-export.test.ts` | 27 列顺列、CRLF、转义与公式护栏 | 未验证浏览器下载 |
| `tests/reorder-recommendations.test.ts` | 决策 intent / 状态机 / 数量 | 未写 Shopify |
| `tests/product-copy.test.ts` | 配置、Zod、错误归类、超时、密钥不泄漏 | 未真实打 Provider |
| `shopify app config validate` | toml 语法 | 线上服务已部署 |

阶段 2 已在开发店铺 `stepchic.myshopify.com` 跑通真链路（Prisma 远程 Postgres + Admin GraphQL `2026-10`）：同步→ pending 自动登记→接受/调整/忽略/已采购各写一行审计→采纳率 0.67 / 已处理 0.60→5 行 CSV；把时钟拨到 52 小时后 Data Health 翻为 paused，看板行归 Paused、已下单行不改写、导出列里带暂停说明。页面渲染需要登录后台的浏览器验收（开发隧道与 worker 已在跑）。

端到端仍需：测试商店重新授权 → 选地点同步并对账 Admin →（若开放文案）店主测连接 → 生成草稿 → 商家确认后写回。

---

## 11. 阅读与改动导航

| 目标 | 从这里读 |
| --- | --- |
| 嵌入鉴权与 session | `app/shopify.server.ts` → `app/routes/app.tsx` |
| SSR 如何出 HTML | `app/entry.server.tsx` → `app/root.tsx` |
| 库存主路径 | `app/routes/app.inventory.tsx` → `app/inventory.server.ts` → `app/lib/*` |
| 数据健康与暂停 | `app/lib/data-health.ts` → `app/inventory.server.ts`（组装输入） |
| 文案主路径 | `app/features.ts` → `app.copy.tsx` → `pi.server.ts` |
| 表结构 | `prisma/schema.prisma` |
| 本地如何起 | `shopify.web.toml` + README |
| 上线还缺什么 | [architecture-and-deployment.md](./architecture-and-deployment.md) 第 8–10 节 |

改库存算法：只动 `app/lib/inventory-calculations.ts`（及对应测试）。改同步口径或 GraphQL：`app/inventory.server.ts`。改页面交互：`app.inventory.tsx`。改 OAuth/scopes：`shopify.server.ts` + `shopify.app.toml`，并让已装店铺重新授权。新增纯逻辑模块请放 `app/lib/`，不要放 `app/` 根（见第 4 节命名硬约束）。

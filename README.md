# my-pi — Shopify AI 商品文案与 StockPilot 库存助手

面向 Shopify Admin 的嵌入式库存优化应用。当前阶段聚焦 StockPilot 库存诊断与确定性补货建议；AI 商品文案生成功能暂时通过功能开关隐藏，代码与已有草稿数据保留，后续可重新开放。库存功能只读取 Shopify 数据，不会自动修改库存或创建采购订单。

## 技术架构

完整架构、数据流、部署拓扑与生产化差距见[技术架构与部署设计](./docs/architecture-and-deployment.md)。目录职责、请求从入口到页面的流转，以及构建/部署与各文件的对应关系见[详细设计文档](./docs/detailed-design.md)。

| 层 | 当前技术 |
| --- | --- |
| 运行时 | Node.js 22.19+、TypeScript、npm |
| Web 应用 | React 18、React Router 7（服务器端 loader/action）、Vite 7 |
| Shopify 集成 | Shopify 官方 React Router 库、OAuth/session、App Bridge、Admin GraphQL API `2026-10` |
| 管理界面 | Shopify Admin 嵌入式界面与 Shopify Web Components（`s-*`） |
| 数据 | Prisma 6 + PostgreSQL（本地开发指向 Supabase）；保存 Shopify session、商品文案草稿、多地点每日库存快照、库存变化事件、每日销量、补货建议决策、建议变更审计流水和同步任务台账 |
| 后台调度 | 独立 Node worker 进程（`worker/index.ts`）+ node-cron；与 Web 进程分离 |
| 文案生成 | 服务端 Pi Coding Agent SDK + Zod；模型/API key 只从服务器环境读取 |
| 库存分析 | Shopify Admin GraphQL API + 确定性 TypeScript 计算；AI 不参与销量或采购数量计算 |
| 开发部署 | Shopify CLI；本地开发使用临时 HTTPS 隧道 |

主要代码入口：

- `app/shopify.server.ts`：Shopify 应用、Admin API 认证和 Prisma session storage；使用离线 access token（`useOnlineTokens: false`），使 worker、定时任务和 webhook 能在商家不在场时调用 Admin API。
- `app/routes/app._index.tsx`：库存优化工作台首页，引导商家进入库存诊断。
- `app/routes/app.copy.tsx`：单商品文案生成、预览及确认写回。
- `app/routes/app.history.tsx`：当前店铺最近 100 条文案任务。
- `app/routes/app.settings.tsx`：模型配置状态和连接测试。
- `app/features.ts`：产品功能开关；`PRODUCT_COPY_ENABLED` 默认关闭，重新开放文案功能时设为 `true`。
- `app/routes/app.tsx`、`app/styles/app-shell.css`：店铺内统一导航、当前店铺标识和响应式工作台布局。
- `app/routes/app.inventory.tsx`、`app/routes/app.data-health.tsx`、`app/inventory.server.ts`：StockPilot 库存地点选择、手动同步、六态 Action Board、每日快照与销量重算、库存诊断、补货决策与 dashboard 数据。
- `app/sync-jobs.server.ts`：把所有同步登记进 `DataSyncJob` 台账，并提供并发去重和「最后一次成功时间」。
- `app/lib/`：纯计算与规则模块（无 I/O、可单测）。`inventory-calculations.ts` 算 Observed Demand 与补货公式，`reorder-confidence.ts` 算置信度与降信原因，`data-health.ts` 算检查清单与暂停判定，`reorder-action-board.ts` 算六态归类与采纳率，`reorder-export.ts` 序列化 CSV，`reorder-recommendations.ts` 定决策状态与审计映射。**新增纯逻辑模块请放 `app/lib/`：`app/` 根下的模块名会占用 `/app/<name>` 这条 URL，把 SSR 页面吞成 JS 模块。**
- `app/pi.server.ts`：隔离的 Pi agent session、模型调用及输出校验。
- `app/db.server.ts`、`prisma/schema.prisma`：数据库连接、Shopify session、`ProductDraft` 和 StockPilot 数据模型。
- `worker/index.ts`：后台 worker，按 cron 抓全店多地点每日快照并重建销量窗口。
- `app/webhook-sync.server.ts` 与 `app/routes/webhooks.*.tsx`：卸载、权限更新、隐私合规 Webhook，以及 `inventory_levels/update`、`orders/create`、`orders/cancelled` 增量同步。
- `shopify.app.toml`、`shopify.web.toml`：唯一 Shopify 应用配置和本地 web process 命令。

## 已实现功能与流程

1. Shopify OAuth 完成后，通过官方库以离线 access token 认证 Admin 请求并保存店铺级 session，供后台 worker 与 webhook 复用。
2. 页面从 Admin GraphQL 读取按标题排序的前 50 个商品供选择。
3. 店铺所有者可发起模型连接测试；测试只验证一次服务端模型请求，不创建商品草稿。模型凭据从 `PI_API_KEY`、`PI_PROVIDER`、`PI_MODEL` 读取，不会返回浏览器或保存到数据库。
4. 生成时重新读取选中商品，将标题和描述传给隔离的 Pi SDK 临时 session；session 不启用文件、命令或其他 agent 工具。
5. Zod 校验模型返回的严格 JSON（标题 1–255 字符、描述 1–20,000 字符）；验证通过后才把建议与原始内容保存为草稿。生成请求以商店和 request ID 唯一约束防止重复提交。
6. 确认写回时用数据库条件更新抢占待处理草稿，再重新读取 Shopify 商品；若商品已变化则标记冲突并拒绝覆盖。重复确认已应用的草稿不会再次发起商品更新。
7. 应用卸载与商店删除 webhook 共用 `purgeShopBusinessData()`，按 `shop` 删除该商店的全部业务数据（含 `RecommendationAudit` 审计流水）并在日志记录每张表的行数；权限更新时更新 session scope。客户数据请求/删除 Webhook 当前只记录事件，因为本应用不存储客户数据。

## StockPilot 库存诊断与补货闭环

商家在 `/app/inventory` 选择一个 active 库存地点并手动同步。系统读取 active 商品变体、该地点可售/在途库存，以及全店已支付订单；同步完成后可查看 30/60/90 天销量、库存覆盖天数、预计缺货日期、风险状态及补货建议，并显示计算依据。

同步后所有建议量大于 0 的变体自动进入 `pending`，商家在六态 Action Board（`All` / `Pending` / `Accepted` / `Edited` / `Ignored` / `Ordered`，加上数据异常时的 `Paused`）上逐条处理：接受、调整数量、忽略或在接受后标记已采购。决策按店铺、库存地点和商品变体持久化，**每一次变更都在同一事务里追加一行 `RecommendationAudit`**（前/后态、建议量/确认量、置信度快照、操作者），页面下方可直接查看流水。因为使用离线 session，审计只能区分 `system`（同步登记）和 `merchant`（应用内操作），不声称识别到具体员工。标记已采购仅更新应用内状态，不会创建 Shopify 采购订单或改动 Shopify 库存。

每条建议带一个 Reorder Confidence 徽章（high / medium / low）和可展开的降信原因：销售历史不完整、快照不是今天、无销量样本、缺成本等会拉低置信度；置信度只回答“该不该信这个数字”，不改变建议量。看板可一键导出 27 列 CSV 补货计划（含地点、变体、销量、可售/在途、建议量、置信度与降信原因），供线下与供应商沟通使用。

计算由确定性代码执行：Observed Demand = 窗口内销量 ÷ 可见样本天数（**不用窗口天数做分母**，避免把权限或数据缺口读成“销量变低”）；补货点 = 日均 ×（默认交期 + 安全库存天数）；目标库存 = 日均 ×（交期 + 检查周期 + 安全天数）；建议补货量 = max(0, 目标库存 - 可售库存 - 在途库存)。初始交期为 14 天、安全库存为 7 天、检查周期为 14 天，均是系统估算值。AI 不决定库存状态或采购数量。

销量口径为 Shopify `processedAt` 日期内、未取消且财务状态为已支付、部分退款或已退款的订单商品数量；退款/退货数量不扣减。库存仅对应所选地点，销量是全店汇总。Shopify 默认只允许读取最近 60 天订单；90 天销量与长期滞销判断需要 Shopify 批准并实际授权 `read_all_orders`，否则页面会明确标记历史不完整。商品成本还受 Shopify 用户“查看商品成本”权限影响，缺失成本时库存价值是不完整估算。

`/app/data-health` 把上面这些缺口做成可行动的检查清单（授权、主地点、快照新鲜度、销量历史、同步失败、商品成本）。只有阻断建议的 critical 项（主地点缺失、无快照或快照超过 48 小时、连续 2 次同步失败）会把看板置为 `paused`：页面仍可读，但**服务端会重算并拒绝任何接受/调整/忽略/已采购操作**，避免用过期数据订货；按钮置灰只是体验，不是约束本身。

数据地基已就位：每日快照为时间序列（同一地点×变体每天一行）、库存变化写入 `InventoryEvent` 事件流、每次同步登记 `DataSyncJob`；后台 worker 按 cron 跑全地点快照与销量重建，`inventory_levels/update` 与 `orders/*` webhook 做增量重算。尚未做的是：同步队列与失败重试面板、多地点需求分析、供应商/MOQ、采购计划审批与 Shopify 采购单。大店数据量下需先完善队列与重试，再用于生产运营。

## 首页与任务导航

当前应用导航以库存优化为主，首页直接展示真实看板数据：指标卡、最紧急的几条建议、Data Health 摘要和最近决策流水都来自 `getInventoryDashboard` / `getRecentRecommendationAudit`；尚未实现的能力（批量文案、多语言、SEO、供应商与采购计划等）只标记“Not enabled yet”，不展示编造的示例数字。文案生成与历史记录页面由 `PRODUCT_COPY_ENABLED` 功能开关控制；开关关闭时，相关入口不显示，直接访问页面或提交操作会返回库存优化页，现有路由代码和草稿数据不删除。Settings 已改为独立的一级菜单，不再受该开关拦截。后续准备重新开放时，在 `app/features.ts` 将该常量设为 `true`，并重新验证模型配置与生成写回流程。店铺切换和 Shopify 账号入口由 Shopify Admin 原生外壳提供。

供应商管理和采购计划当前作为后续规划方向展示，不代表相应功能已实现。

## 本地开发

先安装 Node.js、npm、Shopify CLI，并准备 Dev Dashboard 应用、开发商店和模型 API key。

```sh
npm install
cp .env.example .env
```

在 `.env` 写入 PostgreSQL 连接串 `DATABASE_URL`（本地开发指向 Supabase，需带 `?sslmode=require`）；Supabase 直连 5432 对 HTTPS 代理/透明网关类工具敏感，本机开着这类代理时会报 `P1001`。

在 `.env` 设置 `PI_API_KEY`；默认模型为 `openai/gpt-4.1-mini`，可用 `PI_PROVIDER`、`PI_MODEL` 覆盖。密钥只供服务器模型调用使用，不要提交 `.env` 或把密钥贴入聊天/浏览器。

页面中的“测试模型连接”会实际调用模型，可能产生 Provider 费用；按钮仅对 Shopify 在线会话中标记为店铺所有者的用户开放。模型请求有 90 秒超时。认证失败、限流、模型不可用和无效 JSON 会显示明确错误；生成失败或输出无效时不会保存建议内容。

应用流程仍将 AI 草稿生成与 Shopify 写回分开。确认写回前会检查原商品是否被其他人修改；发生冲突时需要重新生成草稿。PostgreSQL 中的 `generating` / `pending` / `applying` / `applied` / `failed` / `conflicted` 状态用于避免重复生成和重复写回。

> ⚠️ 切到离线 token 后，`session.onlineAccessInfo` 不再可用，Settings 页依赖「店铺所有者」判定的“测试模型连接”会一直拒绝，直到文案功能重新设计权限判定为止。

当前 `shopify.app.toml` 已绑定应用 `mypi`。如需更换绑定，可运行 `npm run config:link`；随后运行：

```sh
npm run dev
```

Shopify CLI 会运行 Prisma 生成/迁移、启动开发隧道并输出 Admin 预览链接。当前应用请求 `read_products`、`write_products`、`read_inventory`、`read_orders` 和 `read_locations`。权限变更后，测试商店需要重新授权。当前未请求受限的 `read_all_orders`，因此销量仅按最近 60 天计算，90 天销量/长期滞销数据不可用。

常用检查：

```sh
npm run typecheck
npm run lint
npm test
npm run build
shopify app config validate --json
```

跑后台 worker（需先从 `shopify app env pull` 取得 `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL`/`SCOPES`）：

```sh
npm run worker            # esbuild 打包后常驻跑 cron
```

worker 启动时会先补跑一次快照与销量重建，之后按 `WORKER_SNAPSHOT_CRON`（默认每小时第 15 分）和 `WORKER_SALES_CRON`（默认每天 03:00）调度；定时表达式可用 `.env` 覆盖。

## 当前边界与下一阶段

- 商品选择目前最多显示 50 个商品；后续可加入分页、搜索和筛选。
- StockPilot 已支持多地点数据模型与每日快照时间序列，但看板仍只看所选地点的最新快照日；补货决策可在应用内接受、调整、忽略或标记已采购，并留下审计流水与 CSV 导出，但不包含多地点需求分析、供应商/MOQ、采购计划审批或 Shopify 采购单。
- StockPilot 的销量是全店订单销量，不按库存地点归因；退款/退货没有从销量中扣减。
- 自动化单元测试覆盖配置、密钥不泄漏、Zod 输出边界、错误归类和超时取消；`app/lib/` 下每个纯逻辑模块（库存计算、置信度、Data Health、六态归类、CSV 导出、决策状态）都有对应单测。真实 Provider 调用仍需配置有效的本地 `PI_API_KEY` 后验证。
- 库存链路已在开发商店跑通一次实跑：全量同步→登记 pending→接受/调整/忽略/已采购四类决策与审计→采纳率计算→CSV 导出；并把时钟拨到 +52h 验证快照过期会进入 `paused` 且导出行带上暂停原因。注意开发商店若没有可用库存（应用不申请 `write_inventory`，无法手改现存量），建议会全部落进 `stockout`。商品文案真实模型调用和商品写回也仍需端到端验收，写回前必须由商家明确确认。
- 数据已切到 PostgreSQL（本地开发用 Supabase），但尚未配置生产 HTTPS 域名、平台 secret 和 `PI_API_KEY`。正式部署前还要把 worker 纳入镜像/编排（目前 `Dockerfile` 只跑 Web 服务），并补齐 secret 管理、监控、隐私政策、计费及 App Store 审核准备。
- webhook 增量与 cron 需要 offline session：切到 `useOnlineTokens: false` 后必须让测试商店重新授权一次，否则 session 表里没有 offline 记录，worker 和 webhook 都会拿到空 session。

本项目目前是开发/测试用 MVP，不应将临时开发隧道直接用于多副本生产部署。

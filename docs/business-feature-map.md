# my-pi 业务功能地图

> 文档基线：2026-11-01。本文按业务域梳理与业务功能直接相关的**配置与代码**（不含框架基建层，后者见 `framework-config-map.md`）。所有数据以 `shop`（店铺）为租户边界隔离。具体值以仓库文件为准。

## 一、业务能力全景

my-pi 目前包含两个业务域，一个在用、一个代码保留但默认关闭：

| 业务域 | 状态 | 入口路由 | 是否写回 Shopify |
|--------|------|----------|------------------|
| **StockPilot 库存优化**（当前主功能） | ✅ 启用 | `/app`、`/app/inventory`、`/app/data-health` | ❌ 只读 |
| **AI 商品文案生成** | ⛔ 关（由开关隐藏） | `/app/copy`、`/app/history`、`/app/settings` | ✅ 仅 `productUpdate`（需商家确认） |

---

## 二、业务相关的「配置」

### 1. 权限范围 — `shopify.app.toml`

```
scopes = "read_products,write_products,read_inventory,read_orders,read_locations"
```

- `read_inventory` / `read_locations` / `read_orders` → 库存与销量同步
- `read_products` / `write_products` → 文案读取与写回
- ⚠️ **关键缺口**：代码用 `session.scope` 是否含 `read_all_orders` 判断能否取 90 天销量（`inventory.server.ts` 的 `hasAllOrdersScope`，dashboard 以 `canReadAllOrders` 下传），但该 scope 未在 toml 申请，因此当前恒为 `false` → 只统计 60 天、页面显示「90 天历史不可用」警告；`sales90Days` 恒为 `null`，`dead_stock` 判断退化为 `no_sales`。销量分母用「可见样本天数」而不是窗口天数（见三.A）。
- 同样**刻意不申请** `write_inventory`：应用能读在售/在途/在手，但不能改 Shopify 库存，因此演示店铺若现存量为 0，补货建议只会全部落进 `stockout`。

### 2. 业务开关 — `app/features.ts`

```ts
export const PRODUCT_COPY_ENABLED = false;
```

`copy` / `history` 两个路由的 `loader` / `action` 首行判断它，`false` 时 `redirect("/app/inventory")`。数据与代码全部保留。侧栏导航不读这个开关：`app/routes/app.tsx` 里的 `NAV_ITEMS` 是写死的列表，本身就不含文案入口。`settings` 已提升为一级菜单，旧的拦截已移除，不再受本开关控制。

### 3. AI 模型环境变量 — `.env.example`

```
PI_API_KEY= / PI_PROVIDER=openai / PI_MODEL=gpt-4.1-mini
```

供文案功能读取（见 `app/product-copy.server.ts` 的 `getModelConfiguration`）。

### 4. 业务数据模型 — `prisma/schema.prisma` + 迁移

除 `Session` 外的 model 全是业务表：

| Model | 用途 | 关键字段 / 约束 |
|-------|------|-----------------|
| `ProductDraft` | 文案草稿 | `@@unique([shop, requestId])` 幂等；`status`（generating/pending/applying/applied/failed/conflicted） |
| `InventorySettings` | 店铺库存参数 | `shop` 为主键；`locationId`、`leadTimeDays=14`、`safetyStockDays=7`、`reviewPeriodDays=14`、同步时间戳 |
| `Location` | 启用中的地点目录 | `@@unique([shop, shopifyLocationId])` |
| `InventorySnapshot` | 库存快照时间序列 | `@@unique([shop, locationId, variantId, snapshotDate])`；同一地点×变体每天一行，切地点不清历史 |
| `InventoryEvent` | 只追加的可售变化事件 | `occurredAt` 索引，`source + externalId` 供对账 |
| `DataSyncJob` | 同步任务台账 | `queued/running/succeeded/failed`；`hasRunningJob` 同店同类型去重 |
| `SalesDaily` | 日销量 | `@@unique([shop, variantId, date])` |
| `ReorderRecommendation` | 补货决策 | `@@unique([shop, locationId, variantId])`；`status`（pending/accepted/edited/ignored/ordered）+ 置信度与解释字段 |
| `RecommendationAudit` | 只追加的决策流水 | 动作、前后态、建议量/确认量、置信度快照、`operator`（只有 `system` / `merchant`） |

对应迁移：`20261101000000_init_postgres_baseline` → `…_add_data_foundation` → `…_add_location_updated_at` → `…_add_p0_lite_replenishment`（切库时旧的 6 份 SQLite 迁移已作废）。

### 5. 业务 Webhook — `shopify.app.toml` + 处理器

`app/uninstalled` 与 `shop/redact` 都调 `webhook-sync.server.ts` 的 `purgeShopBusinessData(shop)`：按 `shop` 把 session / productDraft / inventorySnapshot / inventoryEvent / location / dataSyncJob / salesDaily / reorderRecommendation / **recommendationAudit** / inventorySettings 全部删干净，并把每张表的删除行数写进日志。两条路共用同一口径，就是为了避免新增表时只改一条。`customers/*` 只校验后记日志（本应用不存客户数据）。

---

## 三、业务代码分层

项目刻意区分**纯逻辑**、**服务端数据**、**路由**，便于测试。

### A. 纯计算模块（`app/lib/*`，无副作用，直接单测）

> 命名硬约束：纯逻辑一律放 `app/lib/`。`app/` 根下的模块名会占用 `/app/<name>` 这条 URL（Vite 先按文件路径回源码），SSR 路由会被吞掉。

- `lib/inventory-calculations.ts` — `calculateInventoryHealth()`：**Observed Demand（窗口销量 ÷ 可见样本天数，不是窗口天数）**、覆盖天数、补货点、目标库存、建议采购量、预计缺货日、8 种健康状态 + 结构化公式文案；附 `shiftDate` / `formatDateInTimeZone` 日期工具。**确定性算法，AI 不参与库存决策。**
- `lib/reorder-confidence.ts` — Reorder Confidence 三档（high/medium/low）与逐条降信原因：`hard` 直接 low、`soft` 累计 1 条 medium / 2 条 low、`info` 只披露不降档。
- `lib/data-health.ts` — `evaluateDataHealth()`：6 项检查清单 + `paused` 判定（只有 `blocksRecommendations` 的 critical 才暂停补货），纯派生不落库。
- `lib/reorder-action-board.ts` — 六态归类（ordered 永远保留、建议消失时 accepted/edited 留、其余出榜、paused 覆盖 pending/accepted、needsReview 打回 pending）与采纳率口径（分母为 0 返 `null`）。
- `lib/reorder-export.ts` — 27 列 CSV 序列化：CRLF + 尾空行、引号/逗号/换行转义、`= + - @` 前缀加护栏防公式注入、空值出空串。
- `lib/reorder-recommendations.ts` — 决策状态/意图的类型守卫、`canMarkReorderRecommendationOrdered()` 状态机校验、`parsePositiveQuantity()` 数量解析、审计动作映射、操作者常量（只有 `system` / `merchant`）。

### B. 服务端数据层（`.server.ts`，含 Shopify GraphQL）

- `app/inventory.server.ts`（StockPilot 核心）— GraphQL 分页拉地点 / 店铺设置 / 变体库存 / 订单销量；`syncInventoryAndSales()` 手动全量同步（事务内替换快照 + 日销量，**只读不改 Shopify**），成功后把正数建议登记为 `pending` 并追加 `created` 审计；`getInventoryDashboard()` 组装看板（健康度 + 置信度 + 六态 Action Board + Data Health）；`saveReorderRecommendation()` 写决策并追加一行审计；`saveInventoryLocation()` 记下所选地点；`buildReorderExport()` 出 CSV。所有交互式写入走 `withTransaction()`（远程 Postgres 每语句一次往返，默认 5s 会撞 `P2028`）。含「无成本读取权限」容错。
- `app/product-copy.server.ts` — 模型配置读取与校验、超时封装 `withModelTimeout`、异常归类 `normalizeModelError`、Zod `parseProductCopyResponse`、`ProductCopyError` 错误码字典。
- `app/pi.server.ts` — 用 Pi SDK 建**一次性隔离 session**（无工具 / 内存设置 / 临时目录）生成文案与测连通，任务即释放，不持久化。
- `app/db.server.ts` — 全应用共用 PrismaClient。

### C. 业务路由（loader / action）

- `app/routes/app.inventory.tsx` — 六态 Tab + 地点选择 / 同步 / 接受·调整·忽略·标记已采购 / `export-csv`；GID 正则校验；置信度徽章与公式解释；暂停时置灰按钮并在服务端重算后拒绝；`s-*` Web Components 渲染指标卡与决策流水。
- `app/routes/app.data-health.tsx` — 检查清单、暂停原因与恢复动作、同步任务台账（`recentJobs`）。
- `app/routes/app.copy.tsx` — `generate`（幂等：requestId + 唯一约束；先建 `generating` 草稿再补 `pending`）与 `apply`（**CAS 抢占 `pending→applying` → 重读商品做冲突检测 → 一致才 `productUpdate` 写回**）。
- `app/routes/app.history.tsx` — 最近 100 条草稿列表。
- `app/routes/app.settings.tsx` — 模型状态展示 + 仅店主可测连通。
- `app/routes/app._index.tsx` — 工作台首页：指标卡、优先建议、Data Health 摘要与最近决策都走真实数据；尚未实现的能力只写「Not enabled yet」，不放占位数字。

---

## 四、端到端数据流（以库存为例）

```
商家操作 → route.action (authenticate.admin)
   → inventory.server 分页读 Shopify Admin GraphQL
   → Prisma 事务写 snapshot / salesDaily / settings
   → getInventoryDashboard 读库 + lib/* 纯算（健康度/置信度/六态/Data Health）
   → 返回 {metrics, variants, recommendation, actionBoard, dataHealth} 渲染
   → 决策写 ReorderRecommendation + 追加 RecommendationAudit
```

补货决策只落 `ReorderRecommendation` 表，**从不回写 Shopify 库存或建采购单**；`dataHealth.paused` 为 true 时 loader 不阻断页面，但 action 会重算一次 dashboard 并直接拒绝任何决策（UI 置灰只是体验，服务端重算才是约束）。文案是唯一会写回 Shopify 的业务，且必须商家二次确认。

---

## 五、测试覆盖 — `tests/`

`tests/` 下每个 `lib/*` 纯逻辑模块都有对应单测（`node --test` 跑，不触网、不连库）：`inventory-calculations`、`reorder-confidence`、`reorder-recommendations`、`reorder-action-board`、`reorder-export`、`data-health`，另有 `product-copy` 覆盖配置、密钥不泄漏、Zod 边界、错误归类与超时。

---

## 六、关键业务要点

1. **`read_all_orders` 缺失**导致 90 天销量 / 滞销判断当前不可用（见二.1）；代码不用窗口天数做销量分母，而是用可见样本天数折算日均，避免把权限缺口读成「销量变低」。
2. **不申请 `write_inventory`**：无法改 Shopify 现存量，因此建议只会把手工造的数据推向 `stockout`，要看到健康的覆盖天数需要店铺本身有可用库存。
3. **文案功能整体被 `PRODUCT_COPY_ENABLED=false` 隐藏**，但其 `write_products` scope 仍申请着。
4. **AI 与决策严格分离**：模型只产文案建议；库存补货量完全由确定性规则算，不受模型影响。
5. **审计只能区分 `system` / `merchant`**：offline session 拿不到员工身份，所以文案与数据都不能声称“是谁做的”。

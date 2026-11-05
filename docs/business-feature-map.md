# mypi 业务功能地图

> 文档基线：2026-11-03。本文按业务域梳理与业务功能直接相关的**配置与代码**（不含框架基建层，后者见 `framework-config-map.md`）。所有数据以 `shop`（店铺）为租户边界隔离。具体值以仓库文件为准。

## 一、业务能力全景

mypi 定位为 Shopify 后台的**库存决策智能**应用：把店铺自身的销量与库存算成可解释、可追溯、可交付的补货决策闭环。**对 Shopify 全程只读**，不自动改库存、不建采购单；补货量完全由确定性规则计算，AI 不参与库存决策。

| 业务域 | 状态 | 入口路由 | 是否写回 Shopify |
|--------|------|----------|------------------|
| **StockPilot 库存诊断与补货**（主功能） | ✅ 启用 | `/app`、`/app/inventory` | ❌ 只读 |
| **供应商与供货条款** | ✅ 启用 | `/app/suppliers` | ❌ 只读（本应用自有数据） |
| **采购计划** | ✅ 启用 | `/app/purchase-plans` | ❌ 只读（「已下单」仅改应用内状态与审计） |
| **数据健康** | ✅ 启用 | `/app/data-health` | ❌ 只读 |
| **补货参数设置** | ✅ 启用 | `/app/settings` | ❌ 只读 |
| **指引与反馈** | ✅ 启用 | `/app/docs` | ❌ 只读 |
| **Supply Chain（分段交期/停工日历）** | ⏳ 占位「coming soon」 | `/app/supply-chain` | ❌ 未实现 |
| **AI 商品文案生成** | ⛔ 关（开关隐藏，且已不申请写权限） | `/app/copy`、`/app/history` | ❌ 现无 `write_products`，写回不可用 |

---

## 二、业务相关的「配置」

### 1. 权限范围 — `shopify.app.toml`

```
scopes = "read_products,read_inventory,read_orders,read_locations"
```

- `read_inventory` / `read_locations` / `read_orders` → 库存与销量同步。
- `read_products` → 读取变体、标题、SKU、成本（成本读取另受 Shopify 用户「查看商品成本」权限影响）。
- **已不再申请 `write_products`**：文案功能关闭后应用对 Shopify 完全只读，写回路径当前不可用。
- ⚠️ **关键缺口 — `read_all_orders` 未申请**：代码用 `session.scope` 是否含 `read_all_orders` 判断能否取 90 天销量（`inventory.server.ts` 的 `hasAllOrdersScope`，看板以 `canReadAllOrders` 下传），但该 scope 未在 toml 申请，当前恒为 `false` → 只统计 60 天、页面显示「90 天历史不可用」警告；`sales90Days` 恒为 `null`，`dead_stock` 判断退化为 `no_sales`。销量分母用「可见样本天数」而非窗口天数（见三.A）。
- ⚠️ **刻意不申请 `write_inventory`**：应用能读在售/在途/在手，但不能改 Shopify 库存，因此演示店铺若现存量为 0，补货建议会全部落进 `stockout`。

### 2. 业务开关 — `app/features.ts`

```ts
export const PRODUCT_COPY_ENABLED = false;
```

`copy` / `history` 两个路由的 `loader` / `action` 首行判断它，`false` 时 `redirect("/app/inventory")`。数据与代码全部保留。侧栏导航 `app/routes/app.tsx` 的 `NAV_ITEMS` 是写死列表，本身不含文案入口。`settings` 已提升为一级菜单，不再受本开关控制。

### 3. AI 模型环境变量 — `.env.example`

```
PI_API_KEY= / PI_PROVIDER=openai / PI_MODEL=gpt-4.1-mini
```

仅供（当前关闭的）文案功能读取，见 `app/product-copy.server.ts` 的 `getModelConfiguration`。

### 4. 业务数据模型 — `prisma/schema.prisma` + 迁移

除 `Session` 外的 model 全是业务表：

| Model | 用途 | 关键字段 / 约束 |
|-------|------|-----------------|
| `ProductDraft` | 文案草稿（功能已关） | `@@unique([shop, requestId])` 幂等；`status` |
| `InventorySettings` | 店铺库存参数 | `shop` 主键；`locationId`、`leadTimeDays=14`、`safetyStockDays=7`、`reviewPeriodDays=14`、`salesWindowStart`、`replenishmentSettingsSavedAt`（null=仍是系统默认，供 UI 如实标注来源）、同步时间戳 |
| `Location` | 启用中的地点目录 | `@@unique([shop, shopifyLocationId])` |
| `InventorySnapshot` | 库存快照时间序列 | `@@unique([shop, locationId, variantId, snapshotDate])`；同一地点×变体每天一行，切地点不清历史 |
| `InventoryEvent` | 只追加的可售变化事件 | `occurredAt` 索引，`source + externalId` 供对账 |
| `DataSyncJob` | 同步任务台账 | `queued/running/succeeded/failed`；`activeKey` **唯一**（running 期间占 `shop:jobType`）即跨进程任务锁 |
| `SalesDaily` | 日销量 | `@@unique([shop, variantId, date])` |
| `Supplier` | 供应商档案 | `@@unique([shop, name])`；`leadTimeDays`（null 沿用店铺级参数）、`isActive` |
| `VariantSupplier` | 变体级供货绑定 | `@@unique([shop, variantId])`；`minOrderQuantity`(MOQ)、`casePack`(整箱)、`unitCost`；对 `Supplier` 级联删除 |
| `PurchasePlan` | 采购计划头 | `@@unique([shop, reference])`（`PP-0001` 店内递增）；`status` `open→ordered/cancelled`、`supplierName` 名称快照、`purchaseDate`、`orderedAt` |
| `PurchasePlanLine` | 采购计划行 | `@@unique([planId, variantId])`；`quantity` 商家确认量、`unitCost`；对计划级联删除 |
| `ReorderRecommendation` | 补货决策当前态 | `@@unique([shop, locationId, variantId])`；`status`（pending/accepted/edited/ignored/ordered）+ 置信度/需求快照 + `decisionReason`（最近一次改量/忽略理由）+ `computedAt` |
| `RecommendationAudit` | 只追加的决策流水 | 动作、前后态、建议量/确认量、置信度快照、`operator`（仅 `system`/`merchant`）、`reason`、**`requestKey` 唯一**（请求级幂等，系统写入为 null） |
| `AnalyticsEvent` | 产品埋点事件 | append-only；`type`（取值以 `app/lib/analytics.ts` 清单为准）、`props` 只放业务上下文不放个人信息 |
| `AdviceFeedback` | 单条建议反馈 | `verdict`（useful/not_useful，由 reason 推导）、`reason`（too_high/too_low/not_needed_now/bad_data/other）、`auditId` 关联 |

对应迁移（10 条，按序）：`…_init_postgres_baseline` → `…_add_data_foundation` → `…_add_location_updated_at` → `…_add_p0_lite_replenishment` → `…_add_sync_job_claim_key` → `…_add_replenishment_settings_source` → `…_add_suppliers` → `…_add_purchase_plans` → `…_add_analytics_feedback` → `…_add_decision_reason_idempotency`。

### 5. 业务 Webhook — `shopify.app.toml` + 处理器

- **增量同步**：`inventory_levels/update`、`orders/create`、`orders/cancelled` 触发单日重算（scoped 到该日，非整店破坏）。
- **卸载与合规**：`app/uninstalled` 与 `shop/redact` 都调 `webhook-sync.server.ts` 的 `purgeShopBusinessData(shop)`，按 `shop` 把 session / productDraft / inventorySnapshot / inventoryEvent / location / dataSyncJob / salesDaily / supplier / variantSupplier / purchasePlan(+lines) / reorderRecommendation / **recommendationAudit** / analyticsEvent / adviceFeedback / inventorySettings 全部删干净，并把每张表删除行数写进日志。两条路共用同一口径，避免新增表时只改一条。`customers/*` 只校验后记日志（本应用不存客户数据）。

---

## 三、业务代码分层

项目刻意区分**纯逻辑**、**服务端数据**、**路由**，便于测试。

### A. 纯计算模块（`app/lib/*`，无副作用，直接单测）

> 命名硬约束：纯逻辑一律放 `app/lib/`。`app/` 根下的模块名会占用 `/app/<name>` 这条 URL（Vite 先按文件路径回源码），SSR 路由会被吞掉。

- `inventory-calculations.ts` — `calculateInventoryHealth()`：**Observed Demand（窗口销量 ÷ 可见样本天数，不是窗口天数）**、覆盖天数、补货点、目标库存、建议采购量、预计缺货日、8 种健康状态 + 结构化公式文案。
- `reorder-confidence.ts` — Reorder Confidence 三档（high/medium/low）与逐条降信原因：`hard` 直接 low、`soft` 累计 1 条 medium / 2 条 low、`info` 只披露不降档。
- `data-health.ts` — `evaluateDataHealth()`：6 项检查清单 + `paused` 判定（只有 `blocksRecommendations` 的 critical 才暂停补货），纯派生不落库。
- `reorder-action-board.ts` — 六态归类（ordered 永远保留、建议消失时 accepted/edited 留、其余出榜、paused 覆盖 pending/accepted、needsReview 打回 pending）与采纳率口径（分母为 0 返 `null`）。
- `reorder-recommendations.ts` — 决策状态/意图类型守卫、`canMarkReorderRecommendationOrdered()` 状态机校验、`parsePositiveQuantity()`、审计动作映射、操作者常量（仅 `system`/`merchant`）。
- `reorder-export.ts` — 27 列补货 CSV 序列化：CRLF + 尾空行、引号/逗号/换行转义、`= + - @` 前缀加护栏防公式注入。
- `purchase-plans.ts` — 采购计划纯逻辑：按供应商归并建议、状态机校验、行合并/改量口径。
- `purchase-plan-export.ts` — 计划 CSV 序列化。
- `supplier-validation.ts` — 供应商与供货条款（MOQ/case pack/交期/单价/联系方式）的字段校验层，表单参数引用此层常量。
- `settings-validation.ts` — 补货参数（交期/安全库存/检查周期）校验层。
- `analytics.ts` — 埋点事件类型清单与记录口径（props 只放业务上下文）。
- `onboarding.ts` — 首次使用引导状态派生。
- `sync-job-policy.ts` — 同步任务并发去重、租约/认领与「最后一次成功时间」策略。
- `app-error.ts` / `route-error.ts` — 可序列化的分类错误与 `safeLoader`（见四）。
- `admin-graphql.server.ts` — Admin GraphQL 分页读取的服务端封装（含成本读取容错）。

### B. 服务端数据层（`.server.ts`，含 Shopify GraphQL）

- `app/inventory.server.ts`（StockPilot 核心）— 分页拉地点/店铺设置/变体库存/订单销量；`syncInventoryAndSales()` 手动全量同步（事务内替换快照 + 日销量，**只读不改 Shopify**），**非破坏性**：只重建真正重读到的窗口，订单为空/受限时保留既有需求证据；成功后把正数建议登记为 `pending` 并追加 `created` 审计；`getInventoryDashboard()` 组装看板（健康度 + 置信度 + 六态 Action Board + Data Health）；`saveReorderRecommendation()` 写决策 + 追加一行审计（带 operator/reason/requestKey）；`buildReorderExport()` 出 CSV。所有交互式写入走 `withTransaction()`（远程 Postgres 每语句一次往返，默认 5s 会撞 `P2028`）。
- `app/suppliers.server.ts` — 供应商与变体绑定的增删改查与校验；停用即退出计算，删除连带解绑其 SKU。
- `app/purchase-plans.server.ts` — 计划生成/合并/改量/改期/状态流转；`markPlanOrdered()` 用**真实计划行数量**回写审计、operator 标 `system`；计划 CSV。
- `app/analytics.server.ts` — 埋点与反馈落库。
- `app/product-copy.server.ts` / `app/pi.server.ts` — 文案功能（当前关闭）：模型配置校验、超时封装、Zod 校验、隔离一次性 session 生成。
- `app/sync-jobs.server.ts` — 把所有同步登记进 `DataSyncJob`，提供并发去重与「最后一次成功时间」。
- `app/db.server.ts` — 全应用共用 PrismaClient。

### C. 业务路由（loader / action）

- `app/routes/app._index.tsx` — 工作台首页：指标卡、优先建议、Data Health 摘要与最近决策都走真实数据；未实现能力只写「Not enabled yet」，不放占位数字。
- `app/routes/app.inventory.tsx` — 六态 Tab + 地点选择 / 同步 / 接受·调整·忽略·标记已采购 / `export-csv`；GID 正则校验；置信度徽章与公式解释；决策理由与请求级幂等；暂停时置灰按钮并在服务端重算后拒绝；同步横幅按 `pendingSuggestionsRegistered` 如实措辞。
- `app/routes/app.suppliers.tsx` — 供应商档案与逐变体供货条款维护。
- `app/routes/app.purchase-plans.tsx` — 计划列表、合并生成、改量改期、状态流转、计划 CSV。
- `app/routes/app.data-health.tsx` — 检查清单、暂停原因与恢复动作、同步任务台账（`recentJobs`）。
- `app/routes/app.settings.tsx` — 补货参数保存（校验 + 来源标注）；模型状态展示（文案相关）。
- `app/routes/app.docs.tsx` — 使用指引 + 店铺级/行级反馈入口。
- `app/routes/app.supply-chain.tsx` — 「coming soon」占位页。
- `app/routes/app.copy.tsx` / `app.history.tsx` — 文案生成与历史（受开关拦截）。
- `app/routes/health.tsx` — `/health` 存活端点，DB ping 失败返 `503`。

---

## 四、端到端数据流（以补货闭环为例）

```
商家操作 → route.action (authenticate.admin)
   → inventory/suppliers/purchase-plans.server 读 Shopify Admin GraphQL + 本应用数据
   → Prisma 事务写 snapshot / salesDaily / recommendation / audit / supplier / plan
   → getInventoryDashboard 读库 + lib/* 纯算（健康度/置信度/六态/Data Health）
   → 返回 {metrics, variants, recommendation, actionBoard, dataHealth} 渲染
   → 决策写 ReorderRecommendation + 追加 RecommendationAudit（operator/reason/requestKey）
   → 接受的建议按供应商归并进 PurchasePlan → 改量改期 → ordered → 计划 CSV
```

补货决策只落本应用表，**从不回写 Shopify 库存或建采购单**；`dataHealth.paused` 为 true 时 loader 不阻断页面，但 action 会重算一次 dashboard 并直接拒绝任何决策（UI 置灰只是体验，服务端重算才是约束）。

**请求级幂等**：每行决策带隐藏 `requestKey`（UUID），`RecommendationAudit.requestKey` 唯一。同一次表单提交（双击/重试）共用一个 key，撞唯一索引（`P2002`）即被识别为重放并拒绝重复落账，成功后换新 key；连续刻意决策各自入账，属预期。

**错误跨 SSR/Hydration 序列化**：读 loader 由 `safeLoader` 把异常折成可序列化、已分类的 `Response`（validation/auth/database/shopify_api/unknown；可重试类映射 `503`，其余 `500`），顶层 `ErrorBoundary` 读取该载荷，如实呈现错误类别且不产生 hydration 不一致。

---

## 五、测试覆盖 — `tests/`

`tests/` 下每个 `lib/*` 纯逻辑模块都有对应单测（`node --test` 跑，不触网、不连库），共 118 个：`inventory-calculations`、`reorder-confidence`、`reorder-recommendations`、`reorder-action-board`、`reorder-export`、`data-health`、`sync-jobs`、`app-error`、`product-copy`（配置、密钥不泄漏、Zod 边界、错误归类与超时）等。

---

## 六、关键业务要点

1. **对 Shopify 只读**：不申请 `write_products` / `write_inventory`；补货与计划都只落本应用表，「已下单」仅改应用内状态与审计。
2. **`read_all_orders` 缺失**导致 90 天销量 / 滞销判断当前不可用（见二.1）；销量分母用可见样本天数折算日均，避免把权限缺口读成「销量变低」。
3. **AI 与决策严格分离**：模型只产文案建议（且文案功能当前关闭）；库存补货量完全由确定性规则算。
4. **决策可追溯**：每次变更同事务追加 `RecommendationAudit`，含前后态、建议量 vs 确认量、置信度快照、`operator`、`reason`；offline session 只区分 `system`/`merchant`，不声称识别到具体员工。
5. **防误操作**：请求级幂等挡双击重复提交；`paused` 时服务端重算并拒绝任何决策。
6. **供应商影响计算口径**：`Supplier.leadTimeDays` 优先于店铺默认交期；建议量按 `VariantSupplier` 的 `minOrderQuantity` 与 `casePack` 向上取整。
7. **诚实性贯穿**：UI/文档如实反映数据事实（无建议就说无、权限缺口标缺口、不放编造样例数字）。
8. **租户隔离**：卸载/删除经 `purgeShopBusinessData(shop)` 按 `shop` 全表清除，含审计、埋点与反馈。

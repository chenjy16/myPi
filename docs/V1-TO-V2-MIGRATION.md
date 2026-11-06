# mypi V1.x → V2.0 迁移方案与代码资产映射

> 项目代号：Shopify Automation Toolkit
> 版本：V2.0（迁移设计稿）
> 依据：真实代码审计（阶段一）+ Shopify API 核实（阶段二）
> 关联文档：`docs/PRD-V2.0.md`、`docs/V2-OPEN-QUESTIONS.md`、`docs/V2-MVP-ACCEPTANCE.md`

本文件是四份 V2.0 交付文档的**代码事实基线**。所有"可复用 / 需重构 / 应废弃"的判断都以仓库真实调用链为准，不以文件名推测。PRD、验收、Open Questions 中引用的模块状态、表名、路由名都必须与本文件一致。

---

## 0. 迁移总原则（红线）

1. **不删旧表**：V1.x 现存 16 张业务表全部保留，软废弃的模块（Suppliers / Purchase Plans / Product Copy）只隐藏入口、不 DROP。
2. **保护 Session**：升级不得触发商家重新授权。`Session` 表结构、`client_id`、`redirect_urls`、已发 offline token 均保持不变（近期已修复 `redirect_urls` → `/auth/callback`，见提交 5389a25）。
3. **增量加表，不改旧列语义**：V2 新增模型（Shop / Automation / ExecutionLog …）用新表 + 新迁移，旧表既有列含义不动。
4. **复用优先于重写**：OAuth、adminGraphql、限流退避、任务锁、worker cron、合规删除清单——这些是已上生产的稳定资产，V2 直接继承并在其上抽象，不换框架（React Router / Prisma / PostgreSQL / Shopify App SDK / node-cron 体系全部保留，遵守委托 16.4）。
5. **每个新增能力都要对应 Shopify 已核实能力**：本文件标注 `VERIFIED` 的 API 才可进入 P0；标注 `待验证` 的必须进 `V2-OPEN-QUESTIONS.md`，不得为凑模板虚构（委托 16.2/16.7）。
6. **不修改业务代码**：本任务只产文档（委托 16.8）。以下"需要重构的代码 / 需要新增的迁移"是给研发团队的实施说明，不是本次执行动作。

---

## 1. V1.x 代码资产清单（审计结论）

实现状态图例：`IMPLEMENTED` = 已完成可直接复用；`PARTIALLY` = 部分可用需改造；`NOT` = 未实现（V2 需新建）。

### 1.1 Shopify OAuth / Session

| 项 | 值 |
|---|---|
| 代码路径 | `app/shopify.server.ts`、`app/routes/auth.$.tsx`、`app/routes/auth.login/*` |
| 关键实现 | `@shopify/shopify-app-react-router` v3；`authPathPrefix="/auth"` → callback `/auth/callback`；`useOnlineTokens:false`（offline token）；`PrismaSessionStorage` |
| 关联模型 | `Session`（`prisma/schema.prisma:15`） |
| 状态 | **IMPLEMENTED** |
| V2 复用 | 完全保留，不动 client_id / scopes 之外的认证逻辑 |
| 关键事实（务必携带进 V2） | **`Session.shop` 无唯一约束**：同一店铺可有多条 session（online/offline、历史残留）。V2 **不得**把 `Session.shop` 当租户主键，必须引入独立 `Shop` 租户模型（见 §3）。 |

### 1.2 Shopify API Client（→ API Gateway）

| 项 | 值 |
|---|---|
| 代码路径 | `app/lib/admin-graphql.server.ts`（`adminGraphql<T>()`）；`app/lib/shopify-throttle.ts`（纯策略层） |
| 关键实现 | Admin GraphQL 唯一出口；官方客户端 `tries`（resolveTries → 1 或 4）；节流退避 `throttleWaitMs` 封顶 5s；错误分类 `validation / auth / shopify_api`；单测覆盖纯函数 |
| 关联模型 | 无（纯运行时） |
| 状态 | **IMPLEMENTED** |
| V2 复用 | 直接作为 **API Gateway** 基座。V2 Action Executor 对 Shopify 的每次 Mutation 都走 `adminGraphql`，天然获得限流退避 + 统一错误语义。 |
| 需补 | Mutation 需要一个"写操作 + requestSource 标识"的封装（供 Loop Protection 打标记），属薄封装不改现有读逻辑。 |

### 1.3 Webhook（→ Event Ingestion Hub）

| 项 | 值 |
|---|---|
| 代码路径 | `app/routes/webhooks.*.tsx`（11 个路由）、`app/webhook-sync.server.ts` |
| 现有订阅 | `app/uninstalled`、`app/scopes_update`、`inventory_levels/update`、compliance（`customers/data_request`、`customers/redact`、`shop/redact`）；`orders/create`、`orders/cancelled` 路由**已就位但未订阅**（`shopify.app.toml:31-33`，protected customer data 审批墙） |
| 现有处理范式 | "payload 只当失效信号，数值一律回 Admin API 重读"（`webhook-sync.server.ts:9`）；重算式写入（同日 upsert / 整日重建）；解析失败只记日志不抛错 |
| 关联模型 | 写 `InventorySnapshot`、`InventoryEvent`、`SalesDaily`、`DataSyncJob` |
| 状态 | **PARTIALLY IMPLEMENTED** |
| V2 复用 | 路由壳（快速 200 返回、HMAC 由库校验）、`app/uninstalled`→`purgeShopBusinessData` 合规链路可复用 |
| V2 缺口（必须新建） | ① **无 delivery-id 去重表**：现有靠"重算幂等"兜底，不满足 V2 "同一 webhook 只触发一次自动化"要求 → 新增 `WebhookDelivery` 表（§3、委托 7.2）。② 无 Event Normalization / Automation Matcher 分层。③ orders/* / customers/* 订阅受**审批墙**阻塞（见 §4 风险 R1）。 |

### 1.4 Worker（→ Automation Execution Engine）

| 项 | 值 |
|---|---|
| 代码路径 | `worker/index.ts`、`build-worker/worker.mjs`；`app/sync-jobs.server.ts` + `app/lib/sync-job-ledger.ts` + `app/lib/sync-job-policy.ts` |
| 关键实现 | node-cron 调度（noOverlap）、SIGTERM 优雅退出；`installedShops` 用 `session.findMany({where:{isOnline:false}, distinct:["shop"]})`；**`DataSyncJob.activeKey @unique`（"shop:jobType"）做跨进程任务锁** + 租约回收 `reapStaleRunningJobs` / `leaseCutoff`；`withSyncJob()` 状态机 queued→running→succeeded/failed |
| 关联模型 | `DataSyncJob`（`prisma/schema.prisma:131`） |
| 状态 | **IMPLEMENTED**（作为骨架） |
| V2 复用 | **直接升级为 Execution Engine 骨架**：activeKey 唯一锁 = 队列防重复消费；租约回收 = Worker 崩溃恢复（E2E 场景 G）；noOverlap cron = ScheduledJob/Daily Schedule trigger 基础。 |
| V2 缺口 | 现有 job 类型是"数据同步"，需新增"自动化执行"job 类型与 `ExecutionQueue`；需要步骤级（ExecutionStep）结果而非单值 outcome。 |

### 1.5 Inventory Snapshot / Location（→ 可选数据服务）

| 项 | 值 |
|---|---|
| 代码路径 | `app/inventory.server.ts`、`app/lib/inventory-calculations.ts`、`app/lib/data-health.ts` |
| 关联模型 | `InventorySnapshot`、`InventoryEvent`、`Location`、`InventorySettings`、`SalesDaily` |
| 状态 | **IMPLEMENTED** |
| V2 处置 | 降级为**可选数据服务**。`inventory-calculations.ts` 的纯计算函数（available/lead-time 等）**保留复用**，作为 V2 "Inventory Low" trigger（模板 #4）的数据来源。`InventorySettings.timezone`/`currencyCode` 复用为 V2 Shop 时区/币种来源之一。 |

### 1.6 Recommendation（→ 自动化模板 & Action 素材）

| 项 | 值 |
|---|---|
| 代码路径 | `app/lib/reorder-recommendations.ts`、`reorder-confidence.ts`、`reorder-action-board.ts`、`reorder-export.ts` |
| 关联模型 | `ReorderRecommendation`、`RecommendationAudit`、`AdviceFeedback` |
| 状态 | **IMPLEMENTED** |
| V2 处置 | 降级为模板/Action。"补货建议 + Low Stock 通知"成为 Inventory 类自动化模板的一个用例。`RecommendationAudit.requestKey @unique`（`schema.prisma:291`）是**已在生产验证的幂等落账范式**，V2 `ExecutionLog`/`WebhookDelivery` 的去重索引直接沿用此模式。 |

### 1.7 Data Health（→ Integrations Health）

| 项 | 值 |
|---|---|
| 代码路径 | `app/lib/data-health.ts`、`app/lib/sync-freshness.ts`、`app/routes/app.data-health.tsx` |
| 状态 | **IMPLEMENTED** |
| V2 处置 | 转化为 **Integrations Health** 面板（数据新鲜度检查逻辑复用，扩展为 Shopify/Email/Webhook 三类连接的健康态）。 |

### 1.8 Suppliers / Purchase Plans（隐藏入口，保留数据）

| 项 | 值 |
|---|---|
| 代码路径 | `app/suppliers.server.ts`、`app/purchase-plans.server.ts`、`app/lib/supplier-validation.ts`、`app/lib/purchase-plans.ts`；路由 `app.suppliers.tsx`、`app.purchase-plans.tsx` |
| 关联模型 | `Supplier`、`VariantSupplier`、`PurchasePlan`、`PurchasePlanLine` |
| 状态 | **IMPLEMENTED**（但 V2 不暴露） |
| V2 处置 | 隐藏导航入口、保留数据与路由兼容（不 DROP）。清理策略见 §5。 |

### 1.9 Product Copy（继续停用）

| 项 | 值 |
|---|---|
| 代码路径 | `app/product-copy.server.ts`、`app/routes/app.copy.tsx`；`app/features.ts`（`PRODUCT_COPY_ENABLED=false`） |
| 关联模型 | `ProductDraft` |
| 状态 | **IMPLEMENTED 但已停用** |
| V2 处置 | 继续停用。`ProductDraft` 表保留。 |

### 1.10 Analytics（保留并扩展）

| 项 | 值 |
|---|---|
| 代码路径 | `app/lib/analytics.ts`、`app/analytics.server.ts` |
| 关联模型 | `AnalyticsEvent`（`type` + `props Json`） |
| 状态 | **IMPLEMENTED** |
| V2 处置 | 保留，新增自动化指标事件类型（automation.created / executed / failed / retried）。 |

### 1.11 合规删除

| 项 | 值 |
|---|---|
| 代码路径 | `app/webhook-sync.server.ts` `SHOP_SCOPED_DELETES`（16 表清单）、`purgeShopBusinessData()` |
| 状态 | **IMPLEMENTED** |
| V2 处置 | **必须同步扩展清单**：新增的 `Shop`/`Automation`/`AutomationVersion`/`WebhookDelivery`/`ExecutionLog`/`ExecutionStep`/`Integration`/`ScheduledJob` 全部要进删除清单，否则 GDPR/shop:redact 漏删。委托 7.6 硬要求。 |

### 1.12 UI / 导航

| 项 | 值 |
|---|---|
| 代码路径 | `app/routes/app.tsx`（现有导航：Home/Inventory/Replenishment(app.supply-chain)/Purchase Plans/Suppliers/History/Data Health/Metrics/Docs/Copy/Settings）、`app/styles/*`、`app/components/ui/*` |
| 状态 | **IMPLEMENTED**（V1 信息架构） |
| V2 处置 | 导航重写为五入口（Automation Center / Templates / My Automations / Activity Logs / Integrations）。现有 `ui/` 组件与 token 样式**复用**，满足委托 10 的统一组件规范。 |

### 1.13 资产汇总

- **可直接复用（IMPLEMENTED）**：OAuth/Session、adminGraphql（API Gateway）、throttle 退避、DataSyncJob 任务锁、worker cron、合规删除骨架、analytics、纯计算函数、UI token。
- **需重构（PARTIALLY）**：webhook（加去重表 + 分层）、导航（五入口）、Data Health（→Integrations Health）。
- **软废弃保留**：Suppliers、Purchase Plans、Product Copy。
- **NOT IMPLEMENTED（V2 全新）**：`Shop` 租户模型、`Automation`/`AutomationVersion`、`Trigger Registry`、`Condition Evaluator`、`Action Registry`/`Action Executor`、**执行风险分级与人工确认（`riskLevel`/`AWAITING_CONFIRMATION`，PRD §20.1）**、`WebhookDelivery` 去重表、`ExecutionLog`/`ExecutionStep`、`Integration`、`ScheduledJob`、DSL 校验/编译、Loop Protection、SSRF 防护、Email/Custom Webhook 发送运行时。

---

## 2. V1.x → V2.0 模块迁移矩阵

| V1.x 模块 | 状态 | V2.0 处置 | 数据表 | 页面/路由 | 关键风险 |
|---|---|---|---|---|---|
| Shopify OAuth | IMP | 完全保留 | `Session`（不改） | `auth.*` | 不得触发重授权 |
| Shopify API Client | IMP | 抽象为 API Gateway | — | — | 需写操作 requestSource 封装 |
| Webhook | PART | 重构为 Event Ingestion Hub | 新增 `WebhookDelivery` | `webhooks.*` 保留壳 | orders/* 审批墙（R1） |
| Worker | IMP | 升级为 Execution Engine | 复用 `DataSyncJob` 模式 + 新增执行 job | — | 崩溃恢复/租约（沿用现有） |
| Inventory Snapshot | IMP | 降级可选数据服务 | 保留 | 入口收敛 | 无 |
| Inventory Calculation | IMP | 保留纯函数 | — | — | 无 |
| Recommendation | IMP | 降为模板/Action | 保留 | 入口收敛 | 无 |
| Data Health | IMP | 转 Integrations Health | 保留 | 重命名页 | 无 |
| RecommendationAudit | IMP | 幂等范式沉淀进 Execution Log | 保留（旧），新增 `ExecutionLog` | — | requestKey 模式沿用 |
| Suppliers | IMP | 隐藏入口，保留数据 | 保留 `Supplier`/`VariantSupplier` | 隐藏 `.suppliers` | 清理策略 §5 |
| Purchase Plans | IMP | 隐藏入口，保留数据 | 保留 `PurchasePlan*` | 隐藏 `.purchase-plans` | 清理策略 §5 |
| Product Copy | 停用 | 继续停用 | 保留 `ProductDraft` | 隐藏 `.copy` | 无 |
| Analytics | IMP | 保留并扩展自动化指标 | 保留 `AnalyticsEvent` | `.metrics` | 新增事件类型 |
| Compliance Delete | IMP | 扩展删除清单 | 覆盖全部新表 | — | 漏删=合规事故 |

---

## 3. 数据库迁移方案

### 3.1 迁移原则

- **只加不改不删**：一次 additive migration 建全部 V2 新表；旧表列语义不动。
- **租户键统一**：V2 新表以 `shopId`（FK → `Shop.id`）做隔离；`Shop.shop`（域名）为业务唯一键。**过渡**：V2 早期可与旧 `shop` 字符串并存，但新表索引一律走 `shopId`，避免 §1.1 的"Session.shop 不唯一"陷阱。
- **回滚策略**：全部为新增表 + 新增列，Prisma 迁移可安全 down（DROP 新表），旧数据零影响。建议采用"前向兼容 + 双读"而非破坏性 down。

### 3.2 V2 新增模型（与 PRD §26/§27 一致）

> 完整 Prisma Draft 见 `docs/PRD-V2.0.md` 第 27 节；此处只给迁移视角。

| 新表 | 用途 | 关键约束/索引 | 迁移注意 |
|---|---|---|---|
| `Shop` | 租户主体 | `id` PK；`shop`（域名）`@unique`；`timezone`、`currencyCode`、`primaryCountry`、`isActive` | 从现有 `distinct Session(isOnline:false).shop` **回填**：每个 offline 店铺建一行 Shop |
| `Automation` | 自动化实例 | `shopId` FK；`status`（active/paused/deleted）；`definitionVersionId` | Cascade：Shop 删→Automation 删 |
| `AutomationVersion` | DSL 版本快照 | `automationId` FK；`version`；`definition Json`；`@@unique([automationId, version])` | 规则改动新增版本，旧执行记录引用旧版本（确定性回放） |
| `AutomationTrigger` | 触发器登记（可选规范化） | `automationId` FK；`type`；`config Json` | 若坚持 DSL 纯 JSON 存储，此表可省（委托 9 末：不过度设计）；PRD 中作为可选 |
| `WebhookDelivery` | 幂等去重 | `id` PK；`shop`/`shopId`；`webhookId`（X-Shopify-Webhook-Id）；`topic`；`receivedAt`；`@@unique([webhookId])`；索引 `receivedAt`（24h TTL） | **核心新表**；沿用 `RecommendationAudit.requestKey @unique` 撞索引即拒绝的已验证范式 |
| `ExecutionLog` | 一次自动化执行 | `shopId`；`automationId`；`automationVersion`；`triggerType`；`entityRef`；`status`(SUCCESS/FAILED/PARTIAL_SUCCESS/SKIPPED/RETRYING)；`parentExecutionId`（重试父子）；`payload Json`(脱敏)；`dedupeKey @unique` | 父子里程碑；重试新建行不改原行（委托 7.5） |
| `ExecutionStep` | 每步 Action 结果 | `executionId` FK Cascade；`order`；`actionId`；`status`（含 `AWAITING_CONFIRMATION` 待确认态，PRD §20.1）；`result Json`；`errorText`（可读） | 保留步骤独立结果=Partial Success 基础；高风险步骤默认待确认 |
| `Integration` | 外部连接 | `shopId`；`kind`（SHOPIFY/EMAIL/CUSTOM_WEBHOOK）；`config Json`；`secretsEncrypted`；`status`；`lastTestedAt` | 密钥密文列，明文不入库/日志（委托 7.6） |
| `ScheduledJob` | 定时触发（Daily Schedule 等） | `shopId`；`automationId`；`cronExpr`/`dailyTime`；`timezone`；`lastRunAt`；`nextRunAt`；`activeKey @unique?` | 复用 `DataSyncJob.activeKey` 锁思路防并发重跑 |

### 3.3 直接保留（无需迁移）旧表

`Session`、`InventorySettings`、`Location`、`InventorySnapshot`、`InventoryEvent`、`DataSyncJob`、`SalesDaily`、`Supplier`、`VariantSupplier`、`PurchasePlan`、`PurchasePlanLine`、`ReorderRecommendation`、`RecommendationAudit`、`AnalyticsEvent`、`AdviceFeedback`、`ProductDraft`（共 16 张，全保留）。

### 3.4 兼容与共存

- **新旧并行**：V1 补货页面与 V2 自动化页面共存期，同一 `Shop` 既可跑旧 cron 同步、又可跑新 automation。两套 job 用不同 `jobType`/`activeKey` 命名空间隔离，互不抢锁。
- **Session → Shop**：不改动 Session；`Shop` 通过 offline token 店铺域名建立，登录后由 loader 解析 `shop` 域名 → 查/建 `Shop`。

---

## 4. 关键风险（迁移视角，详见 V2-OPEN-QUESTIONS.md）

- **R1（阻塞级）· Protected Customer Data 审批墙**：`orders/create`、`orders/paid`、`orders/cancelled`、`customers/create` 均属受保护客户数据主题，**未通过 Partners 后台 Customer data protection 审批前无法订阅**（`shopify.app.toml:31-33` 实测：未审批会导致 `shopify app dev` 启动失败）。**10 大模板中 6 个、P0 全部 4 个 trigger 依赖 order/customer webhook。** → V2.0 MVP 的**第一前置依赖是拿到该审批**；未获批前首发只能交付 Products/Inventory 类 trigger。同时 `read_customers` scope 目前未申请（`shopify.app.toml:14`），customers/create 需要它。
- **R2 · read_all_orders 历史窗口**：`read_orders` 默认仅回看约 60 天订单（V1 已踩点，待决策项 #2）。涉及历史/未发货扫描的模板（#10 Unfulfilled 3-Day、#9 Backorder）需要 `read_all_orders`（须与 `read_orders` 并用），同样依赖审批。
- **R3 · 新增写 scope**：V2 Action 需 `write_orders`（Add/Remove Order Tag）、`write_customers`（Add Customer Tag）、`write_products`（Update Product Status）。当前 scopes 全只读，扩权是 App Store 审核项，需产品确认权限最小化边界。逐资源确切写 scope 文案 → 待验证（OQ）。
- **R4 · 合规删除清单遗漏**：新表未进 `SHOP_SCOPED_DELETES` = GDPR/shop:redact 漏删事故。属硬约束，实施时同 PR 覆盖。
- **R5 · Loop Protection 可靠性**：Shopify **不保证**把 mypi 自定义标记回传到后续 webhook，且**不保证 webhook 顺序**（官方 "doesn't guarantee ordering"）。基于"来源标识"的防循环只能降风险，须叠加去重表 + 最大级联深度 + 时间窗（详见 PRD §24）。

---

## 5. 软废弃模块的未来清理策略

| 模块 | 现在 | 观察期判据 | 清理动作（未来，需另行授权） |
|---|---|---|---|
| Suppliers / VariantSupplier | 隐藏入口、保留数据 | 连续 2 个版本 0 活跃店铺使用 | 先归档导出，再评估 DROP |
| Purchase Plans | 隐藏入口、保留数据 | 同上 | 同上 |
| Product Copy / ProductDraft | 已停用 | 保持停用 | 不重启则长期保留空表，不 DROP（红线 1） |

清理一律走"隐藏 → 只读导出 → 显式决策 → drop 迁移"，禁止直接删表。

---

## 6. 一致性锚点（供四文档交叉引用）

- 模块状态取值以 §1 为准。
- 新表清单以 §3.2 为准，PRD §27 Prisma Draft 必须逐表对应。
- trigger/action 可用性判定以 `V2-OPEN-QUESTIONS.md` 的 VERIFIED / 待验证 标记为准；未 VERIFIED 者不得进 `V2-MVP-ACCEPTANCE.md` 的 P0 用例。
- R1 审批墙在 PRD 风险清单、Open Questions、验收前置条件三处必须同时出现且口径一致。

# mypi V2.0 · Phase 1 研发任务清单（基础设施与数据模型）

> 基准：`docs/PRD-V2.0.md` v2.0-draft.2 §37 Phase 1 / §27 Schema / §23 Ingestion，`docs/V1-TO-V2-MIGRATION.md` §3。
> 用途：可直接交给 AI Coding Agent 逐条实施。每条任务含 目标 / 涉及文件 / 步骤 / 交付物 / 验收 / 依赖 / 风险。
> 边界：本 Phase **只打地基**，不含 Matcher / Condition Evaluator / Action Executor（属 Phase 2）。

---

## 0. 范围与前置约定

**Phase 1 交付**：V2 全量数据模型（additive 迁移）+ Shop 租户模型与回填 + Event Ingestion（HMAC/去重）+ Event Normalization + Worker 基础改造 + ExecutionLog/Step 落库骨架 + 风险分级执行骨架 + 合规删除扩展 + 测试门禁。

**Phase 1 不做**：自动化匹配/条件求值/动作执行/模板 UI/前端五导航（Phase 2/3）。Ingestion 收到事件后，Phase 1 仅落 `WebhookDelivery` 与标准化事件入队，不驱动执行（可用 flag 关闭下游）。

**红线（全程遵守）**：
- 不改旧表列语义、不 DROP 任何表；全部 additive migration（PRD/迁移红线）。
- 不动 OAuth：`client_id`、`redirect_urls`、`Session` 结构、scopes 不在本 Phase 变更。
- 模块路径规范：**纯逻辑放 `app/lib/*.ts`（可单测、不绑 db）**；**绑定 Prisma 的服务放 `app/*.server.ts`**；复用现有 `db.server.ts` 单例。
- 复用而非重写：`adminGraphql`（写操作走它）、`shopify-throttle`、`DataSyncJob.activeKey` 锁范式 + `sync-job-ledger`/`sync-job-policy`、`RecommendationAudit.requestKey @unique` 幂等范式、worker 优雅退出/`installedShops`。
- 不虚构 API：涉及 orders/customers webhook 的联调若受 R1 审批阻塞，用**本地 mock 投递**验证，禁止为跑通而绕过审批。

**环境事实**：PostgreSQL（Supabase，`DATABASE_URL`）；已有 `prisma/migrations/`；Prisma client provider `prisma-client-js`。

---

## WP-A 数据模型与迁移

### P1-01 新增 V2 Prisma 模型
- 目标：把 PRD §27 的 8 张新表落进 schema。
- 涉及：`prisma/schema.prisma`。
- 步骤：
  1. 按 PRD §27 逐表添加 `Shop`/`Automation`/`AutomationVersion`/`WebhookDelivery`/`ExecutionLog`/`ExecutionStep`/`Integration`/`ScheduledJob`（`AutomationTrigger` 依 D-7 暂不建表，用 `AutomationVersion.definition` JSON 承载）。
  2. 关系与 Cascade 按 §26 十问实现：`Shop 1—N Automation 1—N ExecutionLog 1—N ExecutionStep`；`ExecutionLog.parentExecutionId` 自关联重试父子；`Automation↔AutomationVersion` 用命名 relation `AutomationVersions`（`currentVersionId` 可为 nullable，不建循环 FK）。
  3. 唯一约束：`Shop.shop`、`WebhookDelivery.webhookId`、`ExecutionLog.dedupeKey`、`AutomationVersion(automationId,version)`、`ExecutionStep(executionId,order)`、`ScheduledJob.activeKey`。
  4. 索引：`ExecutionLog(shopId,createdAt)`、`ExecutionLog(shopId,status,createdAt)`、`ExecutionLog(shopId,entityRef)`、`WebhookDelivery(receivedAt)`+`(shop,topic,receivedAt)`、`Automation(shopId,status)`。
  5. `ExecutionStep.status` 注释含 `AWAITING_CONFIRMATION`（§20.1/P6）。
- 交付物：schema diff + `prisma validate` 通过。
- 验收：`npx prisma validate` 无错；类型生成成功；无对旧表的破坏性改动（旧模型定义逐字不变）。
- 依赖：无。
- 风险：`currentVersionId`↔`AutomationVersion.automationId` 若互相加 FK 会成环 → **只在 Version 上加 FK，Automation.currentVersionId 存裸 id**。

### P1-02 生成并审阅 additive migration
- 目标：产出可 up/down 的迁移 SQL。
- 涉及：`prisma/migrations/<ts>_v2_automation_foundation/migration.sql`。
- 步骤：`prisma migrate dev --name v2_automation_foundation`（或针对远程 Supabase 用 `migrate diff` 生成后人工落盘）；确认 SQL **仅含 CREATE TABLE/INDEX，无 DROP/ALTER 旧表列**。
- 交付物：migration.sql + `migration_lock.toml` 不变。
- 验收：SQL 审阅仅新增；本地空库 migrate 成功；对既有 dev 库二次 migrate 无破坏。
- 依赖：P1-01。
- 风险：远程 Prisma 交互式事务 5s 预算（P2028，已有记忆）→ 迁移走 CLI 非运行时；pooler 模式下 migrate 需用**直连会话**端点。

### P1-03 回滚与兼容性脚本
- 目标：满足"迁移可回滚/恢复"（委托 §4-9）。
- 涉及：迁移文档注记 +（可选）`docs` 内运行手册片段。
- 步骤：确认 down 仅需 DROP 新表（无旧数据受影响）；记录"前向兼容 + 双读"为首选回滚策略（不 down，仅停新逻辑）。
- 交付物：回滚说明写入本文件 §9。
- 验收：说明覆盖"新表可安全丢弃、旧表零改动"。
- 依赖：P1-02。

---

## WP-B Shop 租户模型与回填

### P1-04 `shop-directory.server.ts`：解析/确保 Shop
- 目标：把"域名字符串"升级为 `Shop` 租户行的唯一入口。
- 涉及：新增 `app/shop-directory.server.ts`。
- 步骤：
  1. `ensureShop(shopDomain, { timezone?, currencyCode?, primaryCountry? }): Promise<Shop>` — upsert by `shop` 域名。
  2. `resolveShopFromSession(shopDomain)`：读取会话域名 → 返回/创建 Shop；**绝不假设 `Session.shop` 唯一**（迁移 §1.1）。
  3. 时区/币种来源：优先 `InventorySettings.timezone`/`currencyCode`（迁移 §1.5），缺省 UTC/USD。
- 交付物：模块 + 类型。
- 验收：同域名并发调用返回同一 Shop 行（幂等）。
- 依赖：P1-01。
- 风险：ensureShop 并发插入撞 `Shop.shop @unique` → 用 upsert / onConflict 忽略。

### P1-05 Shop 一次性回填脚本
- 目标：从既有 offline session 建 Shop 行（迁移 §3.2）。
- 涉及：`worker/` 下一次性脚本或 `scripts/backfill-shops.ts`。
- 步骤：`session.findMany({where:{isOnline:false},distinct:["shop"]})`（复用 `worker/index.ts` 的 `installedShops` 查询）→ 逐个 `ensureShop`，带 `InventorySettings` 时区/币种；输出回填计数与跳过的已存在项。
- 交付物：可重复执行（幂等）的 backfill 入口。
- 验收：跑两次结果一致、无重复 Shop；旧数据/Session 未改动。
- 依赖：P1-01、P1-04。
- 风险：回填不得触发重授权（只读 session，不改 accessToken/expires）。

---

## WP-C Event Ingestion（HMAC + 去重）

### P1-06 `webhook-delivery` 去重服务（复用 requestKey 范式）
- 目标：`WebhookDelivery` 落库式幂等（非进程内 Map）。
- 涉及：新增 `app/lib/webhook-delivery.ts`（纯策略）+ `app/webhook-delivery.server.ts`（db 绑定）。
- 步骤：
  1. `tryRecord(db, {shop, shopId?, webhookId, topic})` → `{accepted: boolean}`：`create` 撞 `webhookId @unique` 即返回 `accepted:false`（重复）。
  2. TTL 清理 `pruneOldDeliveries(before: Date)`：删 `receivedAt < now-24h`（默认 24h，可 env 覆盖）。
  3. 记录与后续入队**同事务或 outbox**（迁移 §1.3 PRD §23.2 崩溃安全）。
- 交付物：模块 + 单测（用 mock db 注入，参照 `tests/sync-job-ledger.test.ts`）。
- 验收：同 webhookId 二次调用被拒；并发两次仅一条成功。
- 依赖：P1-01。
- 风险：Prisma 远程库交互事务预算 → 事务保持短小，写投递 + 入队两语句内完成。

### P1-07 统一 webhook 接收壳 `ingestWebhook`
- 目标：现有各 `webhooks.*.tsx` 路由收敛到一个入库前置流程。
- 涉及：新增 `app/automation-ingest.server.ts`；改 `app/routes/webhooks.*.tsx` loader 调用它（保留路由，不改快速 200 行为）。
- 步骤（PRD §23.1）：
  1. **原始 body 验签**：确认库层 HMAC 已校验；路由内用 `request.clone()` 拿 raw body，不 `JSON.parse` 后重算。
  2. 头校验：`X-Shopify-Topic`、`X-Shopify-Webhook-Id`（缺失→拒绝并记日志）、`X-Shopify-Hmac-Sha256`；`X-Shopify-API-Version` 自测必带（已有记忆：本地探测 webhook 路由须带该头）。
  3. shop 域名与会话存在性校验，拒绝跨店/伪造。
  4. 调 P1-06 `tryRecord` → 重复则直接返回 200（不重复处理）。
  5. 通过则写标准化事件入执行队列（见 P1-09），**快速 200**，重活异步。
- 交付物：`ingestWebhook(input): Promise<{accepted:boolean, duplicate:boolean}>` + 路由接线。
- 验收：合法新投递 accepted+入队；重复 duplicate；缺 HMAC/webhookId 被拒；响应路径无同步 Mutation。
- 依赖：P1-06。
- 风险：orders/customers 路由尚未订阅（R1）→ 用 mock 请求头+body 测，不依赖真实审批。

### P1-08 TriggerNormalizer（纯函数）
- 目标：REST/GraphQL 两种 payload 形状 → 统一 StandardEvent。
- 涉及：新增 `app/lib/event-normalizer.ts`（**纯，无 db**）。
- 步骤：
  1. `normalizeEvent(topic, rawBody) → StandardEvent{ shopDomain, topic, entityType, entityId(GID), occurredAt, data, raw(脱敏) }`。
  2. 复用 `webhook-sync.server.ts` 的 `toGid`（数字/字符串 id → GID）作为 id 归一参考实现（抽到 lib 共享，不复制两份逻辑）。
  3. 覆盖 Phase 1 需落地 topic：`inventory_levels/update`（可先接）、`orders/create|paid|cancelled`、`customers/create`、`products/update`（后四类即使未订阅也先实现归一，mock 验证）。
  4. 解析失败：返回 `null` + 由调用方记日志，**不抛错**（避免 Shopify 反复重试坏 payload，沿用 V1 原则）。
- 交付物：模块 + 单测（各 topic 正常/畸形样本）。
- 验收：数字 id 与 GID id 都归一；缺关键字段返回 null 不抛。
- 依赖：P1-01。

---

## WP-D 执行队列与 Worker 基础改造

### P1-09 ExecutionQueue（复用 activeKey 锁范式）
- 目标：DB 持久队列，防并发重消费 + 崩溃可回收。
- 涉及：新增 `app/lib/execution-job-policy.ts`（纯，参照 `sync-job-policy.ts`）+ `app/execution-queue.server.ts`（db，参照 `sync-job-ledger.ts` + `sync-jobs.server.ts` 绑定层）。
- 步骤：
  1. 决定承载方式：**新增 `jobType="automation-execute"` 复用 `DataSyncJob`** 还是建独立队列表；Phase 1 倾向复用 `DataSyncJob`（activeKey=`shop:automation-execute:<deliveryId>`），避免再造锁（如实现中发现粒度不足再在 Phase 2 拆表，记录为技术债）。
  2. `enqueueStandardEvent(event)`：写 queued 记录（含 dedupeKey = deliveryId/事件指纹）。
  3. `claimNext(shop)` / `withExecutionJob(...)`：running→succeeded/failed 状态机；租约 `leaseCutoff` 回收超时 RUNNING（复用 `reapStaleRunningJobs` 思路）。
- 交付物：队列服务 + 纯策略单测。
- 验收：同 deliveryId 不重复入队；running 崩溃超租约被回收（对应 E2E 场景 G 的基建部分）。
- 依赖：P1-01、P1-08。
- 风险：与现有 cron 同步 job 抢 `activeKey` 命名空间 → 用不同 `jobType` 前缀隔离（迁移 §3.4）。

### P1-10 Worker 扫描循环接入 ingestion 队列
- 目标：worker 增加"消费待执行事件"的周期任务（Phase 1 只做认领+标记，执行动作留 Phase 2 空实现）。
- 涉及：`worker/index.ts`。
- 步骤：
  1. 新增 `WORKER_AUTOMATION_CRON`（默认每 1–5 分钟）；`validate` 表达式；`schedule(..., {noOverlap:true})`（沿用现有模式）。
  2. 循环体：对 `installedShops` 调 `claimNext` → Phase 1 先记录"已认领事件 + 标准化结果"到日志（executor 为 no-op stub，flag `AUTOMATION_EXECUTION_ENABLED=false` 默认关）。
  3. 启动补跑一次（沿用现有 `sweepSnapshots`/`sweepSales` 模式）。
  4. 停机接管复用现有 `shutdown()`，无需改动。
- 交付物：worker 新排程 + stub 消费。
- 验收：SIGTERM 优雅退出仍生效；新排程不重叠；无执行副作用（stub）。
- 依赖：P1-09。

### P1-11 投递 TTL 清理挂到 worker
- 目标：`WebhookDelivery` 24h 清理自动化。
- 涉及：`worker/index.ts`（每日或每小时任务）。
- 步骤：周期调 P1-06 `pruneOldDeliveries(now-24h)`；noOverlap。
- 交付物：清理排程。
- 验收：超期记录被删、窗口内保留。
- 依赖：P1-06。

---

## WP-E 执行记录骨架与风险分级落库

### P1-12 ExecutionLog / ExecutionStep 写入原语
- 目标：提供 Phase 2 引擎可用的日志/步骤落库函数（含状态机字段）。
- 涉及：新增 `app/execution-log.server.ts`。
- 步骤：
  1. `createExecutionLog({shopId, automationId, automationVersion, triggerType, entityRef, dedupeKey?, cascadeDepth, payload(脱敏), parentExecutionId?})`。
  2. `appendStep({executionId, order, actionId, status, result?, errorText?})`，status 支持 `AWAITING_CONFIRMATION`。
  3. `finalizeStatus(executionId)`：按步骤聚合出 SUCCESS/FAILED/PARTIAL_SUCCESS/SKIPPED（PRD §16）。
  4. `dedupeKey @unique` 防重复落账（复用 requestKey 范式）。
- 交付物：服务 + 单测（mock db）。
- 验收：父子重试关系可建；部分成功聚合正确；重复 dedupeKey 被拒。
- 依赖：P1-01。

### P1-13 风险分级常量与解析（纯函数）
- 目标：Action `riskLevel`→`confirmation` 派生规则可测、可被引擎调用。
- 涉及：新增 `app/lib/action-risk-policy.ts`（纯）。
- 步骤：
  1. 定义 `RiskLevel = "low"|"high"`；`Confirmation = "auto"|"required"`。
  2. `resolveConfirmation(actionId|riskLevel)`：low→auto，high→required，缺省→required（安全默认，PRD §20.1）。
  3. 常量表落地分级：Add/Remove Tags + Send Email/Webhook=low；Update Product Status=high；**不定义"改价/删单"Action**（PRD §8 非目标）。
- 交付物：纯策略 + 单测。
- 验收：未知 actionId 默认 required；表与 PRD §20.1 一致。
- 依赖：无（Phase 2 executor 会消费）。

### P1-14 DSL 校验骨架（JSON Schema）
- 目标：启用前能校验 DSL 结构（PRD §21.3/§21.4）。
- 涉及：新增 `app/lib/automation-dsl.ts`（纯）+ schema 常量。
- 步骤：
  1. 落 JSON Schema（§21.3，含 action `riskLevel`/`confirmation`、op 枚举、trigger type 枚举）。
  2. `validateDefinition(json) → {ok, errors[]}`：结构 + 枚举 + 一层 AND/OR；**字段白名单校验接口预留**（白名单数据 Phase 2 补）。
  3. 拒绝非法定义、不落半态。
- 交付物：校验器 + 单测（合法/非法样本，含 T1/T2/T3 三个 DSL 示例）。
- 验收：§21.2 三示例通过校验；越界 op/嵌套/未知字段被拒。
- 依赖：无。

---

## WP-F 合规与安全

### P1-15 扩展合规删除清单（R4 硬约束）
- 目标：新表纳入 `purgeShopBusinessData`。
- 涉及：`app/webhook-sync.server.ts`（`SHOP_SCOPED_DELETES`）。
- 步骤：追加 `shop`/`automation`/`automationVersion`(经 automation)/`webhookDelivery`/`executionLog`(带 step cascade)/`integration`/`scheduledJob` 的按 `shopId`（或 shop 域名）删除；**子表在父表前**；session 删除逻辑保持。注意 Shop 删除会 Cascade 全部子表，需按删除顺序列出以便日志计数正确。
- 交付物：更新后的清单。
- 验收：新增集成测试断言 uninstall/redact 后各 V2 新表该店数据为空（P1-19）。
- 依赖：P1-01。
- 风险：漏表 = GDPR 事故；务必与 §3.2 新表逐一对应。

### P1-16 Secret 存储原语（占位，Phase 3 填充）
- 目标：为 `Integration.secretsEncrypted` 提供加解密工具约定。
- 涉及：新增 `app/lib/crypto-box.ts`（纯/依赖 env key）。
- 步骤：AES-256-GCM encrypt/decrypt，密钥来自 env（**明文密钥不入库/日志**）；仅提供接口与单测，UI 在 Phase 3。
- 交付物：加解密工具 + 单测。
- 验收：往返一致；密文不含明文；key 缺失时报可读错误。
- 依赖：无。

---

## WP-G 测试与门禁

### P1-17 单元测试
- 覆盖纯函数模块：`event-normalizer`、`webhook-delivery`（mock db）、`execution-job-policy`、`action-risk-policy`、`automation-dsl`、`crypto-box`。
- 路径：`tests/*.test.ts`，vitest；纯函数目标 ≥90%（PRD §35，覆盖率非唯一指标）。
- 验收：全部绿；CI（`.github/workflows/ci.yml`）通过。

### P1-18 集成测试（可注入 db，参照 `tests/sync-job-ledger.db.test.ts`）
- 覆盖：WebhookDelivery 唯一索引去重（含并发）、执行队列认领/租约回收、ExecutionLog/Step 落库与部分成功聚合、DSL→无（属纯函数）。
- 验收：重复投递被拒、崩溃任务被回收、dedupeKey 冲突被拒。

### P1-19 合规删除集成测试
- 场景：造 Shop+Automation+Log+Step+Delivery+Integration+ScheduledJob 数据 → 跑 `purgeShopBusinessData(shop)` → 断言全部按店清空、他店数据不受影响。
- 验收：R4 满足；跨店隔离（多租户雏形，对应 E2E 场景 F 的 DB 层）。

---

## 8. 任务依赖与执行顺序

```
P1-01(schema) ─→ P1-02(migrate) ─→ P1-03(rollback note)
   │
   ├─→ P1-04(shop-directory) ─→ P1-05(backfill shops)
   ├─→ P1-06(webhook-delivery) ─→ P1-07(ingest 壳) ─→ P1-09(exec queue) ─→ P1-10(worker 消费) ─→ P1-11(TTL 清理)
   │        └→ P1-08(normalizer 纯) ─┘
   ├─→ P1-12(exec log/step 原语)
   ├─→ P1-15(合规删除扩展) ─→ P1-19(删除测试)
   └─ 独立可并行：P1-13(risk policy)、P1-14(DSL 校验)、P1-16(crypto-box)
测试：P1-17(unit，随各纯模块)、P1-18(集成，随 P1-06/09/12)
```
关键路径：P1-01 → P1-02 → P1-06 → P1-09 → P1-10。P1-13/14/16 可与主干并行，供 Phase 2 直接取用。

---

## 9. Phase 1 完成定义（DoD）

- [ ] `prisma validate` + additive migration 成功，SQL 仅新增、旧表零改动，可 down（DROP 新表）。
- [ ] `Shop` 回填脚本幂等跑通，商家零重授权（回归安装流三段重定向链）。
- [ ] `ingestWebhook` + `WebhookDelivery` 去重通过单测/集成测（含并发重复被拒）。
- [ ] `normalizeEvent` 覆盖 Phase 1 topic 样本，畸形 payload 返回 null 不抛错。
- [ ] 执行队列认领/租约回收 + worker stub 消费跑通，SIGTERM 优雅退出不回归。
- [ ] `ExecutionLog/Step`（含 `AWAITING_CONFIRMATION`）写入与部分成功聚合通过测试。
- [ ] 风险分级常量、DSL 校验、crypto-box 就绪并被单测覆盖，与 PRD §20.1/§21 一致。
- [ ] `purgeShopBusinessData` 覆盖全部 V2 新表并通过合规删除集成测试（R4）。
- [ ] CI 全绿。

**回滚策略**：优先"前向兼容 + 关 flag（`AUTOMATION_EXECUTION_ENABLED=false`）停新逻辑"；确需回退仅 DROP V2 新表，旧表与 Session 不受影响。

**遗留到 Phase 2**：Matcher、Condition Evaluator 白名单数据、Action Registry/Executor 真实执行、确认门交互落地、orders/customers 真实订阅联调（依赖 R1 审批 + R3/D-2 扩权）。

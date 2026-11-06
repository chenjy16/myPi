# mypi V2.0 · Phase 4 研发任务清单（质量、权限审核、隐私合规、生产发布）

> 基准：`docs/PRD-V2.0.md` v2.0-draft.2 §37 Phase 4；`docs/V2-MVP-ACCEPTANCE.md`（发布判定）；`docs/release-runbook.md`（三环境/迁移/回滚/健康/备份）；`docs/V2-OPEN-QUESTIONS.md`（B-1 审批墙、B-2 写 scope）。
> 前置：**Phase 1–3 完成**；本 Phase 多数上线项**硬依赖外部审批**（R1 Protected Customer Data、R3/D-2 写 scope）。
> 用途：可直接交给 AI Coding Agent / 运营逐条执行。每条含 目标 / 涉及文件 / 步骤 / 交付物 / 验收 / 依赖 / 风险。
> 边界：把前三 Phase 的引擎/界面变成**可上架、可运维、可回滚、合规**的生产系统。

---

## 0. 范围与前置约定

**Phase 4 交付**：全量 E2E（真实联调）与门禁、多租户隔离验证、Shopify 权限审核与 App Store 合规、隐私/GDPR 落地、漏投对账、生产部署链路与备份、监控告警、性能负载、灰度发布与文档。

**外部阻塞（诚实，不可代码绕过）**：
- **B-1 / R1**：`orders/*`、`customers/*` 属 Protected Customer Data，需在 Shopify Partners 提交并通过数据访问审批才能订阅；未过审批前 `shopify app dev` 会因订阅失败中断（既有陷阱记忆）。→ 订单/客户类模板的真实联调（P4-01）与上架（P4-05）以此为闸门；**无审批墙项（T4 Low Stock + 引擎/基建）可先行发布**。
- **B-2 / R3 / D-2**：打标/改状态需**写 scope**（`write_orders`/`write_products`/`write_customers`）。加写 scope **必然触发存量商家重新授权**——这与迁移"零重授权"红线**不冲突**（零重授权针对 additive 迁移本身；扩权是产品决策的既定代价），须在 P4-06 里规划灰度与商家沟通，不假装可免。

**生产事实（来自 runbook，务必沿用）**：web 容器执行 `prisma migrate deploy`、worker 只 `generate` 不迁移；`/health` 契约 `database:"up"` + `APP_VERSION`，DB 断连返回 503 供编排摘流量；worker 有 `noOverlap`+任务锁+租约回收+SIGTERM 优雅退出；DB 唯一持久状态、Shopify 侧权威可重同步；备份 = Supabase PITR（主）+ `pg_dump` 日备（细粒度），产物含 offline token 属敏感数据**只放私有加密存储、不入 git/日志**；迁移只向前无自动回滚，回滚=指回旧镜像 tag + 前向兼容（新列 nullable）。CI 门禁：`tsc --noEmit`、`npm run lint`、`prisma generate && validate`、`npm run build`、`migrate deploy` + `npm test` + `npm run test:integration`（Node 22 / npm 一次性跑 DB 测，其余自跳）。

**红线**：最小权限（每 scope 有正当性说明）；日志/密钥/PII 脱敏；跨店强隔离；不可逆操作（删数据/回滚/扩权）先备份再动、生产不当试验场。

---

## WP-A 全量测试与质量门禁

### P4-01 E2E A–H 真实联调
- 目标：审批到位后，把前三 Phase 的 mock 验证换成真实事件。
- 涉及：`docs/beta-e2e-checklist.md` 扩充；测试店。
- 步骤：审批+扩权落地后，在真实 dev/Beta 店订阅 `orders/create|cancelled`、`customers/create`、`inventory_levels/update`；逐条跑 A（打标成功）/B（条件不满足跳过）/C（部分成功+仅重试失败步）/D（取消订单通知）/E（级联超限被防循环拦）/F（多租户隔离）/G（worker 崩溃恢复）/H（高风险确认前零 Mutation）。首发 5 模板 T1/T2/T4/T5/T7 各至少一次真实端到端。
- 交付物：E2E 记录（含截图/日志，落 `ui-forensics/` 或测试店导出）。
- 验收：`V2-MVP-ACCEPTANCE.md` §1 场景 A–H 全通过（真实触发，非 mock）。
- 依赖：P4-05、P4-06、P4-07、P2-21、P3-21。
- 风险：审批未过则本项部分阻塞 → 无审批项（T4/E/G/H）先验，订单/客户项标注"待审批"。

### P4-02 回归 V1 + 覆盖率与 CI 门禁
- 目标：additive 改造不伤补货主链路，测试门槛达标。
- 涉及：`.github/workflows/ci.yml`、`tests/*`。
- 步骤：
  1. 回归：登录→Sync→建议→Accept(reason)→生成计划→导出 CSV 全绿（runbook §2.5 上线验证链）。
  2. 门禁：CI 已含 tsc/lint/prisma/build/test/integration；补 V2 关键模块纳入 `MYPI_DB_INTEGRATION` 门下的 DB 集成（P1-18/19、P2-20、P4-04）。
  3. 覆盖率：纯函数（evaluator/loop/retry/risk-policy/ssrf/compiler/normalizer）≥90%（PRD §35，覆盖率非唯一指标）。
- 交付物：CI 绿 + 覆盖率报告。
- 验收：V1 与 V2 测试均通过；无 flaky；Node 22/24 × npm/yarn/pnpm 矩阵不炸。
- 依赖：前三 Phase 全部。

---

## WP-B 多租户与数据隔离

### P4-03 shop 隔离审计与防护
- 目标：每个 V2 读写以 `shopId`/`shop` 为硬边界。
- 涉及：`app/automations.server.ts`、`app/activity.server.ts`、`app/integrations.server.ts`、`app/automation-matcher.server.ts`、引擎各 server 模块。
- 步骤：静态审查所有 Prisma 查询/变更均带 `shop`/`shopId` where；抽公共守卫（如 `assertShopScope(shopId, row)`）在返回跨店数据前抛错；引擎认领/执行仅取本店自动化。
- 交付物：审计清单 + 守卫工具。
- 验收：无一处全表裸查；违反作用域被守卫拦。
- 依赖：P1-04、Phase 2/3 服务。

### P4-04 跨租户渗透测试
- 目标：主动验证隔离不可破。
- 涉及：`tests/`（集成）。
- 步骤：构造 A 店会话请求 B 店 automation/execution/integration（改 id）→ 断言 404/403 或空；改 body 中 shopDomain/伪造 webhook 头 → 被 HMAC/作用域拒。
- 交付物：渗透测试用例。
- 验收：所有跨店访问失败（对应 E2E 场景 F 强化）。
- 依赖：P4-03。

---

## WP-C Shopify 权限审核与 App Store 合规

### P4-05 Protected Customer Data 审批（B-1）
- 目标：拿到订单/客户数据访问权以订阅 protected webhook。
- 涉及：Shopify Partners Dashboard；`shopify.app.toml`（webhooks 项）。
- 步骤：提交数据访问申请（说明用途：自动化打标/通知/分类，最小字段集）→ 等待审批 → 在测试店 `shopify app deploy` 后确认 `orders/create|paid|cancelled`、`customers/create` 订阅成功、`shopify app dev` 不再因 protected 订阅中断。
- 交付物：审批通过凭证 + 订阅成功日志。
- 验收：protected topic 可收真实投递；未过前 `app.toml` 保持注释降级（既有做法）。
- 依赖：外部审批。
- 风险：**不可代码绕过**；这是首发订单类模板的上架前置，周期不受团队控制 → 尽早提交（可与 Phase 1 并行申请）。

### P4-06 写 scope 扩权与存量商家重授权计划（B-2/D-2）
- 目标：为 tags/状态动作申请写权限并处理 re-consent。
- 涉及：`shopify.app.toml` `scopes`、`.env`（`SCOPES`）、App Store 权限说明。
- 步骤：
  1. 逐动作映射最小写 scope：`tags.add/remove`(order/customer/product) → `write_orders`/`write_customers`/`write_products`；`product.updateStatus` → `write_products`；在 dev store 实测确切 scope 文案（OQ-2 待验证项在此闭环）。
  2. 扩 scope ⇒ 存量 offline session scope 不足：设计应用内提示引导商家重新授权（App Bridge 跳转 `authPathPrefix`），并说明"未重授权前相关自动化不运行"。
  3. 记录：扩权是既定产品代价，不追求"零重授权"（那仅对 DB 迁移成立）。
- 交付物：更新后的 `scopes` + 重授权引导 + 权限正当性文案。
- 验收：扩权后真实店可成功 `tagsAdd`；未授权商家得到清晰状态而非静默失败。
- 依赖：P4-05（同批改 toml）、OQ-2。
- 风险：改 `client_id`/redirect 才是重授权雷区，本项只加 scope，`redirect_urls=/auth/callback` 不动（迁移红线）。

### P4-07 `shopify.app.toml` 正式订阅补齐与校验
- 目标：webhook/重定向/api_version 配置就绪且经 CLI 校验。
- 涉及：`shopify.app.toml`。
- 步骤：审批通过后恢复被注释的 orders/customers `webhooks` 订阅项、补 `products/update`、保留 `inventory_levels/update`；确认 `redirect_urls`、`auth.return_url`、`webhooks.api_version` 一致；`shopify app config link` + `npm run shopify app info`/validate（走 use-shopify-cli 主题预检 config）。
- 交付物：校验通过的 toml。
- 验收：`shopify app deploy` 无 webhook 注册错误；`prisma`/config 一致。
- 依赖：P4-05、P4-06。

### P4-08 App Store 提交前合规预检
- 目标：官方审核前自查（用 shopify-app-store-review 能力）。
- 涉及：全代码库。
- 步骤：跑预提交检查——嵌入会话/离线 token 处理、卸载即删数据、隐私与数据用途披露、最小权限说明、无违规外呼、错误可读不泄栈、功能与描述一致；产出整改项并闭环。
- 交付物：预检报告 + 整改。
- 验收：无高危项遗留；准备可提交。
- 依赖：P4-05~07、P4-12。

---

## WP-D 隐私合规（GDPR / CCPA）

### P4-09 合规删除/请求 webhook 覆盖 V2 表
- 目标：`customers/data_request`、`customers/redact`、`shop/redact` 对 V2 数据生效。
- 涉及：`app/routes/webhooks.customers.data_request.tsx`、`.redact.tsx`、`app/routes/webhooks.shop.redact.tsx`、`app/webhook-sync.server.ts`（`SHOP_SCOPED_DELETES`，P1-15 已扩）。
- 步骤：data_request→导出该客户相关 ExecutionLog/payload（脱敏后）回传；customers/redact→按 customerId 清/掩 `ExecutionStep`/`ExecutionLog` 关联客户数据；shop/redact→整店 `purgeShopBusinessData`（含全部 V2 表，子表先于父表）；确认响应符合 Shopify 时限与状态码。
- 交付物：更新后的合规处理 + 集成测试（P1-19 强化真实响应形状）。
- 验收：三类请求处理正确、按店清空、他店不受影响。
- 依赖：P1-15、P1-19。

### P4-10 数据保留与 TTL
- 目标：自动化数据有界留存。
- 涉及：`worker/index.ts`、P1-06 `pruneOldDeliveries`、新增 `app/lib/retention-policy.ts`。
- 步骤：`WebhookDelivery` TTL 24h（已实现，接 worker 定时 P1-11）；`ExecutionLog/ExecutionStep` 保留窗（如 180 天，含 PII 者更短或脱敏）可 env 配；worker 周期 prune；`payload raw` 存前脱敏（去客户敏感字段，仅留自动化判定所需）。
- 交付物：保留策略 + 清理排程。
- 验收：超期数据被清；脱敏后 payload 不含非必要 PII。
- 依赖：P1-11。

### P4-11 密钥与日志脱敏审计
- 目标：secret/PII 不入日志、不入 git。
- 涉及：`app/lib/logger.ts`、`app/lib/crypto-box.ts`、`app/integrations.server.ts`、备份脚本。
- 步骤：确认 `Integration.secretsEncrypted` 仅密文入库、页面掩码（P3-16）、解密只在执行瞬时；logger redaction 覆盖 secret/PII/token（新增键名黑名单）；备份产物含 offline token+secret → 私有加密存储红线（runbook §6.4）；错误上报（P4-20/21）不携带明文密钥。
- 交付物：脱敏审计 + logger 单测。
- 验收：日志/导出/上报无明文密钥或越界 PII。
- 依赖：P1-16、P3-16。

### P4-12 隐私政策与数据用途披露
- 目标：商家/买家知情。
- 涉及：App Store listing 文案、`docs/user-guide.md`、应用内 Integrations/Automation 说明。
- 步骤：写清访问哪些订单/客户字段、为何（自动化判定）、保留多久、如何删除；App Bridge 内可达隐私政策链接；扩权弹窗（P4-06）附用途说明。
- 交付物：披露文案。
- 验收：与 P4-08 预检的隐私项一致、可提交。
- 依赖：P4-05、P4-06。

---

## WP-E 可靠性（漏投对账与队列生产化）

### P4-13 Webhook 漏投对账（reconciliation）
- 目标：官方明示 webhook 可漏投/乱序（VERIFIED）→ 周期补齐。
- 涉及：新增 `worker` 定时 `reconcile` 任务（复用 `unauthenticated.admin` + `adminGraphql` 读 + `installedShops`）；`app/lib/reconcile-policy.ts`（纯）。
- 步骤：按店周期（如每 30 分钟）以 Admin API 拉取时间窗内 `orders`/`inventory` 变更，与 `WebhookDelivery`/`ExecutionLog` 比对，对"应触发但未收到投递"的实体补投标准化事件入队；补投走同去重/防循环（幂等，不重复 Mutation）。
- 交付物：对账任务 + 单测/集成。
- 验收：人为丢弃一条投递 → 对账窗口内被补触发且不重复执行。
- 依赖：P1-08/09、P2-12、P2-13。
- 风险：对账是"防漏触发"的第二道防线，成本随店铺量上升 → 频率与窗口可配、游标增量。

### P4-14 队列/租约/优雅退出生产验证
- 目标：automation 队列在真实 worker 生命周期下不丢不重。
- 涉及：`worker/index.ts`、`app/execution-queue.server.ts`。
- 步骤：多 worker 副本下确认同店同类 job 仅一份执行（activeKey 锁 + `noOverlap`）；容器 SIGTERM 优雅退出不打断飞行中写导致重复（UNKNOWN 回读校正 P2-17 生效）；崩溃遗留 RUNNING 由租约（`WORKER_JOB_LEASE_MINUTES`）回收。
- 交付物：生产场景演练记录。
- 验收：E2E G 在真实容器环境复现通过。
- 依赖：P1-10、P2-12/17。

---

## WP-F 生产部署与运维

### P4-15 部署链路与迁移时机
- 目标：V2 迁移与开关安全上线。
- 涉及：`Dockerfile`、compose、`docs/release-runbook.md`、`AUTOMATION_ENABLED`。
- 步骤：web 容器 `prisma migrate deploy` 前向兼容迁移（仅新表/nullable，符合 runbook §3 允许项）；worker 只 `generate` 不迁移；`AUTOMATION_ENABLED` 灰度打开；迁移前 `prisma migrate status` 无 pending、迁移后复查全 applied、抽查新表存在。
- 交付物：上线 runbook V2 章节。
- 验收：`/health` 200 且 `database:"up"`、版本一致；V1 链路回归（P4-02）。
- 依赖：P1-02、P4-19。

### P4-16 环境变量矩阵更新
- 目标：新运维参数有源可查。
- 涉及：`.env.example`、`docs/release-runbook.md` §1。
- 步骤：补 `AUTOMATION_ENABLED`、`WORKER_AUTOMATION_CRON`、`WEBHOOK_DELIVERY_TTL_HOURS`、`EXECUTION_RETENTION_DAYS`、`LOOP_MAX_CASCADE_DEPTH`、`LOOP_THROTTLE_*`、`RETRY_MAX_ATTEMPTS`、`RECONILE_INTERVAL`、email provider keys（`RESEND_API_KEY` 类，OQ-8 定）；沿用"配置改动保留旧值注释"规范。
- 交付物：更新后的 `.env.example` + 表。
- 验收：缺变量有可读默认/报错（仿 worker 启动 env 校验）。
- 依赖：P4-10、P4-13。

### P4-17 健康探针扩展
- 目标：`/health` 反映自动化子系统健康。
- 涉及：`app/routes/health.tsx`。
- 步骤：在不破坏 `database:"up"`+`APP_VERSION` 契约下，加 automation 维度（队列积压深度、最近执行成功率、worker 心跳时效、待确认堆积）；异常降级到状态字段而非 503（仅 DB 不可用才 503 摘流量）。
- 交付物：扩展探针。
- 验收：编排据此摘流量逻辑不变；运维可见队列态势。
- 依赖：P4-20。

### P4-18 备份/恢复覆盖 V2 表 + 演练
- 目标：V2 数据纳入灾备。
- 涉及：runbook §6 对账 SQL、scratch 恢复流程。
- 步骤：把 `Shop`/`Automation`/`AutomationVersion`/`ExecutionLog`/`WebhookDelivery`/`Integration`/`ScheduledJob` 补进 §6.3 行数对账 SQL；`pg_dump`/PITR 演练恢复 V2 表完整性；**注意** `Integration.secretsEncrypted` 密文入备份（密钥在 env，备份不含明文，符合红线）。
- 交付物：更新对账 SQL + 一次 scratch 恢复校验记录。
- 验收：恢复后无缺表/量级塌陷；迁移台账对齐。
- 依赖：P1-02。

### P4-19 Staging 环境开通与迁移演练
- 目标：真实镜像/OAuth/迁移首验不在生产做（runbook §1"尚未开通"）。
- 涉及：独立 dev store（`shopify.app.<handle>.toml` 变体）+ 独立 Supabase project。
- 步骤：按 §1 表开独立 store+DB；跑 `docker build`+`docker-start`/`docker-worker`；完整 OAuth 流 + 迁移演练 + V2 五导航冒烟 + P4-01 部分场景；本地网络陷阱（P1001 代理劫持）在服务器/CI 网络不复现。
- 交付物：Staging 就绪 + 演练报告。
- 验收：Staging 全链路通过才进 Production。
- 依赖：P4-07。

---

## WP-G 监控与告警

### P4-20 自动化指标与埋点
- 目标：核心 SLO 可观测。
- 涉及：`app/analytics.server.ts`（`trackEvent`）、`app/lib/logger.ts`（结构化、脱敏）。
- 步骤：埋点/日志维度：`automation_created/enabled/paused/deleted`、`execution_started/skipped/succeeded/failed/partial/awaiting_confirmation/loop_blocked/retried`、step 时延分位、队列时延、webhook 投递成功/去重命中/失败、对账补投数、邮件/出站 webhook 成功率、重授权转化。
- 交付物：指标字典 + 采集点。
- 验收：P4-17 探针与 P4-21 告警有数据源；无 PII/密钥入指标。
- 依赖：P4-11。

### P4-21 告警规则
- 目标：异常及时到人。
- 涉及：编排/监控平台（沿用现有可及渠道，如 Cloudflare/邮件/自建 webhook 通知）。
- 步骤：阈值——执行失败率/部分成功率突增、`AWAITING_CONFIRMATION` 超 SLA（如 >24h）、队列积压超水位、worker 心跳缺失、webhook 5xx/漏投（对账缺口）、写 API 限流频繁；区分**运营告警**（内部）与**商家可见状态**（不刷屏）。
- 交付物：告警配置 + 值班说明。
- 验收：注入故障可触发对应告警（演练）。
- 依赖：P4-20。

### P4-22 可观测查询手册与排障指引
- 目标：出事能查。
- 涉及：`docs/server-operations-guide.md`。
- 步骤：给关键 SLO 的 SQL/日志查询样例（按店排障、追踪某事件从 ingest→execution→steps、定位 loop-blocked 原因、对账缺口排查）；常见故障对应 runbook。
- 交付物：运维手册 V2 章节。
- 验收：任一执行可凭 executionId/webhookId 全链路追溯。
- 依赖：P4-20、P4-21。

---

## WP-H 性能、灰度与发布

### P4-23 性能 / 负载 / 索引
- 目标：峰值与多店规模稳定。
- 涉及：`app/lib/admin-graphql.server.ts`（throttle）、DB 索引、`app/automation-matcher.server.ts`、连接池（`app/lib/db-pool-url.ts`）。
- 步骤：压测 N 店 × M 事件/分钟：ingest 快速 200 不被执行阻塞、队列不丢、执行时延可接受、连接池不耗尽（session pooler 预算 vs web+worker 并发，避免 P2028/lease 冲突）；审阅并命中新表索引（`ExecutionLog(shopId,status,createdAt)` 等）、Activity Logs 游标分页稳定；写操作退避封顶 5s 生效。
- 交付物：压测报告 + 索引/查询审阅。
- 验收：目标吞吐下无积压失控、无池耗尽、P95 时延达标。
- 依赖：P4-14、P3-06。

### P4-24 灰度发布、发布检查清单与文档
- 目标：可控上线、可回滚、商家可自助。
- 涉及：`AUTOMATION_ENABLED`、`docs/release-runbook.md` §4、`V2-MVP-ACCEPTANCE.md` §6、`docs/user-guide.md`、`docs/architecture-and-deployment.md`。
- 步骤：
  1. 灰度：内部店 → 试点商家 → 全量；**先发无审批墙项**（T4 + 引擎 + 基建 + 五导航），订单/客户类待 P4-05/06 落地再放量。
  2. 回滚预案：异常先关 `AUTOMATION_ENABLED` 停新逻辑（前向兼容、数据保留），确需回退仅 DROP V2 新表（P1-03），旧表/session 不动。
  3. 发布判定：逐条过 `V2-MVP-ACCEPTANCE.md` §6（含 G1 审批/G2 扩权/G3 零重授权门，及"无审批可先发 T4+引擎"的分级发布口径）。
  4. 文档：用户指南补五导航/模板/确认与重试流；架构与运维文档补 V2 自动化子系统。
  5. 单发布 = 单一内聚提交（既有 Git 惯例）。
- 交付物：发布记录 + 更新文档。
- 验收：`V2-MVP-ACCEPTANCE.md` 全项达成或明确标注外部阻塞；商家可按指南自助启用。
- 依赖：本 Phase 其余全部。

---

## 9. 依赖与执行顺序

```
尽早并行申请：P4-05(审批) ‖ P4-06(写scope研究/OQ-2)
Phase1-3 完成 → P4-02(回归/门禁) → P4-01(E2E 真实，gate on P4-05/06/07)
P4-03 → P4-04(隔离/渗透)
P4-05 + P4-06 → P4-07(toml) → P4-19(staging) → P4-08(审核预检) → P4-24(发布)
合规：P4-09 → P4-10(TTL) ; P4-11(secrets/logs) → P4-12(披露) ; P4-18(备份)
可靠性：P4-13(对账) ‖ P4-14(队列生产)
运维：P4-15(部署) → P4-16(env) → P4-20(指标) → P4-17(health)/P4-21(告警) → P4-22(手册)
性能：P4-23 于 P4-14/P3-06 后
```
关键路径：**P4-05/06/07（外部审批+扩权+配置）→ P4-19(Staging) → P4-01(真实E2E) → P4-24(发布)**。审批周期不可控，须最早启动；无审批项（T4/引擎/基建/合规/监控）全程可并行推进，构成"先发"能力。

---

## 10. Phase 4 完成定义（DoD）

- [ ] E2E A–H 在真实事件下通过（订单/客户类以审批+扩权为前提；若审批未过，无审批项全部真实通过、订单类明确标注"待外部审批"，不伪造）。
- [ ] 多租户强隔离经静态审计 + 跨店渗透测试双验证（场景 F）。
- [ ] Protected Customer Data 审批通过、写 scope 扩权落地、`shopify.app.toml` 正式订阅经 CLI 校验、App Store 预检无高危遗留。
- [ ] GDPR/CCPA 三类合规请求覆盖 V2 表并测试；数据保留/TTL/脱敏落地；密钥与日志无明文敏感数据；隐私披露与 listing 一致。
- [ ] 漏投对账（第二道防线）验证可补触发且不重复执行；队列/租约/优雅退出在真实容器验证（场景 G）。
- [ ] 生产链路就绪：迁移前向兼容且 `migrate status` 对齐、Staging 先行演练、`/health` 扩展不破契约、备份/恢复覆盖 V2 表并经 scratch 校验、env 矩阵有源可查。
- [ ] 指标/告警/运维手册成型，故障可按 executionId/webhookId 全链路追溯。
- [ ] 性能负载达标（目标吞吐无积压失控、无池耗尽、退避生效）；灰度发布 + 回滚预案 + 更新文档 + 单一内聚提交。
- [ ] `docs/V2-MVP-ACCEPTANCE.md` 发布检查清单逐条达成或明确外部阻塞项。

**路线图收口**：至此交付 PRD §3.1 的 **Stage 1 Automation Toolkit**（固定模板一键启用）。Stage 2 自由组合、Stage 3 平台生态为后续版本，不在 Phase 1–4 范围。

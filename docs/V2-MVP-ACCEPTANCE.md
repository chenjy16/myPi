# mypi V2.0 MVP 验收标准

> 项目代号：Shopify Automation Toolkit
> 用途：把 PRD §34 优先级、§35 测试策略、§36 E2E 场景落成**可执行、可判定**的验收清单，供 AI Coding Agent 与 QA 直接据此验收。
> 一致性：能力 VERIFIED / 待验证 / 阻塞以 `docs/V2-OPEN-QUESTIONS.md` 为准；模块状态/表名以 `docs/V1-TO-V2-MIGRATION.md` 为准；需求定义以 `docs/PRD-V2.0.md` 为准。

---

## 0. 验收前置条件（Gate）

发布 P0 订单/客户类自动化前，必须先解除以下阻塞（否则相应验收用例判定为 **CONDITIONAL / BLOCKED**，不得记为通过）：

- **G1 = B-1（OQ-1）**：Protected Customer Data 审批通过，`orders/create`、`orders/paid`、`orders/cancelled`、`customers/create` 可成功订阅并收到真实投递。
- **G2 = B-2（D-2/OQ-2）**：写 scope（write_orders / write_customers / write_products）+ read_customers 已扩并通过 App Store 权限审核。
- **G3（迁移红线）**：additive migration 在生产库成功，旧数据与 Session 完好，**商家零重授权**（回归安装流三段重定向链）。

不依赖 G1/G2 即可验收的部分（先行子集）：Event Ingestion 框架、去重表、Condition Evaluator、Execution Log/Retry、多租户隔离、Send Email、Inventory Low（T4，read_inventory 已具备）。

---

## 1. P0 验收标准（首发必须）

每项：验收断言 + 判定方式。标注 `[G]` 者依赖前置条件。

| ID | 功能 | 验收断言 | 判定 |
|---|---|---|---|
| P0-1 | OAuth 兼容 | 老商家升级后无需重授权，会话正常解析 shopId | 回归 + E2E F |
| P0-2 | Automation Center | 8 项指标按 PRD §13.1 口径正确聚合，Estimated Time Saved 用默认折算表 | Loader 单测 + UI 核对 |
| P0-3 | Templates | 模板卡字段齐全；Use Template 抽屉→校验→权限检查→预览→启用闭环 | E2E（模板启用流） |
| P0-4 | My Automations | Create/Edit/Pause/Resume/Delete/ViewLogs 全可用；Edit 建新 Version 不覆盖旧版 | 集成 + UI |
| P0-5 | Activity Logs | 筛选/详情/Payload（脱敏）/Condition Evaluation/Step/Retry 全可用 | E2E A/C/D |
| P0-6 | Order Created trigger `[G1]` | 收到 orders/create，标准化 → 匹配 → 执行 | E2E A |
| P0-7 | Order Paid trigger `[G1]` | 同上（orders/paid） | E2E C |
| P0-8 | Order Cancelled trigger `[G1]` | cancelReason 枚举可读并参与条件 | 集成 |
| P0-9 | Customer Created trigger `[G1+G2]` | customers/create 可用；company 判定按 OQ-3 结论 | 集成（条件性） |
| P0-10 | 基础 Conditions | 12 运算符 + AND/OR 一层，纯函数，命中/未命中产出 clause 明细 | Unit ≥90% |
| P0-11 | Add Tags `[G2]` | tagsAdd 成功且幂等（重复不产生副作用） | E2E A |
| P0-12 | Remove Tags `[G2]` | tagsRemove 幂等，不存在则 no-op 成功 | 集成 |
| P0-13 | Send Email | 经 Integration 发送成功；失败标步骤 FAILED 不 crash | E2E C |
| P0-14 | Webhook 幂等 | 同 X-Shopify-Webhook-Id 只处理一次（唯一索引） | E2E D |
| P0-15 | Execution Log | 每次执行落 Log+Step，状态机 SUCCESS/FAILED/PARTIAL/SKIPPED/RETRYING 正确迁移 | 集成 |
| P0-16 | 失败重试 | 最大次数+指数退避；重试新建子记录（parentExecutionId），不改原记录 | 集成 |
| P0-17 | Pause/Resume | paused 后 Matcher 不再命中；resume 恢复 | 集成 |
| P0-18 | 多租户隔离 | 所有查询强制 shopId；跨店访问被拒；Action 用对店 token | E2E F |
| P0-19 | 风险分级执行（§20.1） | low 自动执行；high 步骤落 `AWAITING_CONFIRMATION` 不擅自 Mutation；确认后才执行 | 集成 + UI |
| P0-20 | 首发 5 核心模板 | 仅 **T1/T2/T4/T5/T7** 属首发；T4 无审批可先验，其余受 G1 阻塞标灰；T3/T6/T8/T9/T10 不入首发硬指标 | 模板启用流 + §32 |

### P0 必过 E2E（委托 §36）

每条含前置/输入/步骤/预期/DB 验证/前端验证：

**场景 A · 高价值订单自动打标** `[G1+G2]`
- 前置：T1 已启用、active。输入：orders/create，total_price=600，合法 HMAC+新 webhookId。
- 步骤：ingest→验签→normalize→dedup(pass)→match(T1)→evaluate(TRUE)→execute(tags.add customer+order)。
- 预期：两 tag 添加成功。DB：`WebhookDelivery` 1 行、`ExecutionLog.status=SUCCESS`、2 条 `ExecutionStep=SUCCESS`。前端：Activity Logs 显示 SUCCESS + 摘要。

**场景 B · 条件不匹配** `[G1]`
- 输入：total_price=100。预期：不执行 Action、无错误。DB：`ExecutionLog.status=SKIPPED`、`conditionResult.clauses[].pass=false`、无 Step 执行。前端：日志显示"条件未命中"。

**场景 C · 邮件发送失败（部分成功）** `[G1+G2]`
- 输入：T2 或含 email 的自动化，email 服务返回失败。预期：Add Tags 成功 / Email 失败 ⇒ `ExecutionLog.status=PARTIAL_SUCCESS`；用户可读错误（无堆栈）；可"仅重试失败步骤"（P1 能力，MVP 可先整任务重试）。DB：步骤状态分别 SUCCESS/FAILED；重试新建子记录。

**场景 D · 重复 Webhook** `[G1]`
- 输入：同一 X-Shopify-Webhook-Id 连投两次。预期：第二次被唯一索引拒 ⇒ 不重复打标/发信。DB：`WebhookDelivery` 仅 1 行对应 webhookId，仅 1 条 ExecutionLog。

**场景 E · 循环触发防护**（可先用非 protected trigger 验证，如 products/update）
- 输入：mypi 改 tag 触发关联 products/update 回流。预期：不无限重复；超 maxDepth(默认3)/限次时停止并记录原因（`ExecutionLog` 标注 loop-blocked）。

**场景 F · 多店铺隔离**
- 前置：A/B 两店数据。预期：A 店会话查不到 B 店 Automation/ExecutionLog；执行用 A 店 token。判定：越权查询返回空/403；token 断言。

**场景 G · Worker 崩溃恢复**
- 输入：执行中 kill worker。预期：RUNNING 超租约被回收不永久卡死；已成功 Step 不无条件重跑（靠 Step 状态+幂等）。判定：重启后 reap 计数 + 不重复 Mutation。

**场景 H · 高风险动作人工确认（P0-19，可用 mock/非 protected trigger 先验）**
- 前置：含 `riskLevel=high` 步骤（如下架商品）的自动化已启用。输入：一条命中事件。
- 预期：low 步骤自动完成；high 步骤 `ExecutionStep.status=AWAITING_CONFIRMATION` 且**未发起 Mutation**；商家确认后（操作者=merchant）才执行并转 SUCCESS；超时未确认按策略转 FAILED/保持待确认。判定：确认前无 shopify 写调用（mock 断言）。

> P0-9（Customer Created / company）按 D-9 首发只用 note/tags 已验证字段，company 分支属条件性；依赖 OQ-3/OQ-4 的判定在 OQ 未 VERIFIED 前记为 **CONDITIONAL**，不得当作已验证通过。

---

## 2. P1 验收标准（首发后增强）

| ID | 能力 | 验收断言 | 依赖 |
|---|---|---|---|
| P1-1 | Product Updated | products/update 触发 + normalize | read_products（无审批墙） |
| P1-2 | Update Product Status | productUpdate 改 DRAFT，先读后写幂等，防循环 | `[G2 write_products]` + OQ-7 |
| P1-3 | Inventory Low（T4） | inventory_levels/update→重算 available≤阈值触发 | read_inventory（已具备） |
| P1-4 | Custom Webhook 动作 | HTTPS 出站 + 幂等键 header + **SSRF 守卫** | OQ-9 |
| P1-5 | AND/OR 组合 | 一层组合正确求值 | 无 |
| P1-6 | 部分成功处理 | PARTIAL_SUCCESS 完整步骤结果 | 无 |
| P1-7 | Retry Failed Step Only | 仅重跑 FAILED 步，不重跑 SUCCESS | OQ 幂等验证 |
| P1-8 | Automation Duplicate | 复制生成新 Automation（同 Version 快照） | 无 |
| P1-9 | 更多模板 | 按 §32 规格逐条验收 | 视 trigger |

可随 MVP 一起交付（无外部阻塞）：P1-1、P1-3、P1-5、P1-6、P1-8。
必须验证后再做：P1-2（扩权+审核+防循环实测）、P1-4（SSRF 专项）、P1-7（步骤幂等实测）。

---

## 3. P2（未来，不列入 MVP 验收）

Daily Digest（T10 完整形态，依赖 read_all_orders/OQ-6）、高级定时器、更多通知渠道、复杂条件、高级库存自动化、更丰富集成、模板市场、AI 辅助配置。**MVP 不实现 Workflow Canvas / AI Agent**（PRD §8）。

---

## 4. 单元 / 集成测试门槛

- **Unit（纯函数目标 ≥90% 行覆盖；覆盖率非唯一指标）**：ConditionEvaluator、TriggerNormalizer、ActionExecutor（mock API Gateway）、Idempotency、LoopProtector、RetryPolicy、DSL Validation、Timezone、Payload Mapping。
- **Integration**：webhook 接收、HMAC 验证、DB 幂等（唯一索引冲突路径）、Automation 匹配、Action 执行、日志持久化、失败重试、多租户隔离、`purgeShopBusinessData` 覆盖全部 V2 新表（断言 uninstall/redact 后新表清干净 = R4/OQ）。
- 沿用现有 vitest + 可注入 db（参照 `tests/sync-job-ledger.db.test.ts`）范式。

---

## 5. 非功能验收

- **性能**：webhook 端点在接收路径不同步执行重活（先 200 后异步）；列表/日志分页；无 N+1 大 payload 查询。
- **可靠性**：队列持久化（DB）非内存；崩溃恢复（场景 G）；死信转 FAILED 可手动补偿。
- **安全**：Secret 明文不入库/日志（代码审查 + 日志抽样）；SSRF 拦截内网/localhost/169.254.169.254（专项用例）；HMAC 用原始 body 验签；错误 human-readable（无 GraphQL 堆栈外泄，抽样 Activity Logs 验证）。
- **合规**：uninstalled / shop:redact / customers:redact / data_request 全链路实测清干净。

---

## 6. 发布判定

MVP 视为"可发布"当且仅当：
1. §0 中 G3 通过（不依赖审批的基建先行发布亦可，但订单类自动化标灰不可启用）。
2. P0 表中**不依赖 G1/G2 的项全过** + 依赖项在 G1/G2 解除后全过。
3. E2E A–G 全过（A/B/C/D/F 需 G1/G2；E/G 可用非 protected trigger 或 mock 先验）。
4. 单元/集成门槛达标，`purgeShopBusinessData` 覆盖新表断言通过。
5. PRD §39 上线检查清单逐项勾选。

若 G1（审批）迟迟未解除：允许发布"基建 + 无审批墙的 T4 Low Stock Alert + 风险确认/去重/日志引擎"子集；首发另 4 个核心模板（T1/T2/T5/T7）与相关 P0 用例保持 **BLOCKED**，不得伪记为通过。

### 6.1 Phase 4 发布判定实测（逐条）

口径：**代码可核验项 = 已就绪**；**依赖 G1/G2/Staging 项 = 准备就绪，待外部**（不伪记通过）。

| §6 条件 | Phase 4 状态 | 证据 |
|---|---|---|
| 1·G3 迁移兼容 | ✅ 已就绪 | additive migrations 全部向后兼容；商家零重授权（offline token 不变） |
| 2·P0 无 G1/G2 项全过 | ✅ 已就绪 | P0-2/3/4/5/10/13/14/15/16/17/18/19/20(T4) 三门禁 + 单测覆盖 |
| 2·P0 依赖 G1/G2 项 | ⏳ 准备就绪，待提交 | P0-6/7/8/9/11/12 需审批；准备物见 `docs/V2-P4-APPROVAL-PACK.md` |
| 3·E2E 无审批场景（E/H/T4） | ⚠️ 逻辑面已过，浏览器截图待发布日 | `tests/automation-engine.test.ts` 路径 A/C/防循环；清单见 `docs/reports/14-p4-e2e.md` |
| 3·E2E 依赖 G1/G2（A/B/C/D） | ⏳ 准备就绪，待提交 | 受审批阻塞；标注不伪造 |
| 3·场景 F 隔离 | ✅ 已过 | `MYPI_DB_INTEGRATION` 下 `tests/shop-isolation.db.test.ts` |
| 3·场景 G 容器崩溃恢复 | ⏳ 待 Staging | 多副本演练需云资源 |
| 4·单测/集成门槛 | ✅ 已过 | 纯函数核 ≥90%（`docs/reports/12-p4-coverage.md`） |
| 4·purgeShopBusinessData 覆盖新表 | ✅ 已过 | GDPR redact/uninstall 集成测试断言行数 |
| 5·PRD §39 上线清单 | ✅ 已就绪 | 告警/排障/隐私/备份对账手册齐备 |

**总判定**：第一档（基建 + T4 + 合规/运维基座）**可发布**；第二档（订单/客户类 + 写动作）**准备就绪、待 G1/G2 生效**；场景 G 容器演练**待 Staging**。App Store 预检无 likely-failing（`docs/reports/15-p4-appstore-review.md`）。

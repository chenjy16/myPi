# mypi V2.0 · Phase 2 研发任务清单（Automation Engine）

> 基准：`docs/PRD-V2.0.md` v2.0-draft.2 §37 Phase 2 / §18–§25（引擎、Trigger/Condition/Action、DSL、可靠性）。
> 前置：**Phase 1 完成**（见 `docs/V2-PHASE1-TASKS.md` DoD）。
> 用途：可直接交给 AI Coding Agent 逐条实施。每条含 目标 / 涉及文件 / 步骤 / 交付物 / 验收 / 依赖 / 风险。
> 边界：本 Phase 交付**引擎内核**（匹配→求值→执行→日志→重试→防循环→确认门），不含前端五导航与模板 UI（Phase 3）。

---

## 0. 范围与前置约定

**Phase 2 交付**：Trigger Registry、Automation Matcher、Condition Evaluator（纯函数）、Action Registry + Executor、引擎编排管道、Loop Protection、Retry/Partial Success、版本编译确定性、确认门引擎侧接口。

**可测性策略（诚实边界）**：orders/customers 真实触发依赖 R1 审批 + D-2 扩权（未解除前相关 webhook 不能订阅）。因此 Phase 2 的端到端验证以 **`inventory_levels/update`、`products/update` 真实触发 + 对 orders/customers 事件用本地 mock payload 投递** 完成；E2E A/B/C/D/F（订单类）用 mock 事件驱动引擎，接真实订阅属 Phase 4 联调，不在本 Phase 伪造通过。

**红线（沿用 Phase 1）**：
- 复用不重写：`adminGraphql`（写操作经此 + `shopify-throttle` 退避）、`DataSyncJob.activeKey` 锁、`sync-job-ledger` 的 `withSyncJob` 状态机、`RecommendationAudit.requestKey @unique` 幂等范式、worker 优雅退出/`installedShops`。
- 模块路径规范：纯逻辑 → `app/lib/*.ts`（无 db，可单测）；绑 db → `app/*.server.ts`。
- **确定性（P2/PRD §21.4）**：引擎只消费编译冻结后的 `AutomationVersion.definition`，运行时不解释业务语义、不让 AI 决定是否执行 Mutation。
- **Human-readable（P3）**：所有 Action/步骤错误落 `ExecutionStep.errorText` 为商家可读文案，禁止把 GraphQL 原始堆栈透传（沿用 `adminGraphql` 的 AppError 分类）。
- 不改旧表、不动 OAuth/scopes（扩权是 Phase 4 决策项，本 Phase 代码按"需要哪些 scope"声明式登记，不实际改 toml）。

---

## WP-A Trigger Registry 与匹配

### P2-01 Trigger Registry（纯注册表）
- 目标：集中定义 trigger，替代 switch-case。
- 涉及：新增 `app/lib/trigger-registry.ts`（纯）。
- 步骤：
  1. 每个 trigger 注册：`type`（order.created/paid/cancelled、customer.created、product.updated、inventory.low、daily.schedule）、`source`（shopify.webhook | scheduler | webhook+reconcile）、映射 `topic`、**必需 scope 清单**、**字段白名单**（供 Evaluator 用）、标准化事件 shape、是否 protected（R1）、可用性（VERIFIED/待验证，取 `V2-OPEN-QUESTIONS.md`）。
  2. 暴露 `getTrigger(type)` / `triggerForTopic(topic)` / `fieldWhitelist(type)`。
  3. `inventory.low` 标注为"基于 inventory_levels/update + 重算"复合 trigger（PRD §18），非原生低库存 webhook。
- 交付物：注册表 + 单测（每 trigger 元数据齐全、topic 反查唯一）。
- 验收：未知 type 返回明确错误；白名单不含未验证字段（如 customers company 依 D-9 排除首发）。
- 依赖：P1-08（normalizer 输出 shape）。
- 风险：白名单写进未 VERIFIED 字段 → 与 OQ 表冲突；以 OQ 文件为准。

### P2-02 Automation Matcher（db）
- 目标：按店铺 + trigger 找 active 自动化及其编译版本。
- 涉及：新增 `app/automation-matcher.server.ts`。
- 步骤：`matchAutomations(shopId, triggerType) → [{automationId, version, compiled definition}]`，`where shopId + status=active + trigger.type=triggerType`（命中走 `Automation(shopId,status)` 索引 → 取 `currentVersionId` 对应 `AutomationVersion.definition`）。强制 `shopId` 过滤（多租户 F 雏形）。
- 交付物：服务 + 集成测试（注入 db）。
- 验收：paused/deleted 不被命中；跨店不串。
- 依赖：P1-01、P2-18（编译版本）。
- 风险：命中多条同类自动化需各自独立执行与记录（不得合并）。

---

## WP-B Condition Evaluator（纯函数）

### P2-03 运算符实现（纯）
- 目标：12 运算符的确定性求值。
- 涉及：新增 `app/lib/condition-operators.ts`（纯）。
- 步骤：实现 `equals/not_equals/greater_than/greater_than_or_equal/less_than/less_than_or_equal/contains/not_contains/is_empty/is_not_empty/in/not_in`；按 `type` 分派（number/string/bool/date/array）；类型不匹配的运算符（如 number 比较作用于 array）返回 `false` 不抛。
- 交付物：运算符表 + 单测（每运算符边界）。
- 验收：null 参与非空判定符合 PRD §19（除 is_empty 外遇 null → false）；日期比较用 ISO。
- 依赖：无。

### P2-04 Evaluator（纯）
- 目标：一层 AND/OR 组合求值 + 结果说明。
- 涉及：新增 `app/lib/condition-evaluator.ts`（纯）。
- 步骤：
  1. `evaluateConditions(compiledClauses, event, whitelist) → {result:boolean, clauses:[{field,op,expected,actual,pass}]}`。
  2. AND：全真才真；OR：任一真即真；**不递归嵌套**（PRD §19）。
  3. 字段引用先过 `whitelist`：白名单外字段 → 该 clause `pass=false` + 标注 `invalid_field`，整体不误执行、不 crash。
  4. 产出逐条 clause 明细写入 `ExecutionLog.conditionResult`（供 Activity Logs 展开，Phase 3）。
- 交付物：求值器 + 单测（AND/OR、无效字段、空值、数组 contains、日期）。
- 验收：目标 ≥90% 覆盖；相同输入+相同版本 ⇒ 相同结果（确定性）。
- 依赖：P2-03、P2-01。

### P2-05 值抽取与类型/时区归一（纯）
- 目标：从 StandardEvent 按声明类型安全取值。
- 涉及：并入 `app/lib/condition-evaluator.ts` 或 `app/lib/event-field-access.ts`（纯）。
- 步骤：点路径取值（`total_price`、`shipping_address.country_code`、`customer.tags`）；数值转换（字符串金额→number，不跨币种换算）；时间戳 UTC→Shop.timezone 归一（T10 关键）；缺字段→undefined（走空值规则）。
- 交付物：访问器 + 单测。
- 验收：跨形状（REST/GraphQL）字段一致解析。
- 依赖：P2-04。

---

## WP-C Action Registry 与 Executor

### P2-06 Action Registry（纯）
- 目标：集中注册 Action，携参数 schema/权限/幂等/风险。
- 涉及：新增 `app/lib/action-registry.ts`（纯），复用 P1-13 `action-risk-policy`。
- 步骤：
  1. 每个 Action：`actionId`、`paramSchema`（驱动校验+默认值）、`requiredScopes`、`riskLevel`/`confirmation`（P1-13 派生）、幂等策略描述、可读错误模板、超时、重试策略引用。
  2. 首版登记：`tags.add`、`tags.remove`（low）、`email.send`（low）、`send.webhook`（low，P1）、`product.updateStatus`（**high → required 确认**）。**不注册**"改价/删单"（PRD §8）。
  3. `getAction(id)` / `listActions()`；未知 id 明确报错。
- 交付物：注册表 + 单测。
- 验收：风险缺省=high/required；参数默认值完整。
- 依赖：P1-13。

### P2-07 API Gateway 写封装
- 目标：Mutation 走统一出口，带来源标识 + 复用退避。
- 涉及：`app/lib/admin-graphql.server.ts` 增 `adminGraphqlWrite`（薄封装，不改现有 `adminGraphql` 读逻辑）。
- 步骤：`adminGraphqlWrite(admin, mutation, {variables, requestSource})`：复用 `tries=resolveTries()`、`throttleWaitMs`、错误分类（validation/auth/shopify_api）；`requestSource` 供 P2-14 防循环尽力打标；失败抛 AppError（可读）。
- 交付物：写封装 + 单测（mock admin.graphql：节流/auth/validation/重试耗尽路径）。
- 验收：429/503 退避封顶 5s；auth 错误给"重新授权"文案；不吞 userErrors。
- 依赖：无（复用现有）。
- 风险：写与读共用出口需确保不回归既有同步读路径 → 新函数独立、旧函数不动。

### P2-08 Tags Executor
- 目标：`tagsAdd`/`tagsRemove` 真实执行且幂等。
- 涉及：新增 `app/automation/actions/tags.server.ts`。
- 步骤：
  1. add：先读目标现有 tags，缺失才 `tagsAdd`（幂等：重复不产生副作用；对应 OQ-2 scope 文案待验证，dev store 实测拒绝信息）。
  2. remove：不存在则视为 no-op 成功。
  3. 目标资源 = order/customer/product（GID），据 trigger target 选；走 P2-07 写封装带 `requestSource`。
  4. 结果/错误映射为 `ExecutionStep`（SUCCESS/FAILED + errorText）。
- 交付物：执行器 + 单测（mock 写封装）。
- 验收：重复 add 幂等；越权 scope 场景给可读错误。
- 依赖：P2-06、P2-07。

### P2-09 Email / Webhook 执行器（服务接口，provider 接线延后）
- 目标：定义出站动作契约；email 走平台服务、webhook 走带 SSRF 守卫的 HTTPS。
- 涉及：新增 `app/automation/actions/email.server.ts`、`app/automation/actions/outbound-webhook.server.ts`、`app/lib/ssrf-guard.ts`（纯）。
- 步骤：
  1. `sendEmail(integrationRef, template, vars)`：调用邮件服务接口（具体 provider 依 OQ-8/D-5 决策，Phase 2 先用可注入 stub，Phase 3 接真实 Resend/SendGrid）；以 `ExecutionStep.id` 去重；失败标步骤 FAILED 不 crash。
  2. `postToUrl(integrationRef, payload, idempotencyKey)`：先过 `ssrf-guard`（仅 https、拒内网/localhost/链路本地/169.254.169.254/fd00::/8、解析后校验实际 IP、防 DNS Rebinding），带幂等键 header（接收方负责去重）。
  3. 两者均 low 风险（自动执行）。
- 交付物：执行器 + `ssrf-guard` 单测（拦截样本）+ email stub 测。
- 验收：SSRF 用例全拦；email 未接线时明确"未配置"错误非静默。
- 依赖：P1-16（secret 解密取 SMTP/webhook secret）、P2-06。
- 风险：真实 email provider 未定（OQ-8）→ 用接口+stub，避免 Phase 2 被外部选型卡住。

### P2-10 高风险步骤确认处理
- 目标：`confirmation=required` 步骤落 `AWAITING_CONFIRMATION`，不擅自 Mutation。
- 涉及：新增 `app/automation/action-executor.server.ts`（步骤级调度）。
- 步骤：`executeStep(step, event, admin)` → 依 P1-13/P2-06 判 confirmation；`auto` 直接执行；`required` 仅落 `AWAITING_CONFIRMATION` 等待确认端点（P2-16）；超时策略（默认 24h）由队列复检决定转 FAILED/保持。
- 交付物：步骤执行器 + 单测（low 执行 / high 挂起 / 确认后执行）。
- 验收：确认前**零 Mutation**（mock 断言，对应 E2E 场景 H）。
- 依赖：P2-06、P2-07、P1-12。

---

## WP-D 引擎编排管道

### P2-11 Executor 编排（一次执行）
- 目标：串起 match→evaluate→（loop）→steps→log 落库。
- 涉及：新增 `app/automation-engine/execute.server.ts`。
- 步骤：`executeAutomation({shopId, event, automationMatch})`：
  1. `evaluateConditions`（P2-04）→ false 落 `ExecutionLog.status=SKIPPED` + conditionResult，不排步骤。
  2. true → 建 ExecutionLog（dedupeKey=事件指纹，防重复落账）→ 按 definition 顺序 `executeStep`（P2-10）→ 每步结果写 ExecutionStep。
  3. 聚合 `finalizeStatus`（P1-12）→ SUCCESS/FAILED/PARTIAL_SUCCESS。
  4. 步骤间非分布式事务（PRD §25.2），互不回滚。
- 交付物：编排器 + 集成测试（mock 写封装/integration）。
- 验收：A 全成功、B 跳过、C 部分成功三条路径 DB 断言正确。
- 依赖：P2-02/04/10/12。

### P2-12 Ingestion→Engine 全链路接线
- 目标：替换 Phase 1 stub，让认领事件真正驱动引擎。
- 涉及：`app/automation-ingest.server.ts`、`app/execution-queue.server.ts`、`worker/index.ts`。
- 步骤：ingest 去重后入队（P1-09）→ worker 认领 → 反查匹配（P2-02）→ `executeAutomation`（P2-11）；受 flag `AUTOMATION_EXECUTION_ENABLED` 控制（Phase 1 默认 false，本 Phase 打开）；防循环前置在认领后、执行前（P2-13）。
- 交付物：接线 + 端到端（mock）测。
- 验收：一次真实 inventory_levels 投递 → 命中 inventory.low 自动化 → 产出 ExecutionLog/Step。
- 依赖：P1-07/09/10、P2-11、P2-13。

### P2-13 Loop Protection
- 目标：可靠防连锁（PRD §24，区分可靠/降风险/不保证）。
- 涉及：新增 `app/lib/loop-protector.ts`（纯）+ `app/automation-loop.server.ts`（db 计数）。
- 步骤：
  1. **可靠**：事件指纹去重（`automationId+entityType+entityId+关键字段hash` 时间窗内相同→跳过）；自动化级限次（同 entityId 在 N 分钟内 ≤K 次，DB 计数/令牌桶）；最大级联深度（`cascadeDepth` 由 ExecutionLog 链传播，>maxDepth(默认3)→block 并记原因）；冷却窗合并。
  2. **降风险**：`requestSource`/`auto:` tag 前缀来源过滤（P2-07 打标），**不假设 Shopify 回传**（OQ-7）。
  3. `check(...) → allow | throttle | block`，block 写 ExecutionLog（status 记 loop-blocked，非 FAILED）。
- 交付物：防循环 + 单测（限次/深度/指纹）+ 集成（计数持久化）。
- 验收：E2E 场景 E——自触发关联事件不无限重复，超限停止并记录。
- 依赖：P1-12、P2-11。

### P2-14 级联深度传播
- 目标：把父执行的 depth 传给由自身 Mutation 引出的子事件。
- 涉及：并入 P2-13/P2-11（`ExecutionLog.cascadeDepth`）。
- 步骤：认领事件时，若能关联到父执行（entityId + 时间窗 + 指纹）则 `child.depth=parent.depth+1`，否则视为 0；随 maxDepth 判定。
- 交付物：传播逻辑 + 单测。
- 验收：链式回流入队被逐层计数。
- 依赖：P2-13。

---

## WP-E 重试与部分成功

### P2-15 Retry Policy（纯）
- 目标：确定性重试规则。
- 涉及：新增 `app/lib/retry-policy.ts`（纯）。
- 步骤：最大次数（默认 3）、指数退避 + 随机抖动（复用 `shopify-throttle` 封顶 5s 语义）、可重试错误集（`shopify_api` 退避类可重试；`validation`/`auth` 不可重试直接终态）、超限→死信（FAILED 待手动补偿）。
- 交付物：策略 + 单测（backoff 序列、错误分类分派）。
- 验收：validation 错误不重试；退避不超封顶。
- 依赖：无。

### P2-16 Retry 编排 + 确认端点
- 目标：整任务重试 / 仅重试失败步骤 / 高风险确认，三者落库正确。
- 涉及：`app/automation-engine/retry.server.ts` + 复用 P2-10；路由（引擎侧内部 action，Phase 3 暴露 UI）。
- 步骤：
  1. `retryExecution(executionId, {failedOnly:boolean})`：**新建子 ExecutionLog（parentExecutionId）**，不改原始记录；failedOnly 仅重跑 FAILED 步、复制 SUCCESS 步结果不重发（防重复 Mutation）；沿用步骤幂等（P2-08）。
  2. `confirmStep(stepId, actor="merchant")`：把 `AWAITING_CONFIRMATION` 步骤执行并转 SUCCESS；确认写操作者=merchant。
  3. 重试计数与死信判定接 P2-15。
- 交付物：重试/确认服务 + 集成测试（父子关系、仅重跑失败步不重复 Mutation）。
- 验收：E2E 场景 C 可"仅重试失败步骤"；重试新建记录原记录保留。
- 依赖：P2-10/11/15。

### P2-17 UNKNOWN（超时不等于失败）处理
- 目标：外部已执行但未收到响应时不武断重发。
- 涉及：并入 P2-11/P2-16 + 步骤状态 `UNKNOWN`。
- 步骤：写 Mutation 超时/无响应 → 步骤标 `UNKNOWN`，触发**回读校正**（可查的如 tags 回读 Shopify 现状判定是否已生效）；无法判定则保持待人工确认，**不自动重发**（防重复打标/重复邮件）。
- 交付物：UNKNOWN 分支 + 单测（超时→回读→定态）。
- 验收：网络超时不导致无条件重试重发。
- 依赖：P2-08/16。

---

## WP-F 确定性与版本

### P2-18 Definition 编译器
- 目标：DSL→编译冻结运行时计划（PRD §21.4）。
- 涉及：新增 `app/lib/automation-compiler.ts`（纯）。
- 步骤：`compile(definitionJson) → {triggerMatcherKey, conditionClauses[], actionSteps[]+每步 riskLevel/confirmation, compiledVersion}`；复用 P1-14 校验；产出冻结进 `AutomationVersion.definition`；引擎只吃编译结果。
- 交付物：编译器 + 单测（三示例 DSL 编译 + 向后兼容字段忽略）。
- 验收：编辑生成新 version；老执行记录引用旧 version 可确定性回放。
- 依赖：P1-14、P2-01/06。

---

## WP-G 测试与验收

### P2-19 单元测试（纯函数 ≥90%）
- 覆盖：`condition-operators`、`condition-evaluator`、`loop-protector`、`retry-policy`、`ssrf-guard`、`action-risk-policy`（P1-13）、`automation-compiler`。
- 验收：全绿入 CI。

### P2-20 集成测试（可注入 db + mock 写封装/integration）
- 覆盖：matcher 命中/隔离、evaluate→execute 的 A/B/C 落库、部分成功聚合、确认门挂起、重试父子+仅重跑失败步、防循环限次/深度、UNKNOWN 回读校正。
- 验收：以上路径均有断言；mock 断言"确认前/去重后零 Mutation"。

### P2-21 E2E（引擎侧，A–G 可验部分）
- A/B/D/F：mock orders/customers 事件驱动引擎（不等审批）。
- E：inventory/products 真实触发验证级联超限。
- G：worker 崩溃恢复（补 Phase 1 租约回收在引擎执行下的表现）。
- H（风险确认）：high 步骤挂起→确认执行。
- 验收：对应 `V2-MVP-ACCEPTANCE.md` §1 E2E 全部通过（订单类标注"经 mock 事件验证，真实订阅联调在 Phase 4"）。

---

## 8. 依赖与执行顺序

```
P2-01(trigger registry) ─┐
P2-18(compile) ───────────┼─→ P2-02(matcher) ─┐
P2-03(op) → P2-04(eval) → P2-05(access) ───────┤
P1-13 → P2-06(action registry) → P2-07(api write) → P2-08(tags) / P2-09(email·webhook·ssrf) → P2-10(step+confirm)
   P2-02 + P2-04 + P2-10 → P2-11(execute) → P2-12(全链路接线，替换 Phase1 stub)
P2-11 → P2-13(loop) → P2-14(depth)
P2-15(retry policy) + P2-11 → P2-16(retry+confirm 编排) → P2-17(UNKNOWN 校正)
测试 P2-19/20/21 随各模块
```
关键路径：P2-06 → P2-07 → P2-10 → P2-11 → P2-12。P2-03/04/05、P2-15、P2-01、P2-18 可与主干并行。

---

## 9. Phase 2 完成定义（DoD）

- [ ] 一条 `inventory_levels/update` 真实事件可端到端跑通 ingest→normalize→dedup→loop→match→evaluate→execute→log，产出 ExecutionLog/Step（PRD §37 Phase 2 / E2E A 的无审批等价验证）。
- [ ] 条件求值确定性（同输入同版本同结果）+ 无效字段安全跳过；AND/OR 一层。
- [ ] Action Registry/Executor 落地 tags（真实）+ email/webhook（接口+stub/SSRF）；未知 Action/改价/删单不可达。
- [ ] 部分成功、仅重试失败步、父子重试、UNKNOWN 回读校正、死信，全部有测试覆盖且"确认前/去重后零 Mutation"。
- [ ] 高风险步骤 `AWAITING_CONFIRMATION` 确认门生效（E2E 场景 H）。
- [ ] Loop Protection 三可靠手段（去重/限次/级联深度）+ 降风险来源标识；E2E 场景 E 通过。
- [ ] Definition 编译冻结 + 版本可回放；引擎仅消费编译结果。
- [ ] 订单/客户 trigger 经 mock 事件验证通过；**真实 webhook 订阅联调明确留待 Phase 4（R1+D-2）**，本 Phase 不伪造。
- [ ] CI 全绿。

**遗留到 Phase 3**：五导航、模板库 UI、参数抽屉、Activity Logs/Integrations 配置 UI、确认/重试的商家侧交互、真实 email provider 接线（OQ-8）。
**遗留到 Phase 4**：R1 审批联调、R3/D-2 扩权与 App Store 权限审核、生产 worker 部署、监控告警、性能与安全专项、发布检查清单。

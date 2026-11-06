# mypi V2.0 · Phase 3 研发任务清单（前端五导航 + 首发 5 模板 + 确认/重试交互）

> 基准：`docs/PRD-V2.0.md` v2.0-draft.2 §5–§6（信息架构）、§20.1（风险确认）、§32（模板库分层）、§37 Phase 3。
> 前置：**Phase 2 完成**（引擎可执行；见 `docs/V2-PHASE2-TASKS.md` DoD）。
> 用途：可直接交给 AI Coding Agent 逐条实施。每条含 目标 / 涉及文件 / 步骤 / 交付物 / 验收 / 依赖 / 风险。
> 边界：本 Phase 交付**商家可见的自动化界面 + 模板系统 + 确认/重试交互**；不含真实订阅联调/权限审核/生产发布（Phase 4）。

---

## 0. 范围与前置约定

**Phase 3 交付**：五导航信息架构、模板库（首发 5 核心）、3 分钟启用向导、My Automations 管理、Activity Logs 与执行详情、高风险步骤确认交互、失败重试交互、Integrations 配置、Automation Center 首页。

**已有前端约定（务必复用，不另起范式）**：
- 路由：`app/routes/*.tsx` 经 `flatRoutes()`（`app/routes.ts`）按点分生成路径。自动化区用**嵌套布局**：`app.automation.tsx`（`/app/automation` 壳 + `<Outlet/>`）+ 子页 `app.automation._index.tsx`/`app.automation.templates.tsx` 等。
- 每个页面：`export const loader = safeLoader(...)`（`app/lib/route-error.ts`）内 `authenticate.admin(request)` 取 `session.shop`；写操作用 `action` + `useFetcher`；`export const headers = boundary.headers`；错误边界沿用 `app/routes/app.tsx` 的 `ErrorBoundary` 兜底（已就绪）。
- 组件库：`app/components/ui/` 的 `data-table`、`status-badge`、`empty-state`、`loading-state`、`confirm-fetch-form`、`fact-grid`（**优先复用，缺的再补**）。
- 样式：`app/styles/tokens.css` + `app-shell.css` + `dashboard.css`；新页样式并入既有 token 体系，**不写裸 hex**（历史约束）。
- 特性开关：仿 `app/features.ts`（`PRODUCT_COPY_ENABLED`）——关时隐藏导航 + loader/action 拒绝访问，代码与数据保留。
- 埋点：`app/analytics.server.ts` 的 `trackEvent`（启用/确认/重试等关键动作补埋点，对齐 §5 反馈）。

**诚实边界**：订单/客户自动化能否真正运行仍受 **R1（Protected Customer Data 审批）+ D-2（写 scope）** 约束。Phase 3 的界面可为 5 个模板全部提供"启用"，但**订单/客户类自动化启用后，其真实触发要待 Phase 4 审批+扩权落地**；界面需如实提示"已启用，待店铺数据权限开通后开始运行"（不伪造"运行中"）。`inventory.low`（T4）无审批墙，可在本 Phase 演示完整闭环。

**红线**：不显示密钥明文；不把 GraphQL 堆栈/内部错误透传给商家（走 `errorText` 可读文案）；所有查询按 `shopId`/`shop` 隔离（多租户 F）；不改 OAuth/scopes/session。

---

## WP-A 导航与信息架构

### P3-01 自动化特性开关
- 目标：整体可控灰度上线。
- 涉及：`app/features.ts`、各自动化路由。
- 步骤：加 `AUTOMATION_ENABLED`（默认与产品发布节奏一致）；关时 `NAV_ITEMS` 隐藏自动化项、`app.automation*.tsx` 的 loader/action 早退返回"未开放"（复用 `app/components/feature-disabled.tsx`）。
- 交付物：开关 + 拦截。
- 验收：关→导航无入口且直接访问 /app/automation 被拦；开→五页可达。
- 依赖：无。

### P3-02 侧栏五导航分组
- 目标：在不打散既有 V1 导航下加入自动化区。
- 涉及：`app/routes/app.tsx`（`NAV_ITEMS` + 渲染）。
- 步骤：
  1. `NAV_ITEMS` 扩展支持 `section`（分组标签）；新增分组 "Automation" 下五项：Automation Center(`/app/automation`, end)、Templates(`/app/automation/templates`)、My Automations(`/app/automation/automations`)、Activity Logs(`/app/automation/activity`)、Integrations(`/app/automation/integrations`)。
  2. 受 P3-01 开关过滤；`aria-current`/active 判定沿用现有 `startsWith` 逻辑（注意 Center 用 `end:true` 避免吞子路由高亮）。
  3. 侧栏样式补分组标题（tokens 内），窄屏（390）折叠不溢出。
- 交付物：导航项 + 分组渲染。
- 验收：五入口正确高亮互不串；V1 项不受影响；开关关时整组隐藏。
- 依赖：P3-01。

### P3-03 自动化区嵌套布局壳
- 目标：区内二级导航/标题统一。
- 涉及：新增 `app/routes/app.automation.tsx`。
- 步骤：`authenticate.admin` + 二级 Tab（五页间切换）+ `<Outlet/>`；集中把 `shop`/`shopId`（P1-04 `resolveShopFromSession`）放进 loader data 供子页复用。
- 交付物：布局路由。
- 验收：子页渲染于 Outlet；二级 Tab active 正确。
- 依赖：P3-02、P1-04。

---

## WP-B 数据服务层（面向 UI 的 CRUD/查询）

### P3-04 `automations.server.ts`（商家侧 CRUD）
- 目标：自动化增删改查与开关（Phase 2 有引擎/匹配，缺商家写面）。
- 涉及：新增 `app/automations.server.ts`（复用 `db.server` 单例 + `ensureShop`）。
- 步骤：`listAutomations(shop)` / `getAutomation(shop,id)`（带当前 version + 最近执行摘要） / `createFromTemplate(shop, templateId, params)`（编译 P2-18 + 校验 P1-14 → 建 Automation+AutomationVersion，status=draft/active） / `updateParams(...)`（生成**新 version**，不覆写旧版以保回放） / `setActive` / `pause` / `softDelete`。全部强制 `shopId` 作用域。
- 交付物：服务 + 单测（注入 db）。
- 验收：跨店不可读写；编辑产生新 version、旧记录保留；启用前经 DSL 编译校验拒绝非法定义。
- 依赖：P1-01/04、P2-18、P1-14。

### P3-05 模板目录（数据驱动）
- 目标：把 PRD §32 模板落成数据目录，供画廊/向导读取，加模板不改组件。
- 涉及：新增 `app/lib/template-catalog.ts`（纯）。
- 步骤：
  1. 每模板：`id`、`name`、`oneLine`、`category`、`tier`(LAUNCH/EXTENDED)、`triggerType`、`params[]`（字段、类型、白名单来源、默认值、是否必填、人类可读标签）、`definitionTemplate(params)→DSL`、`requiresProtectedData:boolean`（R1 标记）、`stepsPreview`。
  2. **首发 5 核心**（PRD §32 LAUNCH）：T1 VIP 打标、T2 高价值邮件、T4 Low Stock、T5 取消订单通知、T7 Customer Classification；EXTENDED 的 T3/T6/T8/T9/T10 也登记但 `tier=EXTENDED`（画廊可标"即将/实验"，不阻塞发布）。
  3. T7 判据用 `note contains "wholesale"`（D-9，避开 OQ-3 company 未验证字段）。
- 交付物：目录 + 单测（每模板 definitionTemplate 能被 P1-14 校验通过）。
- 验收：5 LAUNCH 齐全；EXTENDED 不混入首发硬指标；无未 VERIFIED 字段。
- 依赖：P1-14、P2-01（trigger 白名单）。

### P3-06 `activity.server.ts`（执行日志查询）
- 目标：为 Activity Logs/详情提供过滤分页读模型 + 可读摘要。
- 涉及：新增 `app/activity.server.ts`。
- 步骤：`listExecutions(shop, {status?, automationId?, entityRef?, from?, to?, cursor?})`（走 `ExecutionLog(shopId,...)` 索引，游标分页）；`getExecutionDetail(executionId, shop)`（含 steps 有序、conditionResult、parent/children 血缘）；`buildHumanSummary(log)`（"订单 #1042 满 $500 → 打 VIP 标签，成功 1/1"）；`awaitingConfirmationCount(shop)`（Center/角标用）。
- 交付物：服务 + 单测（过滤/分页/血缘/可读摘要）。
- 验收：跨店隔离；部分成功/loop-blocked/待确认各状态摘要正确。
- 依赖：P1-01、P2-11/16。

---

## WP-C Templates 画廊与 3 分钟启用向导

### P3-07 Templates 画廊页
- 目标：模板卡片墙（首发优先）。
- 涉及：新增 `app/routes/app.automation.templates.tsx`。
- 步骤：读 P3-05 目录 → 卡片（名/简介/category/LAUNCH 徽标/步骤预览）；LAUNCH 与 EXTENDED 分区；CTA "Enable" → 进向导；`requiresProtectedData` 卡片显示"需店铺数据权限"提示（诚实）。空态用 `EmptyState`。
- 交付物：页面。
- 验收：5 LAUNCH 可见可点；EXTENDED 明确标注不误导。
- 依赖：P3-03/05。

### P3-08 模板启用向导（参数抽屉）
- 目标：填参数即生成自动化，"3 分钟"体验。
- 涉及：新增 `app/routes/app.automation.templates.$templateId.tsx`。
- 步骤：
  1. 按模板 `params[]` 渲染表单（复用 data-table/fact-grid 风格 + 原生 input，类型化校验：金额/阈值/日期）。
  2. 实时人类可读预览（"当 <条件> 时 → <动作>"，映射 P2-04 conditionResult 文案 + 步骤）。
  3. `action`：`createFromTemplate`（P3-04，服务端再校验 P1-14）→ 成功跳 My Automations，`trackEvent("automation_created_from_template")`。
  4. 前端校验失败给字段级可读提示，不落半态。
- 交付物：页面 + loader/action。
- 验收：T4 端到端可创建并 active；非法参数被拒且不写库。
- 依赖：P3-04/05/07。

### P3-09 启用即生效 & 诚实状态
- 目标：创建后状态语义正确。
- 涉及：P3-04/P3-08 协作。
- 步骤：`inventory.low` 类启用后直接 active（可跑）；订单/客户类启用后置 active，但详情显示"待店铺数据权限开通后运行"徽标（依 P3-05 `requiresProtectedData`），不显示"运行中"假象。
- 交付物：状态文案 + 徽标逻辑。
- 验收：两类模板状态呈现区分正确。
- 依赖：P3-08。

---

## WP-D My Automations 管理

### P3-10 列表页
- 目标：集中查看/开关/删除已建自动化。
- 涉及：新增 `app/routes/app.automation.automations.tsx`。
- 步骤：`data-table`（名/trigger 摘要/状态/最近运行/操作）；启停开关（`setActive`/`pause` action，`useFetcher` 乐观更新回滚）；删除用 `ConfirmFetchForm`（二次确认，`softDelete`）；空态引导去 Templates。
- 交付物：页面 + action。
- 验收：开关/删除即时反映；跨店不可见。
- 依赖：P3-04/06。

### P3-11 详情/编辑页
- 目标：查看编译步骤 + 改参生成新版本。
- 涉及：新增 `app/routes/app.automation.automations.$id.tsx`。
- 步骤：展示当前 version 的 trigger/conditions/actions 可读视图 + 最近执行；编辑参数→`updateParams`（新 version，PRD §21.4）；版本变更提示"历史执行仍按旧版记录"；显示 `requiresProtectedData` 运行态。
- 交付物：页面 + action。
- 验收：编辑产新版本非覆写；只读本店数据。
- 依赖：P3-04/10。

---

## WP-E Activity Logs 与执行详情

### P3-12 Activity Logs 列表
- 目标：全局可观测。
- 涉及：新增 `app/routes/app.automation.activity.tsx`。
- 步骤：`P3-06.listExecutions` + 过滤 chips（status/automation/时间窗）+ 游标"加载更多"；每行可读摘要 + `status-badge`（SUCCESS/PARTIAL/FAILED/SKIPPED/AWAITING/loop-blocked 各自色）；点击进详情。
- 交付物：页面。
- 验收：过滤正确；分页稳定；状态徽标齐全。
- 依赖：P3-06。

### P3-13 执行详情页
- 目标：一次执行的可读时间线。
- 涉及：新增 `app/routes/app.automation.activity.$executionId.tsx`。
- 步骤：父子里程碑（parent/children 重试血缘）+ 逐步骤（Action 名、status、`AWAITING_CONFIRMATION` 高亮、耗时、`result`/`errorText` 可读）；条件明细展开（conditionResult 每 clause actual/期望/pass）；此处挂 P3-14 确认 / P3-15 重试入口。
- 交付物：页面。
- 验收：部分成功/跳过/待确认可解释；不透传堆栈。
- 依赖：P3-06、P2-16。

---

## WP-F 确认 / 重试交互（§20.1）

### P3-14 高风险步骤"确认并执行"
- 目标：把 P2-16 `confirmStep` 暴露给商家。
- 涉及：P3-13 页 + `app.automation.activity.$executionId` action。
- 步骤：`AWAITING_CONFIRMATION` 步骤显示"将发生什么"（资源/前后状态），按钮 Confirm→`action` 调 `confirmStep(stepId, actor="merchant")`（P2-10/16）；确认前**无 Mutation**（引擎保证），确认后转 SUCCESS 并刷新；需 `authenticate.admin` 会话（actor=商家）；`trackEvent("automation_step_confirmed")`。
- 交付物：交互 + action。
- 验收：确认前步骤不发写；确认后执行成功/失败如实回写；超时(24h)按策略展示。
- 依赖：P2-10/16、P3-13。

### P3-15 重试交互
- 目标：整任务重试 / 仅重试失败步骤（场景 C）。
- 涉及：P3-13 页 action。
- 步骤：FAILED/PARTIAL_SUCCESS 详情显示 `Retry all` 与 `Retry failed only`→`retryExecution(executionId,{failedOnly})`（P2-16，新建子记录）；按 P2-15 策略对不可重试（validation/auth）禁用并给原因；展示父子血缘；`trackEvent("automation_retried")`。
- 交付物：交互 + action。
- 验收：仅重跑失败步不重复 Mutation（引擎断言）；原记录保留；禁用态有原因。
- 依赖：P2-16/15、P3-13。

---

## WP-G Integrations 配置

### P3-16 Integrations 页
- 目标：配置邮件服务商 / 出站 Webhook 端点，密钥安全存储。
- 涉及：新增 `app/routes/app.automation.integrations.tsx`，服务 `app/integrations.server.ts`。
- 步骤：
  1. 列表 + 新增表单（type=email/outbound_webhook、参数、secret 字段）；secret 经 P1-16 `crypto-box` 加密入 `Integration.secretsEncrypted`，**页面永不回显明文**（掩码）。
  2. "测试连接" action：email→发测试信（P2-09 stub/provider）；webhook→对端点做带 SSRF 守卫(P2-09)的探测。
  3. 删除集成二次确认；被自动化引用的集成删除前提示影响。
- 交付物：页面 + 服务。
- 验收：密钥往返可用不明文；SSRF 端点被拦；跨店隔离。
- 依赖：P1-16、P2-09、P3-04。

---

## WP-H Automation Center（首页）

### P3-17 Center 仪表盘
- 目标：自动化区首页给全局态势与入口。
- 涉及：新增 `app/routes/app.automation._index.tsx`。
- 步骤：指标卡（active 自动化数、今日运行数、**待确认数**(P3-06)、近期失败数）+ 最近活动（跳详情）+ "从模板开始"快链（T4 优先）；零自动化用 `EmptyState` 引导首启；复用 `fact-grid`/`status-badge`。
- 交付物：页面。
- 验收：指标与 DB 事实一致；待确认可点入 P3-13。
- 依赖：P3-06。

---

## WP-I 设计系统 / 可访问性 / 响应式

### P3-18 样式与响应式对齐
- 目标：与现有设计系统一致。
- 涉及：新增 `app/styles/automation.css`（并入 tokens）、各页 className。
- 步骤：颜色/间距全走 `tokens.css` 变量（禁裸 hex）；`data-table` 在 390/768/1440 不破版（对齐 `docs/design-system.md` 与 `ui-forensics/` 既有断点截图基线）；徽标/按钮复用既有组件类。
- 交付物：样式。
- 验收：三断点无溢出/截断；视觉与 V1 页一致。
- 依赖：P3-03~17。

### P3-19 可读性与无障碍 & 错误兜底
- 目标：P3 原则（Human-readable）+ a11y。
- 涉及：各页。
- 步骤：状态/动作用商家语言（避免"Mutation/GID"术语）；表单 label 关联、`aria-current`、键盘可达、错误 `role=alert`；loader 异常经 `safeLoader`→`app.tsx` `ErrorBoundary` 出可读卡（不透传堆栈，已具备）；时间按 Shop.timezone 显示（P2-05）。
- 交付物：可访问性细节。
- 验收：屏幕阅读器标签完整；错误页不泄露内部信息。
- 依赖：P3-07~17。

---

## WP-J 测试与验收

### P3-20 服务/目录单测 + 模板完整性
- 覆盖：`automations.server`/`activity.server`/`integrations.server`（注入 db）、`template-catalog`（5 LAUNCH 齐全且 definitionTemplate 过 P1-14 校验）。
- 验收：全绿入 CI；模板目录契约测试（每模板可编译、无未 VERIFIED 字段、tier 正确）。

### P3-21 关键路径集成/组件测
- 覆盖：向导创建 T4 全链路（参数→校验→建自动化→active）、启停/删除 action、确认 action（断言确认前零 Mutation）、重试 action、Integrations 加密往返、Center 指标正确性；loader/action 用 vitest（+ testing-library 视既有约定）。
- 验收：3 分钟启用/看日志/高风险确认三条主流程通过；订单类启用显示"待权限"非"运行中"。

---

## 8. 依赖与执行顺序

```
P3-01(flag) → P3-02(nav) → P3-03(layout)
P3-05(catalog)  P3-04(automations.server)  P3-06(activity.server)   ← 服务层可并行先建
      ├→ P3-07(gallery) → P3-08(wizard) → P3-09(status)
      P3-04 → P3-10(list) → P3-11(detail)
      P3-06 → P3-12(activity list) → P3-13(detail) → P3-14(confirm)/P3-15(retry)  (依赖 P2-16)
      P1-16 + P2-09 → P3-16(integrations)
      P3-06 → P3-17(center)
      P3-03~17 → P3-18(styles)/P3-19(a11y) ;  P3-20/21 随各模块
```
关键路径：P3-03 → P3-04/05 → P3-08（3 分钟启用）。服务层（P3-04/05/06）可先于页面并行开发。

---

## 9. Phase 3 完成定义（DoD）

- [ ] 五导航（Center/Templates/My Automations/Activity Logs/Integrations）可达、受 `AUTOMATION_ENABLED` 控制、多断点不破版、V1 导航不受影响。
- [ ] 商家可从 **T4（无审批墙）** 模板走通"选模板→填参数→3 分钟启用→My Automations 可见→Activity Logs 看到真实执行"。
- [ ] 首发 **5 核心模板**（T1/T2/T4/T5/T7）在画廊齐备、definitionTemplate 全部编译通过；EXTENDED 5 个明确标注不阻塞发布。
- [ ] 订单/客户类模板启用后状态如实显示"待店铺数据权限开通后运行"，**不伪造运行中**（诚实边界）。
- [ ] 高风险步骤 `AWAITING_CONFIRMATION` 在详情页可视、可确认，**确认前零 Mutation**；失败可"整任务重试/仅重试失败步"，不可重试类型禁用带原因。
- [ ] Activity Logs 过滤/分页/血缘/可读摘要完整；执行详情逐步骤可解释（含 conditionResult）。
- [ ] Integrations 可配置邮件/出站 webhook，密钥加密存储、页面不明文回显、测试连接经 SSRF 守卫。
- [ ] 全程商家可读文案、无堆栈透传、a11y 标签完整；模板/服务契约测试 + 三条主流程集成测试通过；CI 全绿。

**遗留到 Phase 4**：真实 orders/customers 订阅端到端联调（R1+D-2）、App Store 权限审核、生产 worker/监控/告警、性能与安全专项、发布检查清单（`V2-MVP-ACCEPTANCE.md`）、真实 email provider 接线（OQ-8）。

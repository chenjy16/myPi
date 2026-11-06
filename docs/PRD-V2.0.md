# mypi V2.0 Product Requirements Document (PRD)

> 项目代号：**Shopify Automation Toolkit**
> 一句话：Simple Automation for Shopify. Automate repetitive store tasks. Stay in control.

---

## 1. 文档信息与版本记录

| 项 | 值 |
|---|---|
| 文档 | mypi V2.0 PRD |
| 版本 | v2.0-draft.2 |
| 状态 | 待评审（Decision-complete 草案，可直接交 AI Coding Agent 分阶段实施） |
| 产品代号 | Shopify Automation Toolkit |
| 关联文档 | `docs/V1-TO-V2-MIGRATION.md`（代码事实基线）、`docs/V2-OPEN-QUESTIONS.md`（待验证/风险）、`docs/V2-MVP-ACCEPTANCE.md`（MVP 验收） |
| 事实基线 | 阶段一真实代码审计 + 阶段二 Shopify API 核实；本文所有"已具备/需新建/API 能力"以 V1-TO-V2-MIGRATION.md §1 与 V2-OPEN-QUESTIONS.md 标记为准 |

版本记录：
- v2.0-draft.1 — 首版完整 PRD，覆盖委托要求的 40 个章节。
- v2.0-draft.2 — 吸收三条产品负责人决策（2026-11）：① Toolkit→Platform 三阶段定位（§3.1）；② 执行风险分级与人工确认 P6（§20.1）；③ 首发收敛为 5 核心模板，其余进扩展库（§32/§34/§37）。

---

## 2. 项目背景

mypi V1.x 是一款 Shopify 库存分析与补货决策工具（只读主链路：同步 → 快照 → 建议 → 采购计划），已在生产域名跑通安装流并渲染真实店铺数据（见迁移文档）。

V2.0 进行**产品定位升级**：从 `Shopify Inventory Replenishment Tool` 转型为 `Shopify Automation Toolkit`。产品不再围绕库存补货，而是围绕**商家日常运营自动化**。库存管理降级为"未来可扩展的自动化应用场景之一"，不再是核心。

关键约束（委托 1.2 / 16.3）：本产品**不是 Shopify Flow 克隆**。不做节点连线画布、不要求用户懂编程/API/JSON、不要求从零建流程；以预置模板 + 简单条件 + 向导式配置交付；所有自动化可查看、可暂停、可恢复、可追踪；用户始终握有最终控制权。

---

## 3. 产品定位

- **品类**：面向中小 Shopify 商家的 No-code 运营自动化工具箱（Embedded App）。
- **差异化**：相比 Shopify Flow ——更低的心智门槛（模板即用、自然语言摘要、失败可读）；相比 n8n/Zapier ——零 API 拼装、深度嵌在 Shopify Admin 内、多店铺隔离开箱即用。
- **心智模型**：`When <事件> , If <条件> , Then <动作>`，一条规则一句话可读。
- **暂不做的（当前阶段）**：可视化 DAG 画布、任意脚本、AI 自主决定是否执行 Mutation、BPM/审批流引擎。

### 3.1 定位演进路线：Toolkit → Platform（产品负责人决策 2026-11）

产品终局是 **Automation Platform**，但**分三阶段渐进**，绝不一次性建平台——先让商家低成本体验到自动化价值，再逐步开放组合能力：

| 阶段 | 形态 | 开放能力 | 门槛 |
|---|---|---|---|
| Stage 1（V2.0 首发）| **Automation Toolkit** | 固定模板一键启用（首发 5 个核心模板）；Trigger/Condition/Action 由模板预置，用户只填参数 | 零 |
| Stage 2 | Toolkit → 轻平台 | 允许商家在向导中**自由组合** Trigger × Condition × Action（My Automations 向导即此能力雏形） | 字段白名单 + 一层 AND/OR |
| Stage 3 | **Automation Platform** | 可扩展生态：自定义 Trigger/Action、更多集成、模板市场 | 按需，且始终受 P4/P6 可靠性与安全原则约束 |

**本 PRD 交付 Stage 1，并把引擎（Registry + DSL）设计成可向 Stage 2/3 平滑扩展**；但 MVP **不实现**画布、任意代码、平台级扩展——这些是后续阶段，不进首发硬指标。

---

## 4. 产品使命与价值主张

使命：为中小型 Shopify 商家提供**极简、可靠、开箱即用**的自动化工具箱，自动处理重复运营工作、及时发现店铺异常，并以清晰、可追踪、可控制的执行系统降低运营成本。

价值主张：
1. **省时**：重复打标/通知/巡检交给确定性自动化。
2. **降错**：价格异常、超卖、高风险订单实时拦截。
3. **可控**：每条自动化可查看运行记录、随时暂停、失败可重试。
4. **可信**：Human-readable 错误、失败留痕、不擅自改数据。

五条设计原则（贯穿全文，验收/测试都据此）：
- **P1 No-code Simplicity**：模板/表单/下拉/简单条件完成一切。
- **P2 Deterministic Execution**：相同输入 + 相同规则版本 ⇒ 一致判断；AI 不得决定是否执行 Mutation。
- **P3 Human-readable**：任何错误/异常对普通商家可读；禁止把 GraphQL 原始堆栈抛给用户。
- **P4 Failure Resilient**：幂等、防重、限流、指数退避、部分成功、失败重试、手动补偿、死循环防护。
- **P5 Merchant Control**：创建/暂停/恢复/编辑/删除/看记录/重试/看连接状态。
- **P6 Safe by Default（风险分级执行）**：Action 按数据影响面分级——低风险自动执行，高风险默认需人工确认，破坏性操作不进入 MVP（详见 §20.1）。降低新用户首次启用自动化的顾虑。

---

## 5. 目标用户与使用场景

核心用户：
1. DTC 独立站小微团队（1~5 人）。
2. Shopify 跨境电商卖家。
3. 无专职 IT / 运营自动化的商家。
4. 想降低 Shopify Flow 使用门槛的用户。

典型场景（→ 首发模板，见 §32）：高价值订单标 VIP、高风险订单告警、新订单通知运营、库存不足通知采购、价格异常处理、新客户分类、未发货提醒、业务事件推外部系统。

---

## 6. 用户痛点

| 痛点 | 现状 | V2 应答 |
|---|---|---|
| 重复手工打标/通知 | 靠人在 Admin 逐单操作 | 模板一键启用自动化 |
| Flow 门槛高 | 需要理解 trigger/条件/节点 | 向导 + 自然语言摘要 |
| 异常发现慢 | 价格打错、超卖事后才知 | 事件驱动即时动作 |
| 自动化不可信 | 怕乱改数据、怕失控 | 可暂停/可追踪/失败可读/防循环 |
| 出错无解释 | API 堆栈看不懂 | Human-readable 错误 + 步骤结果 |

---

## 7. 产品目标

- 首发交付 5 导航 + Automation Engine（Trigger/Condition/Action）+ DSL + **5 个核心模板**（另 5 个作为扩展模板随审批/验证进度上线）+ 完整可靠性（幂等/防循环/限流/部分成功/重试）+ 风险分级执行与人工确认 + 多租户隔离。
- 交付即可上架的合规基线（HMAC、数据最小化、GDPR/shop:redact、SSRF 防护）。
- 让一个 0 技术背景商家在 3 分钟内从模板启用第一条自动化。

---

## 8. 非目标（Out of Scope）

- Shopify Flow 完整克隆、节点连线画布、任意代码执行。
- AI Agent 自主决策执行 Mutation（AI 仅可辅助配置文案，见 P2 原则红线）。
- 通用 iPaaS / 上百外部集成（MVP 仅 Email + Custom Webhook 两类外部动作）。
- 跨店铺批量编排、团队 RBAC 精细权限（沿用 Embedded App 店铺级会话）。
- 破坏性重构：不换 React Router / Prisma / PostgreSQL / Shopify App SDK / node-cron（委托 16.4）。
- **不开放的高危写操作（决策 2026-11）**：修改商品**价格**（暂不开放）、**删除订单**（不进入 MVP）。下架商品可以做，但默认需人工确认（见 §20.1）。
- 复杂条件嵌套表达式（首版仅一层 AND/OR）、Workflow Canvas、AI Agent 自主执行——属 Stage 2/3，不在首发。

---

## 9. V1.x 功能审查（摘要）

完整逐模块审查见 `docs/V1-TO-V2-MIGRATION.md` §1。要点：

- IMPLEMENTED 可复用：OAuth/Session、`adminGraphql`（API Gateway 基座）、`shopify-throttle` 限流退避、`DataSyncJob.activeKey @unique` 跨进程任务锁 + 租约回收、node-cron worker（noOverlap + 优雅退出）、`RecommendationAudit.requestKey` 幂等范式、`purgeShopBusinessData` 合规删除、analytics、库存纯计算函数。
- PARTIALLY：Webhook（有路由壳 + "重算幂等"，但**无 delivery-id 去重表**、无分层）。
- NOT IMPLEMENTED（V2 新建）：Shop 租户模型、Automation/Version、Trigger/Condition/Action Registry、WebhookDelivery、ExecutionLog/Step、Integration、ScheduledJob、DSL、Loop Protection、SSRF 防护、Email/Webhook 发送运行时。
- 事实提醒：**`Session.shop` 无唯一约束**，V2 必须引入独立 `Shop` 模型做租户键。

---

## 10. V1.x → V2.0 迁移矩阵（摘要）

见 `docs/V1-TO-V2-MIGRATION.md` §2/§3。核心处置：OAuth 全保留、API Client→API Gateway、Webhook→Event Ingestion Hub、Worker→Execution Engine、Inventory→可选数据服务、Recommendation→模板/Action、Data Health→Integrations Health、RecommendationAudit 幂等范式→ExecutionLog、Suppliers/Purchase Plans 隐藏保数据、Product Copy 继续停用、Analytics 扩展。**不删旧表，保护 Session，避免重授权。**

---

## 11. V2.0 产品信息架构

五个一级导航（Embedded App Home 内）：

1. **Automation Center**（默认首页）— 价值与系统状态总览。
2. **Templates** — 预置自动化模板库。
3. **My Automations** — 已创建自动化的管理 + 向导编辑器。
4. **Activity Logs** — 完整执行记录。
5. **Integrations** — 外部连接与系统健康。

导航由 V1 的多入口收敛为以上五项；Suppliers/Purchase Plans/Copy 从导航移除但路由保留兼容（隐藏）。

---

## 12. 核心业务流程

主链路（端到端一次触发）：

```
Shopify Webhook / Scheduler
   → Event Ingestion Hub（收 + 快速 200）
   → HMAC Verification（库校验 + 头校验）
   → Event Normalization（REST payload → 标准事件对象）
   → Webhook Deduplication（WebhookDelivery, by X-Shopify-Webhook-Id）
   → Source Filtering / Loop Protection
   → Automation Matcher（按 shop + triggerType 找 active 自动化）
   → Condition Evaluator（纯函数，AND/OR 一层）
   → Execution Queue（持久 job，防重复消费）
   → Action Executor（走 API Gateway / Integration，逐步）
   → Execution Logger（ExecutionLog + ExecutionStep）
   → Activity Logs（前端可读）
```

每层输入/输出/职责/超时/幂等/日志/重试详见 §22–§25。用户侧流程：浏览模板 → Use Template → 填必要参数 → 权限检查 → 预览/测试 → Enable；或 My Automations 向导 When/If/Then/Review 创建。

---

## 13. Automation Center 需求

**页面目标**：让商家一眼看到自动化的价值与系统健康，并快速开始。

指标卡（统计定义见 §13.1）：Total Tasks Run、Estimated Time Saved、Active Automations、Failures Last 24h、Recent Activity、Quick Start、Automation Health、Template Recommendations。

用户操作：查看总览、进入模板推荐、一键启用 Quick Start 模板、跳转失败记录。

### 13.1 指标统计口径

| 指标 | 定义 | 计算 |
|---|---|---|
| Total Tasks Run | 成功执行的动作步骤累计数 | `count(ExecutionStep where status=SUCCESS)`（近全量，可按 shopId） |
| Active Automations | 当前 active 的自动化数 | `count(Automation where status=active)` |
| Failures Last 24h | 24h 内 FAILED/PARTIAL_SUCCESS 的执行数 | `count(ExecutionLog where status in (FAILED,PARTIAL_SUCCESS) and createdAt > now-24h)` |
| Estimated Time Saved | 见下折算规则 | `Σ 成功步骤 × 该 Action 节省分钟` |
| Automation Health | 近 7d 成功率分档 | `成功执行 / 总执行`，>95% 健康 / 80-95% 注意 / <80% 异常 |
| Recent Activity | 最近 N 条执行摘要 | `ExecutionLog orderBy createdAt desc limit 10` |

**Estimated Time Saved 折算规则（委托 5.1）**：每种 Action 有可配置的 `minutesSaved` 默认值，不得随意估算。默认表：

| Action | 默认 minutesSaved |
|---|---|
| Add Tags / Remove Tags | 0.5 |
| Send Email | 2 |
| Send Custom Webhook | 1 |
| Update Product Status | 3 |

默认值内置为常量，未来可在 Shop 级配置覆盖（P2）。计算只统计 SUCCESS 步骤，SKIPPED/FAILED 不计。

数据来源：全部来自 `ExecutionLog`/`ExecutionStep`/`Automation` 聚合；Loader 见 §28。

---

## 14. Templates 需求

**页面目标**：低门槛发现并启用自动化。

分类：Orders / Customers / Inventory / Products / Risk & Operations。

模板卡片字段：名称、功能描述、解决的问题、Trigger、Condition、Action、流程预览、配置难度（Easy/Medium）、`Use Template`。

**Use Template 流程**：点击 → 侧边抽屉（Slide-over Sheet）→ 仅填必要参数 → 参数校验 → 权限检查（缺 scope 时明确提示需重新授权范围）→ 预览（自然语言摘要）→ 测试（Dry-run，用样例事件跑 Condition，不执行 Mutation）→ Enable（创建 `Automation` + `AutomationVersion`）。

必须设计：
- **参数校验**：每个模板的 `paramsSchema`（见 §21 DSL）驱动表单校验，类型/范围/必填。
- **默认值**：模板带默认参数（如 VIP 阈值 $300）。
- **模板版本管理**：模板随代码发布，带 `templateVersion`。
- **启用前权限检查**：比对所需 scope 与当前 Session.scope，不足则引导扩权（不静默失败）。
- **启用失败处理**：可读错误 + 不落半态。
- **模板更新 vs 已有自动化**：模板升级**不自动覆盖**用户已建自动化（保护确定性）；提供"基于新版重新配置"的显式动作，老自动化保持其 `AutomationVersion` 快照运行。

首发 10 模板见 §32。

---

## 15. My Automations 需求

**列表列**：Automation Name、Trigger、Status、Runs Today、Success Rate、Last Run、Created At、Actions。

支持操作：Create / Edit / Pause / Resume / Duplicate / Delete / View Logs。

**向导编辑器**（No-code）：
- Step 1 **When**：选 Trigger（仅列可用且已授权的 trigger）。
- Step 2 **If**：设 Conditions（字段白名单下拉 + 运算符 + 值；AND/OR 一层，不无限嵌套）。
- Step 3 **Then**：设 Actions（可多步，有序）。
- Step 4 **Review & Enable**：生成自然语言摘要，如 *"When an order is created, if order total is greater than $500, add VIP tag and notify the store owner."*

业务规则：
- Delete 为软删（`status=deleted`），保留历史 ExecutionLog。
- Edit 生成新 `AutomationVersion`，旧执行记录仍指向旧版本（可确定性回放/审计）。
- Pause 立即停止匹配（Matcher 只取 active）。
- 空状态：无自动化时引导去 Templates。

---

## 16. Activity Logs 需求

**页面目标**：完整、可追溯、可操作的执行记录。

筛选：时间、自动化、执行状态、Trigger 类型、实体 ID 搜索。

详情抽屉：Payload 查看（脱敏后）、Condition Evaluation 查看（命中/未命中及原因）、Action Step 逐步结果、Retry、**Retry Failed Steps Only**。

执行状态机（进入/退出条件）：

| 状态 | 进入条件 | 退出条件 |
|---|---|---|
| SUCCESS | 所有已排步骤均成功 | 终态 |
| SKIPPED | Condition 判定为 false（未命中） | 终态 |
| FAILED | 存在步骤失败且无可继续部分 | 可→RETRYING（用户/自动重试） |
| PARTIAL_SUCCESS | 多步中部分成功部分失败（非分布式事务） | 可→RETRYING（仅重试失败步） |
| RETRYING | 触发重试，新建子 ExecutionLog（parentExecutionId） | 子执行落定 → 父保持原状态，新记录 SUCCESS/FAILED/PARTIAL |

重试限制：最大自动重试次数（默认 3，指数退避）；超过转死信（FAILED，需手动补偿）。重试**新建记录不改原始记录**，父子关联，防重复 Mutation（见 §24/§25）。

---

## 17. Integrations 需求

**页面目标**：管理外部连接与系统健康。MVP 支持三类：

1. **Shopify Connection** — 展示当前店铺授权状态、scopes、连接健康（复用 Data Health 逻辑，见迁移 §1.7）。
2. **Email Notification** — 平台级发送服务（优先研究 **Resend** 或 **SendGrid**）。
3. **Custom Webhook** — 商家自有 HTTPS 端点接收事件。

设计项：连接状态、配置向导、测试连接、修改配置、删除连接、**密钥加密存储**、连接失败提示、外部 API 超时、重试机制。

**Email 约束（委托 5.5）**：
- 用**平台级发送账号**，不得把用户邮箱直接视为"已具备任意邮件发送能力"。
- 需说明：成本、配额、**域名验证（SPF/DKIM）**、发件人身份（from 地址）、退信处理（bounce webhook）。
- MVP 采用 app 自有已验证域名发件，收件人为商家配置的运营邮箱；商家不能自定义任意 from。

**Custom Webhook 约束**：出站必须做 **SSRF 防护**（§30）：禁内网/localhost/云元数据地址（169.254.169.254 等）、禁危险协议（仅 https）、解析后校验 IP、考虑 DNS Rebinding（解析后再次校验实际连接 IP）。

---

## 18. Trigger Registry 规格

统一 Trigger Registry（可扩展注册表，非 switch-case）。首版：

| Trigger | 优先级 | Shopify 机制 | 必需权限 | 关键数据字段 | 标准化 payload | 延迟 | 可重放 | 审批 |
|---|---|---|---|---|---|---|---|---|
| Order Created | P0 | webhook `orders/create` | read_orders | `id`, `total_price`, `customer`, `shipping_address`, `risks` | OrderEvent | 秒级；**无序保证缺失** | 是（去重后） | **Protected data 审批（R1）** |
| Order Paid | P0 | webhook `orders/paid` | read_orders | `id`, `total_price`, `financial_status` | OrderEvent | 秒级 | 是 | **审批（R1）** |
| Order Cancelled | P0 | webhook `orders/cancelled` | read_orders | `id`, `cancel_reason`(枚举 CUSTOMER/DECLINED/FRAUD/INVENTORY/OTHER) | OrderEvent | 秒级 | 是 | **审批（R1）** |
| Customer Created | P0 | webhook `customers/create` | **read_customers**（当前未申请） | `id`, `note`, tags, （company → 待验证 OQ） | CustomerEvent | 秒级 | 是 | **审批（R1）+ 新 scope** |
| Product Updated | P1 | webhook `products/update` | read_products（写需 write_products） | `id`, `variants[].price`, `status` | ProductEvent | 秒级 | 是 | 否（非 protected） |
| Inventory Low | P1 | **无通用低库存 webhook**：基于 `inventory_levels/update`（已订阅，read_inventory）+ 定时巡检计算 available ≤ 阈值 | read_inventory | `location_id`, `inventory_item_id`, `new` | StockLevelEvent | 秒级 + 巡检 | 是 | 否 |
| Daily Schedule | P2 | worker node-cron（复用现有 cron + activeKey 锁） | — | 商家时区/日期范围 | ScheduledEvent | 按调度 | n/a | 否 |

**Inventory Low 重要说明（委托 6.2）**：Shopify **不提供**通用"低库存"webhook。`inventory_levels/update` 只在库存层级变动时推 `new` 数量，且 **payload 只保证给到地点，变体需回读**（迁移 §1.3 实证）。V2 实现：以 `inventory_levels/update` 为失效信号 → 回 Admin API 重算 available（复用 `inventory-calculations.ts`）→ 与阈值比较 → 命中则视为 Inventory Low trigger。可用阈值/地点/SKU 口径见模板 #4。

每种 Trigger 的 `VERIFIED / 待验证` 归属见 `docs/V2-OPEN-QUESTIONS.md`；未 VERIFIED 的进 MVP 需挂验收前置条件。

---

## 19. Condition Evaluator 规格

统一条件引擎，**纯函数**实现（无副作用、可单测、确定性 P2）。

运算符：`equals, not_equals, greater_than, greater_than_or_equal, less_than, less_than_or_equal, contains, not_contains, is_empty, is_not_empty, in, not_in`。

逻辑组合：`AND`, `OR`（**一层，不无限嵌套**）。

设计项：
- **字段白名单**：按 Trigger 类型定义可读字段集（如 OrderEvent → total_price, currency, risk_level, cancel_reason, shipping_country, customer.tags…）。白名单外的字段直接判为无效（见下）。
- **类型校验**：字段声明类型（number/string/bool/date/array）；运算符与类型匹配（如 `greater_than` 不接受 array）。
- **数值转换**：金额/数量统一转 number；货币不参与隐式换算（比较的是原始数值，跨币种的阈值语义在模板层说明）。
- **空值处理**：`is_empty/is_not_empty` 显式判空；其余运算符遇 null 按规则返回 false 而非抛错。
- **时区处理**：日期比较以 Shop.timezone 归一；payload 时间戳为 UTC，比较前转店铺时区（模板 #10 尤其）。
- **日期比较**：`greater_than_or_equal` 等支持 ISO 日期。
- **数组比较**：`contains/not_contains/in/not_in` 作用于数组字段（如 tags）。
- **无效字段处理**：引用白名单外字段 → 条件判 false + 记 evaluation 说明（不 crash、不误执行）。
- **计算结果说明**：每次求值产出 `{result: boolean, clauses: [{field, op, expected, actual, pass}]}`，写入 ExecutionLog 供 Activity Logs "Condition Evaluation" 展开。

---

## 20. Action Registry 规格

可扩展 Action Registry（每个 Action 是注册对象，禁止大 switch-case）。首版：

| Action | 优先级 | 底层能力 | 必需权限 | 幂等策略 |
|---|---|---|---|---|
| Add Tags | P0 | GraphQL `tagsAdd`（支持 Order/Customer/Product/DraftOrder/Article/DiscountNode） | 对应资源写 scope（write_orders / write_customers / write_products — 确切文案待验证 OQ） | tagsAdd 天然幂等（重复加同一 tag 无副作用）；执行前读现有 tags |
| Remove Tags | P0 | GraphQL `tagsRemove` | 同上 | 幂等；不存在则 no-op 成功 |
| Send Email | P0 | 平台发送服务（Resend/SendGrid） | Integration 配置 | 以 ExecutionStep id 为去重键；重发需新记录 |
| Send Custom Webhook | P1 | HTTPS 出站（SSRF 防护） | Integration 配置 | 携带幂等键 header；接收方负责 |
| Update Product Status | P1 | GraphQL `productUpdate`（status ACTIVE/DRAFT/ARCHIVED） | write_products | 先读 status，目标态一致则跳过 |

每个 Action 定义：Action ID、参数 Schema、参数默认值、必需权限、输入 Payload、执行结果、错误类型、超时、重试策略、幂等策略、**风险等级与默认执行策略**（§20.1）、**用户可读错误信息**（P3：不得直抛 GraphQL 堆栈）。

`tagsAdd`/`tagsRemove` 支持资源、orders/paid 与 customers/create 所需 scope 均已核实（见 V2-OPEN-QUESTIONS.md VERIFIED 段）；唯逐资源写 scope 的确切字符串标记为待验证。

### 20.1 执行风险分级与人工确认（产品负责人决策 2026-11，落实 P6）

每个 Action 注册时声明 `riskLevel`，引擎据此决定执行策略；高风险动作在 `ExecutionStep` 上落 `AWAITING_CONFIRMATION` 状态，等待商家在 Activity Logs / Automation Center 确认后才执行 Mutation。

| 操作类型 | Action | riskLevel | 默认策略 |
|---|---|---|---|
| 添加标签 | Add Tags | low | **自动执行** |
| 发送通知（Email / Webhook） | Send Email / Send Custom Webhook | low | **自动执行** |
| 删除标签 | Remove Tags | low | **自动执行**（可逆、影响面小） |
| 下架商品（改状态 DRAFT/ARCHIVED） | Update Product Status | **high** | **默认需人工确认**（每步待确认，商家点击后才执行） |
| 修改商品价格 | —（不提供） | — | **暂不开放**（不实现该 Action） |
| 删除订单 | —（不提供） | — | **不进入 MVP**（危险且 Shopify 端不可逆） |

规则：
- `riskLevel=low` ⇒ 排到即执行（仍受 §24 防循环与幂等约束）。
- `riskLevel=high` ⇒ 步骤进入 `AWAITING_CONFIRMATION`，人工确认超时（默认 24h，可配置）后按策略转 `FAILED`（放弃）或保持待确认；确认动作写入 ExecutionStep（操作者=merchant）。
- 高风险模板（如 T8 下架）启用时，Review 步骤必须显式展示"该自动化会修改店铺数据，已开启需确认模式"的提示（Confirmation Gate）。
- 未来新增 Action 必须显式声明 riskLevel，缺省视为 high（安全默认）。

---

## 21. Automation DSL

统一 JSON DSL 描述 Automation Definition。要求：版本号、Trigger、Conditions、Actions、参数 Schema、模板引用、规则版本、启停、向后兼容。

### 21.1 顶层结构

```jsonc
{
  "dslVersion": "2.0",            // DSL schema 版本，向后兼容用
  "automationId": "auto_xxx",     // 运行时填充
  "templateRef": {                // 可选，模板溯源
    "templateId": "high-value-order-vip",
    "templateVersion": "1.0.0"
  },
  "name": "High-value VIP Tagging",
  "status": "active",             // active | paused | deleted
  "trigger": {                    // 见 Trigger Registry
    "type": "order.created",
    "source": "shopify.webhook",  // shopify.webhook | scheduler
    "topic": "orders/create"
  },
  "conditions": {                 // 一层组合
    "logic": "AND",
    "clauses": [
      { "field": "total_price", "op": "greater_than_or_equal", "value": 300, "type": "number" }
    ]
  },
  "actions": [                    // 有序多步
    { "actionId": "tags.add", "target": "customer", "params": { "tags": ["VIP"] } },
    { "actionId": "tags.add", "target": "order",    "params": { "tags": ["High-Value"] } }
  ]
}
```

### 21.2 完整示例（委托 6.5 要求的三个）

**① High-value Order VIP Tagging**（结构同上 §21.1）。

**② High-value Order Email Alert**（Order Paid, total ≥ $500 → 发邮件）：
```json
{
  "dslVersion": "2.0",
  "name": "High-value Order Alert",
  "status": "active",
  "trigger": { "type": "order.paid", "source": "shopify.webhook", "topic": "orders/paid" },
  "conditions": { "logic": "AND", "clauses": [
    { "field": "total_price", "op": "greater_than_or_equal", "value": 500, "type": "number" }
  ]},
  "actions": [
    { "actionId": "email.send", "params": { "to": "{{shop.opsEmail}}", "template": "high_value_alert" } }
  ]
}
```

**③ Low Stock Notification**（Inventory Low，available ≤ 5 → 通知采购）：
```json
{
  "dslVersion": "2.0",
  "name": "Low Stock Emergency",
  "status": "active",
  "trigger": { "type": "inventory.low", "source": "shopify.webhook+reconcile", "topic": "inventory_levels/update" },
  "conditions": { "logic": "AND", "clauses": [
    { "field": "available", "op": "less_than_or_equal", "value": 5, "type": "number" }
  ]},
  "actions": [
    { "actionId": "email.send", "params": { "to": "{{shop.buyerEmail}}", "template": "low_stock", "vars": ["sku","available","locationName"] } }
  ]
}
```

### 21.3 JSON Schema（节选，完整见实施附件）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AutomationDefinition",
  "type": "object",
  "required": ["dslVersion", "name", "status", "trigger", "actions"],
  "properties": {
    "dslVersion": { "type": "string", "enum": ["2.0"] },
    "trigger": { "type": "object", "required": ["type","source"],
      "properties": { "type": { "enum": ["order.created","order.paid","order.cancelled","customer.created","product.updated","inventory.low","daily.schedule"] } } },
    "conditions": { "type": "object",
      "properties": { "logic": { "enum": ["AND","OR"] },
        "clauses": { "type": "array", "items": { "type":"object", "required":["field","op","value","type"],
          "properties": { "op": { "enum": ["equals","not_equals","greater_than","greater_than_or_equal","less_than","less_than_or_equal","contains","not_contains","is_empty","is_not_empty","in","not_in"] } } } } } },
    "actions": { "type": "array", "minItems": 1, "items": { "type":"object", "required":["actionId","params"],
      "properties": { "actionId": { "type": "string" }, "params": { "type": "object" },
        "riskLevel": { "enum": ["low","high"], "default": "high" },
        "confirmation": { "enum": ["auto","required"], "default": "required" } } } }
  }
}
```

### 21.4 职责边界

- **校验（Validation）**：启用前，DSL 结构 + JSON Schema + 字段白名单 + 类型匹配 → 拒绝非法定义（不落库半态）。
- **编译（Compile）**：DSL → 运行时计划（trigger matcher key、condition clause 序列、action step 序列 + 每步 `riskLevel`/`confirmation`，由 Action Registry 派生），冻结进 `AutomationVersion.definition`。
- **执行（Execute）**：引擎只消费编译后计划，不在运行时解释业务语义（保证 P2 确定性 + 版本可回放）。

---

## 22. Automation Engine 架构

分层管道（§12 链路），复用 V1 稳定件：

| 层 | 复用/新建 | 说明 |
|---|---|---|
| Event Ingestion Hub | 复用 `webhooks.*` 路由壳 + 库 HMAC | 快速 200，重活异步 |
| HMAC Verification | 复用库（shopify-app-react-router 已做） | 见 §23 |
| Event Normalization | **新建** TriggerNormalizer（纯函数） | REST/GraphQL 两种 id 形状归一（迁移 §1.3 `toGid` 已验证此模式） |
| Webhook Deduplication | **新建** `WebhookDelivery` | 见 §23 |
| Source Filtering / Loop Protection | **新建** | 见 §24 |
| Automation Matcher | **新建** | `Automation where shopId + triggerType + status=active` |
| Condition Evaluator | **新建**（纯函数，§19） | |
| Execution Queue | 复用 `DataSyncJob.activeKey @unique` 锁范式 | 防并发重消费 + 租约回收 |
| Action Executor | 复用 `adminGraphql`（API Gateway）做 Shopify 写；新建 Email/Webhook 出站 | |
| Execution Logger | **新建** ExecutionLog/Step | |

---

## 23. Webhook Ingestion 设计

### 23.1 安全（委托 7.1）
- HMAC-SHA256：用**原始 request body** 验签（不可先 JSON.parse 再重序列化）。库层已提供，V2 显式校验 `X-Shopify-Hmac-Sha256`。
- 校验头：`X-Shopify-Topic`、`X-Shopify-Webhook-Id`、`X-Shopify-Source`（IP，可选）。
- 校验 shop domain 与 Session 存在且匹配，拒绝伪造/跨店。
- **快速返回 HTTP 200**（先入队再处理），异步执行自动化。

### 23.2 幂等与去重（委托 7.2）
- 以 **`X-Shopify-Webhook-Id`** 为去重键（官方明确：*"ignore duplicate deliveries using X-Shopify-Webhook-Id"* — VERIFIED）。
- `WebhookDelivery.webhookId @unique`：入库撞唯一索引即判重复。沿用 `RecommendationAudit.requestKey @unique` 生产验证范式。
- 默认保留 **24h** 去重记录（后台按 receivedAt TTL 清理）。
- 处理：并发重复（唯一索引 + 事务）、Worker 崩溃（记录与执行分离，租约回收）、DB 事务失败（去重写与入队同事务或 outbox）、Webhook 重放（24h 窗口内命中即丢）、同一订单短时多次更新（按 deliveryId 各自独立，各自幂等）。
- **不得只用进程内 Map**（跨进程/重启失效）。
- 补充（官方）：webhook **不保证顺序**、**不保证必达**，可能漏发 → 保留**对账/巡检 job**（复用 cron），与 V1 "重算式" 兜底一致。

---

## 24. 幂等与循环防护（Loop Protection，委托 7.3）

问题：Automation 改商品标签 → Shopify 再发 `products/update` → 同一自动化再执行 → 循环。

分层防护（区分可靠性等级，委托要求）：

1. **Webhook 去重**（强可靠）：同 deliveryId 只处理一次（§23）。防重投，不防连锁。
2. **来源标识 + Trace ID**（**降风险，非保证**）：mypi 发起的 Mutation 携带 requestSource / 自定义 tag 前缀（如 `auto:`），并在执行记录写 traceId。**注意红线：Shopify 不保证把 mypi 自定义标记回传到后续 webhook**（委托 7.3 / 迁移 R5），故来源过滤只能尽力而为。
3. **事件内容指纹**（降风险）：对 `(automationId, entityType, entityId, 关键字段hash)` 计算指纹，在时间窗内相同指纹视为无实质变化 → 跳过（避免"改了个无关字段又触发"）。
4. **自动化级循环保护**（强可靠）：同一 entityId 在同一自动化下 N 分钟内最多触发 K 次（令牌桶/计数），超限停止。
5. **最大级联深度**（强可靠）：事件携带 `cascadeDepth`（由执行记录链传播），超过 maxDepth（默认 3）停止并记录原因。
6. **时间窗口限制**：冷却期内同实体重复事件合并。

**结论**：能可靠实现的是 去重表 / 自动化级限次 / 最大级联深度 / 时间窗；只能降风险的是 来源标识 / 内容指纹；Shopify 原生事件**无法保证**的是"把我的标记带进后续 webhook"。E2E 场景 E 验证级联超限停止。

---

## 25. 失败处理与重试

### 25.1 Rate Limiting（委托 7.4）
- Shopify GraphQL 成本额度模型 → **直接复用** `adminGraphql` + `shopify-throttle`：单店退避封顶 5s、`resolveTries`、`throttleWaitMs`（VERIFIED，V1 生产在用）。
- 补：Retry-After 处理（已有）、**随机抖动**（新增 jitter）、任务优先级（P0 通知类优先于批量巡检）、**店铺间隔离**（按 shopId 分桶，单店打爆不影响他店，与 activeKey 锁天然对齐）。

### 25.2 Partial Success（委托 7.5）
- 多 Action **不作为分布式事务**。每步独立结果写 `ExecutionStep`。
- 例：Add Tag 成功 / Send Email 失败 / Send Webhook 成功 ⇒ `ExecutionLog.status=PARTIAL_SUCCESS`，三步各自状态留存。
- 支持：重试整任务（受最大次数限制）、**仅重试失败步骤**、保留原始记录、重试新建子记录（parentExecutionId 关联父子）、防重复 Mutation（步骤幂等 §20）。
- **超时不等于失败**：外部服务已执行但 mypi 未收到响应时，步骤标 `UNKNOWN`/待确认，不得武断判失败重发（防重复 Mutation/重复邮件）。恢复策略：查询回读（可查的 Action）或标记需人工确认。

### 25.3 Worker 崩溃恢复（委托可用性）
- 复用租约回收 `reapStaleRunningJobs`/`leaseCutoff`：RUNNING 超租约被回收，不永久卡 RUNNING（E2E 场景 G）。
- 已成功 Action 不无条件重跑：靠 ExecutionStep 状态 + 幂等键。

---

## 26. 数据库模型

见 `docs/V1-TO-V2-MIGRATION.md` §3.2 全表定义。要点复述：新增 `Shop`/`Automation`/`AutomationVersion`/`WebhookDelivery`/`ExecutionLog`/`ExecutionStep`/`Integration`/`ScheduledJob`（`AutomationTrigger` 可选，若 DSL 纯 JSON 存储则不建，避免过度设计）。旧 16 表全保留。租户键走 `shopId`（因 Session.shop 不唯一）。

关系（委托 §9 十问逐答）：
1. Shop 1—N Automation（Cascade 删）。
2. Automation 1—1 当前 AutomationVersion；1—N 历史版本。
3. Automation 1—N Actions（存于 Version.definition JSON，非独立表）。
4. Automation 1—N ExecutionLog。
5. ExecutionLog 1—N ExecutionStep（Cascade）。
6. ExecutionLog.parentExecutionId 自关联 = 重试父子。
7. WebhookDelivery N—1 Shop（或按 shop 域名 + 24h TTL）。
8. Integration N—1 Shop（每类连接可多条，密钥密文）。
9. 跨店隔离：所有查询强制 `where shopId`，Loader 从会话解析 shopId，禁止裸查（E2E 场景 F）。
10. 索引：见 §27 各表 `@@index`（shopId+status、shopId+createdAt、entityId、webhookId unique、activeKey unique 等）。

---

## 27. Prisma Schema V2 Draft

> Additive 草案，与旧 schema 并存；旧表定义见现有 `prisma/schema.prisma`，此处只列 V2 新增。

```prisma
model Shop {
  id             String   @id @default(cuid())
  shop           String   @unique   // myshopify 域名；Session.shop 不唯一，租户以本表为准
  timezone       String   @default("UTC")
  currencyCode   String   @default("USD")
  primaryCountry String?
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  automations  Automation[]
  deliveries   WebhookDelivery[]
  executions   ExecutionLog[]
  integrations Integration[]
  schedules    ScheduledJob[]
}

model Automation {
  id        String   @id @default(cuid())
  shopId    String
  name      String
  status    String   @default("paused")   // active | paused | deleted
  currentVersionId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  shop     Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  versions AutomationVersion[] @relation("AutomationVersions")
  logs     ExecutionLog[]

  @@index([shopId, status])
}

model AutomationVersion {
  id           String  @id @default(cuid())
  automationId String
  version      Int
  definition   Json     // 编译冻结的 DSL（trigger/conditions/actions）
  templateId   String?
  templateVersion String?
  createdAt    DateTime @default(now())

  automation Automation @relation("AutomationVersions", fields: [automationId], references: [id], onDelete: Cascade)

  @@unique([automationId, version])
}

model WebhookDelivery {
  id         String   @id @default(cuid())
  shopId     String?
  shop       String
  webhookId  String   @unique   // X-Shopify-Webhook-Id
  topic      String
  receivedAt DateTime @default(now())

  shopRef Shop? @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([receivedAt])   // 24h TTL 清理
  @@index([shop, topic, receivedAt])
}

model ExecutionLog {
  id                String   @id @default(cuid())
  shopId            String
  automationId      String
  automationVersion Int
  triggerType       String
  entityRef         String?   // GID，用于实体搜索
  dedupeKey         String?   @unique   // 防重复执行落账
  status            String    // SUCCESS | FAILED | PARTIAL_SUCCESS | SKIPPED | RETRYING
  cascadeDepth      Int       @default(0)
  conditionResult   Json?
  payload           Json?     // 脱敏后
  parentExecutionId String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  shop       Shop  @relation(fields: [shopId], references: [id], onDelete: Cascade)
  automation Automation @relation(fields: [automationId], references: [id], onDelete: Cascade)
  parent     ?ExecutionLog @relation("ExecRetry", fields: [parentExecutionId], references: [id], onDelete: SetNull)
  children   ExecutionLog[] @relation("ExecRetry")
  steps      ExecutionStep[]

  @@index([shopId, automationId, createdAt])
  @@index([shopId, status, createdAt])
  @@index([shopId, entityRef])
}

model ExecutionStep {
  id          String   @id @default(cuid())
  executionId String
  order       Int
  actionId    String
  status      String    // SUCCESS | FAILED | SKIPPED | UNKNOWN | PENDING | AWAITING_CONFIRMATION
  result      Json?
  errorText   String?   // human-readable
  createdAt   DateTime  @default(now())

  execution ExecutionLog @relation(fields: [executionId], references: [id], onDelete: Cascade)

  @@unique([executionId, order])
}

model Integration {
  id              String   @id @default(cuid())
  shopId          String
  kind            String    // SHOPIFY | EMAIL | CUSTOM_WEBHOOK
  status          String    @default("unverified") // unverified | healthy | failing
  config          Json      // 非敏感配置（收件人/URL/模板名）
  secretsEncrypted String?  // 密文；明文永不入库/日志
  lastTestedAt    DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, kind])
}

model ScheduledJob {
  id           String   @id @default(cuid())
  shopId       String
  automationId String
  cadence      String    // daily | cron
  dailyTime    String?   // HH:mm 店铺时区
  timezone     String
  lastRunAt    DateTime?
  nextRunAt    DateTime?
  activeKey    String?   @unique   // 复用 DataSyncJob 跨进程锁范式
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, nextRunAt])
}
```

检查项落实：外键（全部 `shopId` FK + Cascade）、唯一约束（Shop.shop、WebhookDelivery.webhookId、ExecutionLog.dedupeKey、AutomationVersion(automationId,version)、ExecutionStep(executionId,order)、ScheduledJob.activeKey）、索引（列表/筛选路径）、Cascade（Shop→全部；Automation→Log→Step）、枚举（DB 层用 String + 应用层常量，沿用 V1 风格避免 Prisma enum 迁移摩擦）、JSON 字段（definition/conditionResult/payload/config）、迁移兼容性（全 additive，见迁移 §3）。

---

## 28. UI/UX 设计规范

沿用 Shopify Embedded App + 现有技术体系（React Router、`app/components/ui/*`、`app/styles/tokens.css`）。统一：导航、页面容器、标题与操作区、卡片、Badge、Empty State、Loading、Error State、Confirmation Dialog、Toast、Slide-over Sheet、表单校验（委托 §10）。

每页均按 **目标 / 用户操作 / 组件 / 数据来源 / Loader / Action / 状态管理 / 空状态 / 异常状态 / 权限控制 / 验收** 定义。以下给五页要点（完整组件层级交前端实施，禁止只给概念）：

**Automation Center**：`CardGrid`（4 指标卡）+ `AutomationHealthBanner` + `RecentActivityList` + `QuickStartTemplates`。Loader：聚合 `ExecutionLog/Step/Automation`（§13.1）。Action：启用推荐模板（跳抽屉）。空状态：无自动化 → CTA "Start from a template"。异常：Failures>0 → Banner 引导 Activity Logs。

**Templates**：`CategoryTabs` + `TemplateCardGrid`（卡片含难度 Badge）+ `TemplateDrawer`（参数表单，由 paramsSchema 驱动）+ `DryRunPreview`（自然语言摘要）+ `PermissionGate`（缺 scope 提示）。Loader：模板清单 + 当前 Session.scope。Action：`useTemplate` → 建 Automation+Version。异常：权限不足 → 阻断 Enable 并说明。

**My Automations**：`DataTable`（列 §15）+ `StatusBadge` + `RowActions`（Pause/Resume/Duplicate/Delete）+ `WizardEditor`（When/If/Then/Review 四步）。Loader：`Automation where shopId`。Action：CRUD + toggle status。异常：Edit 冲突 → 新版本而非覆盖。

**Activity Logs**：`FilterBar`（时间/自动化/状态/trigger/实体搜索）+ `DataTable` + `LogDetailDrawer`（Payload Inspector + Condition Evaluation + Step 列表）+ `RetryActions`（Retry / Retry Failed Only）。Loader：`ExecutionLog where shopId + 分页`。异常：payload 脱敏显示；UNKNOWN 步骤标"待确认"。

**Integrations**：`ConnectionCards`（三类的状态 Badge）+ `ConfigWizard` + `TestConnection` + `DeleteConnection`。Loader：`Integration where shopId` + Shopify 健康。Action：建/改/测/删连接（密钥写入即加密，读接口永不回传明文）。异常：连接失败 → 可读原因 + 重试。

权限控制：全部 Loader 从嵌入会话解析 `shopId` 并强制过滤；跨店访问直接 403/空（E2E 场景 F）。

---

## 29. API 与服务接口设计

服务端模块（`.server.ts`）契约（研发实施基准）：

- `automation-engine/normalizer.server.ts` — `normalizeEvent(topic, rawBody) → StandardEvent`（纯）。
- `automation-engine/ingest.server.ts` — `ingestWebhook({shop, topic, webhookId, hmac, body}) → {accepted, duplicate}`（验签 + 去重 + 入队）。
- `automation-engine/matcher.server.ts` — `matchAutomations(shopId, triggerType) → ActiveAutomation[]`。
- `automation-engine/evaluator.server.ts` — `evaluateConditions(clauses, event) → {result, clauses[]}`（纯函数）。
- `automation-engine/executor.server.ts` — `executeActions(version, event) → ExecutionLog+Steps`（走 API Gateway / Integration）。
- `automation-engine/loop-protector.server.ts` — `check({automationId, entityId, fingerprint, cascadeDepth}) → allow|throttle|block`。
- `api-gateway`（复用 `adminGraphql`）— 增 `adminGraphqlWrite(admin, mutation, {requestSource})`。
- `integrations/email.server.ts` — `sendEmail(integration, template, vars)`。
- `integrations/outbound-webhook.server.ts` — `postToUrl(integration, payload)`（SSRF 守卫）。
- 路由层：`app/routes/app.automations.tsx`（Center）、`.templates.tsx`、`.my-automations.tsx`、`.activity-logs.tsx`、`.integrations.tsx`；`webhooks.orders.*`/`customers.*`/`products.*` 接 ingest。

---

## 30. 权限与安全设计

- **Scope 清单**：现有 `read_products,read_inventory,read_orders,read_locations`；V2 需增 `read_customers`（Customer Created trigger）、`write_orders`（Order Tag）、`write_customers`（Customer Tag）、`write_products`（Product Status / tags on product）。扩权 = App Store 审核项，遵循最小化（迁移 R3）。逐资源写 scope 确切文案 → OQ 待验证。
- **Secret 加密**：Access Token（Session 现由库管理）、Email API Key、Custom Webhook Secret 一律 `secretsEncrypted` 存储，明文不入 DB 列/日志/前端（委托 7.6）。
- **HMAC**：原始 body 验签（§23）。
- **最小权限**：模板启用前按需检查。
- **SSRF 防护**：Custom Webhook 出站仅 https；拒绝内网/localhost/链路本地/云元数据（169.254.169.254、fd00::/8 等）；解析后校验实际 IP；防 DNS Rebinding（连接前二次解析校验 / 固定解析 IP）。
- **日志脱敏**：payload/错误中支付信息、邮箱主体、token 打码；不暴露 Access Token / API Key / 密码 / 完整支付信息。
- **数据删除**：`app/uninstalled` + `shop/redact` + `customers/data_request`/`customers/redact` → `purgeShopBusinessData` **扩展覆盖全部 V2 新表**（迁移 R4）。
- **日志访问隔离**：按 shopId；GDPR 保留期限（ExecutionLog/payload 建议保留期 + 到期清理策略，具体天数 → OQ 由产品定）。

---

## 31. 非功能性需求

**性能**：webhook 快速 200（异步执行）；前端列表分页；执行日志分页；避免大 payload 查询（include_fields / 只存摘要 + 脱敏）；GraphQL Cost 受控（复用退避）。
**可用性**：Worker 崩溃恢复（租约回收）；失败任务恢复；队列持久化（DB job，非内存）；DB 连接恢复（Supabase pooler，见 `db-pool-url.ts`）；任务超时；死信处理（超最大重试转 FAILED 待手动补偿）。
**安全**：见 §30。
**可观测性**：执行日志、任务耗时、失败率、retry 次数、Shopify API Cost、webhook 延迟、worker 健康、队列积压量（扩展 `AnalyticsEvent` + worker healthcheck）。
**扩展性**：更多 Trigger/Action/模板/集成/高级条件/多步/定时（Registry + DSL 版本化承载）。**MVP 不提前做 Workflow Canvas 或 AI Agent**（委托 §11 / 16.3）。

---

## 32. 模板库规格（首发 5 核心 + 扩展 5）

每个模板：ID / 名称 / 分类 / 痛点 / Trigger / Conditions / Actions / 默认参数 / 用户可编辑参数 / 所需权限 / 示例 / 自然语言摘要 / 错误场景 / 验收。以下逐条；**存在 Shopify 权限/数据限制处如实标注**（不虚构，委托 §7 末）。

**首发分层（决策 2026-11）**：10 个模板**不作为上线硬指标一次性交付**。首发聚焦 **5 个核心模板 = {T1 VIP 打标, T2 高价值邮件告警, T7 客户分类, T5 取消订单通知, T4 低库存告警}**，共同特点是易理解、易验证、商家直接感知价值。其余 {T3, T6, T8, T9, T10} 归入**扩展模板库**，随审批/扩权/数据核实进度分批上线。下方仍逐条给全 10 个规格作为模板库基准，每条标注 `LAUNCH` / `EXTENDED`。

> 通用前置：**除 #4/#8 外的多数模板依赖 orders/* 或 customers/* webhook ⇒ 受 R1 审批墙**；未获批前标 `BLOCKED_BY_APPROVAL`，不进入可启用状态。

**T1 High-value Order VIP Tagging**（Orders）— LAUNCH
- Trigger: order.created；Cond: `total_price >= 300`；Actions: tags.add(customer VIP), tags.add(order High-Value)。
- 权限：read_orders, write_orders, write_customers。默认参数 threshold=300，可编辑 threshold/tags。
- 摘要：*"When an order is created and total ≥ $300, tag the customer VIP and the order High-Value."*
- 错误：写 scope 缺失→启用即 PermissionGate 拦截；重复加 tag 幂等。验收：E2E 场景 A。**BLOCKED_BY_APPROVAL（read/write_orders）**。

**T2 High-value Order Manager Alert**（Orders）— LAUNCH
- Trigger: order.paid；Cond: `total_price >= 500`；Action: email.send(merchant)。
- 权限：read_orders + Email Integration。默认 threshold=500。验收：邮件失败→PARTIAL_SUCCESS（场景 C）。**BLOCKED_BY_APPROVAL**。

**T3 Suspected Fraud / High Risk Flag**（Risk & Operations）— EXTENDED
- Trigger: order.created；Cond: `risk_level == HIGH`；Actions: tags.add(order FRAUD_RISK_HOLD), email.send urgent。
- 数据核实：风险数据经 Order `risks` / risk assessment（需 read_orders）。**timing 限制**：风险常异步评估，orders/create 时刻可能尚无最终 riskLevel → 建议 order.paid 或延迟读取（**待验证 OQ**）。权限：read_orders, write_orders。验收：风险缺失时不误判（condition false 记录）。**BLOCKED_BY_APPROVAL**。

**T4 Low Stock Emergency Notification**（Inventory）— LAUNCH
- Trigger: inventory.low（基于 inventory_levels/update + 重算，§18）；Cond: `available <= 5`；Action: email.send(buyer)。
- 口径：阈值可编辑；库存地点口径 = 商家选定 locationId 集合（默认全部 active）；SKU 口径 = variant available（复用 `inventory-calculations.ts`）。权限：read_inventory（**已具备，无审批墙**）。示例：某 SKU 余 3 → 邮件采购。验收：可用 trigger（P1，可随 MVP 后增）。

**T5 Cancelled Order Notification（取消订单通知）**（Orders）— LAUNCH
- Trigger: order.cancelled；Cond: `cancel_reason != FRAUD`；Actions: tags.add(order), email.send digest。
- 数据核实：`cancelReason` 枚举 CUSTOMER/DECLINED/FRAUD/INVENTORY/OTHER（**VERIFIED**）。取消原因来自 webhook payload + 回读。权限：read_orders, write_orders。**BLOCKED_BY_APPROVAL**。

**T6 International Order Router**（Orders）— EXTENDED
- Trigger: order.created；Cond: `shipping_country != shop.primaryCountry`；Action: tags.add(order INTERNATIONAL_CUSTOMS)。
- 权限：read_orders, write_orders。可编辑目标国家集合。验收：国家码归一（ISO2）。**BLOCKED_BY_APPROVAL**。

**T7 Customer Classification（客户分类，B2B/Wholesale）**（Customers）— LAUNCH
- Trigger: customer.created；Cond: `note contains "wholesale"`（**首发用已验证字段**）；可选叠加 `company exists`（依赖 OQ-3 核实后再开）；Action: tags.add(customer WHOLESALE_PENDING)。
- **数据限制**：为避免首发被 OQ-3（customers/create 是否含 company 字段）卡住，**首发判据只用 note / 已有 tags 等已验证字段**；company 分支作为增强，OQ-3 核实后再启用。权限：read_customers, write_customers。**BLOCKED_BY_APPROVAL**。

**T8 Pricing Zero-Error Safety Catch**（Products / 高风险）— EXTENDED
- Trigger: product.updated；Cond: `variant.price <= 0`；Actions: productUpdate(status=DRAFT), email.send urgent。
- 高风险自动改，必须：明确授权（启用前风险提示 + 二次确认）、可选人工确认开关、**防循环**（改 DRAFT 会再发 products/update → §24 指纹+级联深度）、执行审计。权限：read_products, **write_products**（当前未授予）。trigger 非 protected，**无审批墙**，但需 write_products 扩权。验收：E2E 场景 E。

**T9 Backorder / Oversold Identifier**（Orders / Inventory）— EXTENDED
- Trigger: order.paid；检查商品 `inventory_quantity`/是否允许超卖（`inventory_management`, `option`）+ 当前 available。Action: tags.add(order BACKORDERED_WAITING)。
- **数据限制**：需回读事件后库存一致性（webhook 与快照存在时间差 → OQ）。权限：read_orders, read_inventory。**BLOCKED_BY_APPROVAL**。

**T10 Unfulfilled Order 3-Day Reminder**（Orders / Daily）— EXTENDED
- Trigger: daily.schedule（worker cron）；扫 >3 天未发货订单 → email.send daily summary。
- 设计：商家时区（Shop.timezone）；日期范围；订单分页；**重复通知防护**（去重/幂等 + 已提醒标记）；排除已取消/已发货。权限：read_orders（历史窗口受 `read_all_orders` 影响 → R2/OQ）。**BLOCKED_BY_APPROVAL（读订单历史）**。

模板可用性小结：
- **首发 5 核心（LAUNCH）**：T1 VIP 打标、T2 高价值邮件告警、T7 客户分类、T5 取消订单通知、T4 低库存告警。
- **扩展库（EXTENDED）**：T3 高风险标记、T6 国际订单路由、T8 价格归零下架、T9 超卖识别、T10 未发货日报。
- **审批墙现实（务必如实传达）**：首发 5 个里 **T4 无审批墙**（read_inventory 已具备，可先行）；T1/T2/T5/T7 依赖 orders/*、customers/* webhook ⇒ **仍受 R1 阻塞**，审批未过前记为 BLOCKED、不可启用。即"聚焦 5 个"降低的是产品复杂度与验证成本，**并不消除 R1 审批这一外部前置**。
- 高风险动作：T8（下架）按 §20.1 默认需人工确认；价格修改/删除订单不在任何模板中提供。

---

## 33. MVP 能力矩阵

| 能力 | 层级 | 依赖 | 首发可交付性 |
|---|---|---|---|
| OAuth 兼容 | P0 | — | ✅ 复用 |
| Event Ingestion + HMAC | P0 | — | ✅ |
| Webhook 去重（WebhookDelivery） | P0 | — | ✅ 新建 |
| Condition Evaluator（基础比较符） | P0 | — | ✅ 新建 |
| Add/Remove Tags | P0 | write scope + 审批 | ⚠️ 需 R1+R3 |
| Send Email | P0 | Integration | ✅（不依赖订单 scope） |
| Execution Log + Retry | P0 | — | ✅ |
| Pause/Resume | P0 | — | ✅ |
| 多租户隔离（Shop） | P0 | — | ✅ |
| Order/Customer Triggers | P0 | **R1 审批** | ⚠️ 前置阻塞 |
| Product Updated / Update Status | P1 | write_products | 审批无关，需扩权 |
| Inventory Low | P1 | read_inventory | ✅ 已有 scope |
| Custom Webhook + SSRF | P1 | — | 新建 |
| AND/OR 组合、部分成功、Retry Failed Only、Duplicate | P1 | — | 新建 |
| Daily Digest/高级定时 | P2 | — | 后续 |

---

## 34. P0 / P1 / P2 优先级

**P0（首发必须）**：OAuth 兼容；Automation Center；Templates；My Automations；Activity Logs；Order Created/Paid/Cancelled/Customer Created trigger；**Inventory Low trigger（read_inventory，无审批，支撑 T4）**；基础 Conditions；Add/Remove Tags；Send Email；**风险分级执行与人工确认（§20.1）**；Webhook 幂等；Execution Log；失败重试；Pause/Resume；多租户隔离。**首发模板仅 5 个：T1/T2/T4/T5/T7**（T4 可先行，其余依赖 R1）。
**P1（首发后增强）**：Product Updated；Custom Webhook；Update Product Status（下架，走 §20.1 需确认）；AND/OR 组合；部分成功；Retry Failed Step Only；Automation Duplicate；**扩展模板 T3/T6/T9**。
**P2（未来）**：Daily Digest；高级定时器；更多通知渠道；复杂条件组合；高级库存自动化；更丰富集成；模板市场；AI 辅助配置。

**哪些 P1 可随 MVP 交付、哪些须验证后再做（委托 §12 末）**：
- 可随 MVP：Inventory Low（read_inventory 已具备，无审批依赖）、AND/OR 组合（纯函数扩展）、部分成功（引擎设计内建）、Automation Duplicate。
- 必须验证后再做：Product Updated→Update Product Status（依赖 write_products 扩权 + App Store 审核）、Custom Webhook（SSRF 需专项安全验证）、Retry Failed Step Only（依赖步骤幂等验证）、任何 orders/customers trigger（依赖 R1 审批落地）。

**硬前置（不进 MVP 就无法首发订单类自动化）**：R1 Protected Customer Data 审批 + R3 写 scope 扩权。

---

## 35. 测试策略

完整验收见 `docs/V2-MVP-ACCEPTANCE.md`。

**Unit（纯函数 ≥90% 覆盖，但不以覆盖率为唯一指标）**：ConditionEvaluator、TriggerNormalizer、ActionExecutor（mock API）、Idempotency、LoopProtector、RetryPolicy、DSL Validation、Timezone、Payload Mapping。
**Integration**：webhook 接收、HMAC 验证、DB 幂等（唯一索引）、Automation 匹配、Action 执行、日志持久化、失败重试、多租户隔离。
**E2E**：场景 A–G（见 §36）。
沿用现有 `tests/*.test.ts` vitest 体系与 `sync-job-ledger.db.test.ts` 的可注入 db 测试范式（迁移 §1.4）。

---

## 36. E2E 验收标准

> 每条含：前置条件 / 输入 / 步骤 / 预期 / DB 验证 / 前端验证。完整可执行用例见 `docs/V2-MVP-ACCEPTANCE.md`。

- **A 高价值订单自动打标**：Order Created, total=$600 → HMAC 通过、匹配成功、Condition TRUE、Order Tag 添加、ExecutionLog 创建、前端 SUCCESS。
- **B 条件不匹配**：total=$100 → 不执行 Action、无错误、记 SKIPPED + conditionResult。
- **C 邮件发送失败**：Add Tags 成功 / Send Email 失败 → PARTIAL_SUCCESS、用户可读错误、可仅重试失败步。
- **D 重复 Webhook**：同 webhookId → 只处理一次，不重复打标/发信（WebhookDelivery 唯一索引）。
- **E 循环触发**：mypi 自身关联事件不无限重复；超 maxDepth 停止并记原因。
- **F 多店铺隔离**：A 店不可访问 B 店自动化/日志；Action 用正确店铺 token。
- **G Worker 崩溃恢复**：执行中任务可被检测、不永久 RUNNING、已成功 Action 不无条件重跑。

---

## 37. 实施路线图

四阶段（每阶段：目标/任务/前置依赖/交付物/验收/风险/完成定义）。

- **Phase 1 基础设施与数据模型**：Prisma Schema（§27 additive）、数据迁移（Shop 回填）、Webhook Ingestion、Deduplication、Event Normalization、Worker 基础改造。依赖：无（纯基建）。风险：Session.shop→Shop 回填正确性。完成定义：新表迁移可 up/down、去重表命中重复被拒、normalize 单测通过。**逐条任务见 `docs/V2-PHASE1-TASKS.md`。**
- **Phase 2 Automation Engine**：Trigger Registry、Condition Evaluator、Action Registry/Executor、Execution Queue、ExecutionLog/Step、Retry、Loop Protection。依赖：Phase 1。完成定义：E2E A/B/D/E/G 通过（可用非 protected trigger 或 mock）。**逐条任务见 `docs/V2-PHASE2-TASKS.md`。**
- **Phase 3 前端与模板系统**：五导航、**首发 5 核心模板（T1/T2/T4/T5/T7）**、向导编辑器、抽屉、Activity Logs、Integrations、§20.1 人工确认交互。T3/T6/T8/T9/T10 进扩展库分批跟进。依赖：Phase 2。完成定义：商家可从模板 3 分钟启用 + 看日志 + 高风险步骤可确认。**逐条任务见 `docs/V2-PHASE3-TASKS.md`。**
- **Phase 4 质量与生产发布**：全测试、多租户、Shopify 权限审核、隐私合规、worker 生产部署、监控、错误告警、性能、App Store 检查。依赖：**R1 审批 + R3 扩权落地**（否则订单类模板不可发布，首发可先上无审批墙的 T4 + 基建）。完成定义：见 `V2-MVP-ACCEPTANCE.md` 发布检查清单。**逐条任务见 `docs/V2-PHASE4-TASKS.md`。**

> 路线图边界：Phase 1–4 只交付 **Stage 1 Automation Toolkit**（固定模板）。Stage 2 自由组合、Stage 3 平台生态（见 §3.1）为后续版本，不在本次四阶段内。

---

## 38. 风险清单

| ID | 风险 | 等级 | 缓解 | 关联 |
|---|---|---|---|---|
| R1 | Protected Customer Data 审批墙，阻塞 orders/customers webhook 订阅 | **阻塞级** | 优先申请审批；未批前首发 Products/Inventory 类；文档明示 | OQ-1、迁移 §4 |
| R2 | read_all_orders 历史窗口（60 天）限制 T9/T10 | 高 | 申请 read_all_orders（须配 read_orders）；降级为近 60d 扫描 | OQ |
| R3 | 写 scope 扩权触发 App Store 审核、最小化边界 | 中 | 按需申请；逐资源确认 scope 文案；权限检查 UI | OQ |
| R4 | 合规删除清单遗漏新表 | 高 | 同 PR 扩 `SHOP_SCOPED_DELETES`；集成测试断言全表清干净 | 迁移 §1.11 |
| R5 | Loop Protection 无法靠 Shopify 原生来源标记保证 | 中 | 去重表 + 级联深度 + 限次 + 指纹多重叠加 | §24 |
| R6 | T3 风险数据时序（create 时 risk 未必就绪） | 中 | 改用 order.paid / 延迟读取；标 OQ | OQ |
| R7 | Email 送达/退信/域名验证未落地 | 中 | 平台级发送 + SPF/DKIM + bounce 处理 | §17 |
| R8 | Custom Webhook SSRF | 高 | 严格出站守卫 + 测试 | §30 |

---

## 39. 上线检查清单

- [ ] R1 审批通过，orders/customers webhook 成功订阅（生产收到真实 delivery）。
- [ ] scopes 扩至所需读写集并通过 App Store 权限审核。
- [ ] Prisma additive migration 在生产库成功，旧数据/Session 完好，商家零重授权。
- [ ] `purgeShopBusinessData` 覆盖全部 V2 新表并通过 uninstall/redact 实测。
- [ ] HMAC + 去重 + 多租户隔离通过 E2E A–G。
- [ ] Email 域名验证完成、测试邮件送达、退信可观测。
- [ ] SSRF 守卫拦截内网/元数据地址（专项测试）。
- [ ] 可观测指标（失败率/耗时/队列/API Cost/worker 健康）上线。
- [ ] 错误信息全部 human-readable（无 GraphQL 堆栈外泄）。
- [ ] `shopify app deploy` + 文档/用户指南更新（延用 V1 发布 runbook）。

---

## 40. 成功指标与商业验证指标

- **激活**：启用 ≥1 自动化的店铺占比；从安装到首条自动化的中位时长（目标 <10 分钟）。
- **价值**：Total Tasks Run、Estimated Time Saved（§13.1 口径）、Active Automations/店。
- **可靠**：执行成功率（目标 >95%）、PARTIAL/FAILED 恢复率、webhook 去重命中正确率、死信率。
- **留存/商业**：周活跃自动化店铺数、模板启用转化、由自动化驱动的付费转化与续订。
- **验证性指标**（beta）：被暂停的自动化占比（反映信任）、用户重试成功率、可读错误满意度。

---

## 附：与其余三文档的一致性契约

1. 模块状态/表名/路由名以 `V1-TO-V2-MIGRATION.md` 为准。
2. API 能力 VERIFIED / 待验证以 `V2-OPEN-QUESTIONS.md` 为准；未 VERIFIED 不进 P0 验收。
3. P0/P1/P2 与 E2E A–G 用例的可执行验收以 `V2-MVP-ACCEPTANCE.md` 为准。
4. **R1 审批墙**在本 PRD（§18/§32/§34/§38/§39）、迁移 §4、Open Questions、验收前置四处必须同口径出现。

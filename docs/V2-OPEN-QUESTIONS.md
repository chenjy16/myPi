# mypi V2.0 待确认事项与技术风险（Open Questions）

> 项目代号：Shopify Automation Toolkit
> 用途：登记所有**无法从当前证据完全确认**的 Shopify API 权限/字段/webhook 行为/数据来源/邮件服务能力，以及需要产品负责人决策的事项。
> 规则（委托 16.2 / 16.7）：不得编造结论；PRD 中引用"待验证"处均以本文件为准；未 `VERIFIED` 的能力不得进入 `V2-MVP-ACCEPTANCE.md` 的 P0 用例。

状态图例：
- `VERIFIED` — 已通过 shopify.dev 官方文档/本次核实确认，可安全依赖。
- `待验证` — 方向明确但缺确切证据/文案，实施前必须在 dev/合作伙伴环境实测确认。
- `需决策` — 产品/商业层面待拍板，非技术问题。
- `阻塞` — 外部依赖未满足前无法开发或发布。

---

## 1. 已核实能力（VERIFIED，可作为设计基线）

| # | 能力 | 结论 | 来源 |
|---|---|---|---|
| V-1 | `tagsAdd` / `tagsRemove` 支持资源 | 支持 `Order / DraftOrder / Customer / Product / Article / DiscountNode` | Admin GraphQL 2026-10 文档 |
| V-2 | Webhook 去重键 | 官方明确 *"ignore duplicate deliveries using `X-Shopify-Webhook-Id`"*；每次投递含该头 | shopify.dev /apps/build/webhooks（Verify deliveries / Headers） |
| V-3 | Webhook 头 | `X-Shopify-Topic`、`X-Shopify-Webhook-Id`、`X-Shopify-Hmac-Sha256`、`X-Shopify-Triggered-At` | 同上 |
| V-4 | 投递语义 | at-least-once，**可重复、可漏发、不保证顺序**；官方要求幂等 + 对账 job | 同上（Ordering / Reconciliation） |
| V-5 | `orders/*` `customers/*` webhook 权限 | 属 protected customer data，需 `read_orders`/`read_customers` 且**需 Partners 审批**才能订阅 | 项目实测：未审批 `shopify app dev` 启动失败（`shopify.app.toml:31-33`） |
| V-6 | `inventory_levels/update` | 需 `read_inventory`；**非** protected data；V1 已正常订阅运行（可用） | `shopify.app.toml:27-29` 生产在用 |
| V-7 | `products/update` | 需 `read_products`；非 protected；可订阅（写需 `write_products`） | Admin webhook 文档 |
| V-8 | `Order.cancelReason` 枚举 | `CUSTOMER / DECLINED / FRAUD / INVENTORY / OTHER` | Admin GraphQL 文档 |
| V-9 | OrderRisk（风险评估）读 | 需 `read_orders`；`Order.risks` / riskLevel 可读 | Admin GraphQL 文档 |
| V-10 | `read_all_orders` | 扩展历史读，须**与 `read_orders` 并用**；`read_orders` 默认约 60 天窗口 | Admin API 文档 |
| V-11 | `productUpdate` 改状态 | 需 `write_products`（status ACTIVE/DRAFT/ARCHIVED） | Admin GraphQL 文档 |
| V-12 | 限流退避可复用 | V1 `adminGraphql`+`shopify-throttle`（封顶 5s、tries、错误分类）生产在用 | 代码审计 |

---

## 2. 待验证事项（待验证）

### OQ-1 · orders/customers webhook 审批（**同时是阻塞项，见 §4 B-1**）
- 问题：Protected Customer Data 审批的实际通过周期、所需材料、通过后是否即可订阅全部 orders/* 与 customers/* 主题。
- 影响：10 模板中 8 个、P0 全部订单/客户 trigger 依赖它。
- 行动：提交 Partners 审批；未获批前不得在 PRD/验收中把订单类自动化列为"可首发"。

### OQ-2 · tagsAdd/tagsRemove 逐资源确切写 scope
- 已 VERIFIED：支持资源列表（V-1）。
- 待验证：给 Order 打 tag 确切需 `write_orders`、给 Customer 需 `write_customers`、给 Product 需 `write_products`（文档明确 orderCreate 需 write_orders，但 tagsAdd 页仅列支持资源未显式标 scope）。
- 行动：在 dev store 用最小 scope 实测 tagsAdd 各资源，确认拒绝信息与所需 scope 文案。

### OQ-3 · customers/create payload 是否含 company 字段（B2B 模板 T7）
- 已 VERIFIED：customers/create 存在、需 read_customers、受 protected 审批。
- 待验证：新建客户 webhook payload **是否直接带 company/B2B 结构**；若不带，判 "Company Exists" 需额外回读（Company/CompanyContact 查询，可能需额外 scope）。
- 影响：T7 条件 `company exists` 的可行性与成本。
- **首发缓解（D-9）**：T7 首发只用 note/tags 已验证字段，不阻塞于本项；company 分支待 OQ-3 实测后再启。
- 行动：拿真实 B2B 店铺的 customers/create payload 样本核实字段路径。

### OQ-4 · Order 风险数据时序（T3）
- 已 VERIFIED：risks 可读（V-9）。
- 待验证：`orders/create` 触发的**瞬间**风险评估是否已完成；riskLevel 是否可能在 paid 前为空。
- 影响：T3 用 order.created 判 HIGH RISK 可能漏判。
- 行动：实测风险写入时机；必要时 T3 改用 orders/paid 或延迟回读。

### OQ-5 · 超卖/backorder 字段可用性（T9）
- 待验证：`inventory_management`、是否允许继续超卖（`inventory_policy` CONTINUE/DENY）、事件后库存快照一致性时间差。
- 行动：核实 GraphQL 变体字段与"下单后库存即时态"读取口径。

### OQ-6 · Unfulfilled 历史扫描窗口（T10）
- 待验证：不申请 read_all_orders 时，3 天前订单是否在 read_orders 60 天窗口内稳定可读、未发货过滤（`fulfillment_status=unfulfilled`）查询成本。
- 关联：read_all_orders 亦需审批（V-10 + protected）。

### OQ-7 · Shopify 是否回传 mypi 自定义来源标记（Loop Protection）
- 待验证：mypi 通过 tagsAdd 加的特殊 tag / metafield 是否会出现在其触发的下一次 products/update payload，用于来源过滤。
- 已知红线（委托 7.3）：**不得假设 Shopify 一定会把 mypi 标记放进后续 webhook**。故 §24 以"去重 + 级联深度 + 限次 + 指纹"为可靠主线，来源标识仅降风险。
- 行动：实测 tag 变更后的 webhook payload 是否含旧 tags 全集。

### OQ-8 · 邮件发送服务选型能力边界
- 待验证：Resend vs SendGrid 的成本/配额/域名验证流程/发件人身份约束/退信（bounce）webhook/速率限制；两者 API Key 加密存储方案。
- 约束（委托 5.5）：不得把用户邮箱视为"已具备任意发送能力"。
- 行动：定选型后补详细发送/退信设计。

### OQ-9 · Custom Webhook 出站 SSRF 具体守卫清单
- 待验证：允许的协议（仅 https）、端口、DNS Rebinding 防护实现（解析后固定 IP 再连接）、云元数据地址段完整清单。
- 行动：实施时补安全专项测试用例。

### OQ-10 · ExecutionLog / payload 数据保留期限
- 待验证：脱敏 payload 与执行记录的合规保留期（GDPR 数据最小化）；到期清理策略。
- 关联：Shop.timezone 来源（现 V1 存于 `InventorySettings.timezone`，V2 迁到 `Shop`，需确认回填映射）。

---

## 3. 产品决策（部分已拍板）

### 3.0 已锁定决策（产品负责人 2026-11，已回写 PRD）

- **定位演进**：Automation Toolkit → Platform 三阶段（PRD §3.1）；MVP 只交 Stage 1 固定模板，不做平台/画布。
- **执行风险分级（PRD §20.1 / P6）**：Add/Remove Tags + 通知类=自动执行；**下架商品=高风险默认需确认**；**修改商品价格=暂不开放**；**删除订单=不进 MVP**。
- **首发模板收敛（PRD §32/§34/§37）**：首发仅 **T1/T2/T4/T5/T7** 五个核心；T3/T6/T8/T9/T10 进扩展库。

> 上述三条将下方部分 D-x 从"待决策"变为"已定"；保留未决项仍需拍板。

| ID | 议题 | 状态 / 说明 |
|---|---|---|
| D-1 | 首发范围是否审批未到时先行上线无审批模板 | **已定**：先交 T4（read_inventory 无审批）+ 基建；T1/T2/T5/T7 待 R1。见 PRD §34 |
| D-2 | 写 scope 扩权边界（write_orders/write_customers/write_products/read_customers） | 待定：首发 5 模板需 read_customers + write_orders + write_customers；write_products 可缓（T8 属扩展） |
| D-3 | 是否申请 read_all_orders（解 T9/T10 历史窗口） | 待定：T9/T10 均在扩展库，首发不需要；待扩展阶段再定 |
| D-4 | 高风险自动改（下架商品）是否强制人工确认 | **已定**：默认需确认（PRD §20.1）；T8 属扩展库，实现时落实 Confirmation Gate |
| D-5 | Email 平台级发件域与 from 身份策略 | 待定（app 统一域 vs 商家自有域验证） |
| D-6 | Estimated Time Saved 折算默认值是否合适 | 待定（PRD §13.1 默认分钟数，可配置） |
| D-7 | AutomationTrigger 是否需要独立表 | 待定（DSL 纯 JSON 够用时不建表，避免过度设计） |
| D-8 | 软废弃模块（Suppliers/Purchase Plans/Copy）保留多久后清理 | 待定（迁移 §5 观察期判据） |
| D-9 | Customer Classification（T7）首发判据 | 建议**首发只用 note/tags 已验证字段**，避开 OQ-3 company 不确定性（已在 PRD §32 T7 采纳）；company 分支待 OQ-3 后开启 |

---

## 4. 阻塞项汇总（发布前必须解除）

- **B-1 = OQ-1**：Protected Customer Data 审批未通过 ⇒ 订单/客户类 trigger 全部不可订阅 ⇒ T1/T2/T3/T5/T6/T7/T9/T10 与 P0 四大 trigger 不可用。**这是 V2.0 首发最大单点风险**，与 PRD §18/§32/§34/§38/§39、迁移 §4 R1、验收前置条件同口径。
- **B-2 = D-2/OQ-2**：写 scope 未扩 + 未过 App Store 权限审核 ⇒ Add/Remove Tag、Update Product Status 不可执行。

---

## 5. 一致性说明

- 本文件 VERIFIED/待验证 结论被 PRD §18–§20、§32 直接引用。
- `V2-MVP-ACCEPTANCE.md` 中任何 P0 用例若涉及 §2 待验证项或 §4 阻塞项，必须显式挂"前置条件：OQ-x 已解除"，否则该用例降级为条件性验收。
- 更新任一 VERIFIED/待验证 状态时，需回检 PRD 与验收文档对应条目。

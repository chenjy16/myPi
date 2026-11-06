# V2 Phase 4 · 外部审批准备包（P4-05 / P4-06 / P4-07）

> 本文件是**提交材料 + 恢复步骤清单**，不是通过证明。Protected Customer Data 审批的**提交与生效**、写 scope 的**扩权生效**属外部动作（Partner Dashboard 人工审核），**不可代码绕过**。此处交付其全部准备物：逐 topic 用途文案、动作→scope 最小映射、toml 草案（保持注释态）、`shopify app` 校验步骤。审批一旦通过，按 §4 的开关动作即可解锁，无需再改判定逻辑。
>
> 基准：`docs/V2-PHASE4-TASKS.md` R1/B-1（Protected Customer Data 审批墙）、V-5（触发登记保护标记）、OQ-2（dev store 写 scope 实测）。触发与动作的事实源在代码：`app/lib/trigger-registry.ts`、`app/lib/action-registry.ts`。

## 1. Protected Customer Data 逐 topic 申请文案

自动化引擎只用**判定所需的最小字段集**（`fieldWhitelist`），不展示、不长期保留原始客户数据。以下每条对应一个 webhook 主题，用途口径与 `trigger-registry.ts` 的 `fieldWhitelist` 逐字对齐。

| Topic | 触发场景（商家可配的自动化） | 读取的最小字段 | 用途 | 当前状态 |
| --- | --- | --- | --- | --- |
| `orders/create` | 新订单达成标条件（金额/币种/客户标签分群）时打标、通知 | `total_price`、`currency`、`customer_tags` | 判定订单是否满足商家设定的条件；不读收件人姓名/地址/邮箱 | 路由 `webhooks/orders/create.tsx` 已就位；订阅在 toml 注释态 |
| `orders/cancelled` | 订单取消后撤销先前打标 / 通知补发 | `cancelled_at`、`customer_tags` | 判定取消事件以触发回流动作 | 路由 `webhooks/orders/cancelled.tsx` 已就位；订阅在 toml 注释态 |
| `orders/paid` | 付款达成条件时打标、通知 | `total_price`、`currency`、`customer_tags` | 同 `orders/create`，事件语义为「已支付」 | **无路由**（登记于 trigger-registry，随后续里程碑补路由后申请） |
| `customers/create` | 新客户建档即按来源/标签分群打标 | note、tags 等已验证字段（`customers/create` 白名单，B2B/company 判据待 OQ-3 实测） | 新客户首单前的分群自动化判定 | **无路由 + 需 `read_customers` scope**（当前 scopes 未含，随审批一并申请，见 §2） |

申请陈述（提交 Partner Dashboard「Customer data protection」时可原样粘贴）：

> mypi 订阅上述订单/客户主题，仅为支撑商家自助配置的自动化条件判定。每个主题只提取列出的最小字段（金额、币种、标签、取消时间戳），用于在本地评估商家预设的规则；我们不读取、不存储、不展示订单收件人的姓名、地址、邮箱、电话等直接标识信息。事件负载在入库前经字段白名单裁剪（`app/lib/event-normalizer.ts`），落库的执行记录只保留脱敏快照，受 GDPR `customers/data_request` 与 `customers/redact` 合规钩子覆盖（见 `docs/release-runbook.md` §6 与 `webhooks.customers.*` 路由），并按 `EXECUTION_RETENTION_DAYS`（默认 180 天）自动清理。写权限仅用于对目标资源打标 / 改商品状态，逐项映射见下。

## 2. 动作 → 写 scope 最小映射表（P4-06）

事实源 `app/lib/action-registry.ts`。审批通过后，扩权随本表逐项落到 `[access_scopes]`（当前只读，未扩）。**最小化原则**：只加商家实际启用的自动化所需 scope；动作按目标实体选粒度（tag 类动作对 Order/Customer/Product 分别只需对应的 `write_*`）。

| 动作 | 目标实体 | 所需写 scope | 风险级 / 确认 | 备注 |
| --- | --- | --- | --- | --- |
| `tags.add` | Order | `write_orders` | 低 / 直执行 | 幂等：先读后写 |
| `tags.add` | Customer | `write_customers` | 中 | 触及客户记录，随 customers 主题审批生效 |
| `tags.add` | Product | `write_products` | 低 / 直执行 | 幂等 |
| `tags.remove` | Order/Customer/Product | 对应 `write_orders`/`write_customers`/`write_products` | 同上 | 标签不存在视为 no-op 成功 |
| `product.updateStatus` | Product | `write_products` | **高 / 需人工确认** | ACTIVE/DRAFT/ARCHIVED；确认前零 Mutation |
| `email.send` | —（外部 SMTP/Resend，OQ-8） | 无 Shopify scope | 视模板而定 | 不经 Shopify，走 Integration 密文 |
| `webhook.send` | —（商家自有端点） | 无 Shopify scope | 低 | 出站带幂等键 header |

> **OQ-2 待办**：dev store（`stepchic.myshopify.com`）对写 scope 的实际生效与 OAuth 重授权链路需在审批通过后**实测验证**（动作→scope→banner→重授权→执行），本表是申请口径不是已生效口径。`app/lib/scope-guard.ts` 据 `session.scope` 检测缺失并挂重授权引导（P4-06 代码面）。

## 3. toml 草案（保持注释态）

`shopify.app.toml` 的 `[webhooks]` 段已就位以下**注释块**（当前不激活，避免未审批时 `shopify app dev` 因受保护主题订阅失败）：

```toml
  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/create"
  topics = ["orders/create"]

  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/cancelled"
  topics = ["orders/cancelled"]
```

审批通过后取消注释即解锁直投；`orders/paid`、`customers/create` 需先补对应路由再按同形状加入（`customers/*` 同时把 `read_customers` 加进 `[access_scopes]`）。`[access_scopes]` 的写权限扩值同理随审批生效再按 §2 打开（当前保留只读，扩值以注释标注）。

## 4. 审批通过后的解锁清单（可执行步骤）

1. **恢复订阅**：取消 `shopify.app.toml` §3 的 orders 注释块；如启用客户类，补 `webhooks.customers.create.tsx` 路由并在 scopes 加 `read_customers`。
2. **扩写 scope**（仅当商家启用了对应动作）：按 §2 把 `write_*` 加进 `[access_scopes]`，保留旧值注释（沿用仓库「改动保留旧值注释」规范）。
3. **校验配置**（本地/CI，网络正常）：
   ```bash
   shopify app config link            # 重新链接当前 app，读取最新 toml
   shopify app config validate        # 离线校验 toml 结构与 scope/webhook 合法性
   npx @shopify/cli app config doctor 2>/dev/null || true   # 可选：进一步诊断
   ```
   期望：validate 通过、无「protected customer data topic without approval」告警。
4. **重授权引导**：确认 `app/lib/scope-guard.ts` + automations 页 banner 能在 session.scope 缺写权限时提示商家走 `/auth?shop=` 重授权（P4-06）。
5. **dev store 实测**（OQ-2）：`shopify app dev` 起 web+worker，对 `stepchic` 跑一遍 orders 直投 → 自动化命中 → 打标执行 → 活动日志，截图入 `ui-forensics/`（P4-01 场景）。

## 5. 诚实边界

- 本文档所有「待审批 / 待生效 / 待实测」项**如实标注**，不伪造审批通过。
- 生产 `AUTOMATION_EXECUTION_ENABLED` 与受保护主题订阅在审批生效前保持关闭/注释态；`RECONCILE_ENABLED` 默认关。
- 客户数据只走「最小字段 + 存前脱敏 + GDPR 钩子 + 保留期清理」四道闸，与 §1 陈述一致。

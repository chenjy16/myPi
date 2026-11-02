# 交付报告 08 —— 数据隔离、权限与合规删除

- 日期：2026-11-02 ｜ 跨阶段汇总（Stage 1 审计 + Stage 5 修复 + Stage 7 复验）
- 证据来源：代码走查 + 单测；未使用任何假数据绕过外部限制。

## 多店数据隔离

- 审计基线：`inventory.server.ts` / `sync-jobs.server.ts` 全部 24 处查询带 `shop` 谓词，零跨店泄漏（beta-plan 审计结论，Stage 7 复验新增的 `purchase-plans.server.ts`、`analytics.server.ts` 同样逐查询走 `shop` 谓词，含 `@@unique([shop, reference])` 店内编号）。
- webhook 处理只认 payload 作为失效信号，数值一律回 Admin API 按店重读。

## 权限最小化

- scopes：`read_products, read_inventory, read_orders, read_locations`（`shopify.app.toml`）。
- 无写回：Beta 主链路完全不写商家店铺数据；唯一写点（copy apply）在功能开关后。
- protected customer data：`read_all_orders` 与 orders webhook 待 Partners 审批；审批前 60 天窗口是硬限制，UI 以 `salesHistoryComplete` 如实降级，不伪造历史（外部限制既定原则）。

## 卸载即清除（GDPR 口径）

- `app/uninstalled` 与 `shop/redact` 共用 `purgeShopBusinessData`：按店删除 **16 张表全量清单**（session、productDraft、inventorySnapshot、inventoryEvent、location、dataSyncJob、salesDaily、reorderRecommendation、recommendationAudit、inventorySettings、variantSupplier、supplier、purchasePlanLine、purchasePlan、adviceFeedback、analyticsEvent），与 schema 业务模型一一对应，不留任何表。
- 子表先删保证每表计数是自身行数；日志输出 `model:count` 作为「确实删干净」的证据。
- `customers/data_request`、`customers/redact` webhook 已挂载响应路径。
- 历史缺口与修复：`recommendationAudit` 曾漏配（Stage 2 补）、Stage 3/4/5 六张表曾漏配（Stage 5 补）。Stage 7 新增列（reason/requestKey）在既有表上，purge 清单自动覆盖，无需变更。
- `app_uninstalled` 埋点事件被有意排除：purge 后即删，伪事件不如没有。

## 埋点数据面

`AnalyticsEvent.props` 只放业务上下文（结果、数量、页面），不放个人信息；反馈 comment 按店绑定存储以便回访（docs 页与 UI 均已如实告知）。

## 遗留

Partners 审批为外部阻塞项；审批通过后按 P2 计划启用 90 天历史。

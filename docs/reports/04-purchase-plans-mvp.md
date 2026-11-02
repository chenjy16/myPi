# 交付报告 04 —— Purchase Plans MVP

- 日期：2026-11-02 ｜ 阶段：Stage 4 ｜ 证据基线：`npm test` 当时 98 例通过；迁移 `add_purchase_plans` 已落库
- 数据来源说明：验证基于 demo 店 `stepchic.myshopify.com`。

## 交付内容（P1-3 全条）

- **数据模型**：`PurchasePlan`（店内编号 `PP-0001`、状态机 `open → ordered / cancelled`、采购日期、备注）+ `PurchasePlanLine`（数量、单价、商品/供应商名快照；`@@unique([planId, variantId])`）。
- **从建议生成**：accepted/edited 且未被 open 计划占用的建议进入建议池；勾选后**按供应商归并多 SKU**、同变体并量（`groupAdviceBySupplier`）。防注入：服务端只认自己重算的池，客户端勾选 id 之外一律丢弃。
- **计划编辑**：行改量（`parsePlanQuantity`）、删行、采购日期历法校验（`parsePurchaseDate`）、备注 ≤500。
- **状态流转下沉**：`canTransitionPlanStatus` 纯函数为唯一事实源；ordered/cancelled 是终态（要调整就新建）；取消计划后建议自动回池。标记 ordered 同步把建议决策写为 ordered，沿用既有审计链路。
- **CSV 导出**：单计划与全量，13 列；复用补货导出的转义口径（`escapeCsvCell`/`formatCsvCell` 已导出共用），公式注入防护。
- **快照语义**：供应商删除后计划仍可读（名称与成本为创建时快照；`supplierId` 故意不设外键）。

## 实现位置与测试

`app/lib/purchase-plans.ts`、`app/lib/purchase-plan-export.ts`、`app/purchase-plans.server.ts`、`app/routes/app.purchase-plans.tsx`；单测 `tests/purchase-plans.test.ts`（编号/状态机/归并/改量/日期）、`tests/purchase-plan-export.test.ts`（列序/转义/数字格式/文件名）。

## 遗留

无。Home 与入口文案已不再标 soon。

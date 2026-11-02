# 交付报告 03 —— Suppliers MVP

- 日期：2026-11-02 ｜ 阶段：Stage 3 ｜ 证据基线：`npm test` 当时 88 例通过；`Supplier` + `VariantSupplier` 迁移已落库
- 数据来源说明：验证基于 demo 店 `stepchic.myshopify.com`。

## 交付内容

- **数据模型**：`Supplier`（名称、联系人、默认交期、MOQ、Case Pack、Unit Cost、停用状态）+ `VariantSupplier`（变体绑定）。
- **管理页** `/app/suppliers`：增删改停、绑定变体；校验纯函数在 `app/lib/supplier-validation.ts`（单测 `tests/supplier-validation.test.ts`）。
- **进决策链路**：建议量按「整箱且达 MOQ」向上取整（`roundUpToSupplyTerms`，`app/lib/inventory-calculations.ts`），取整过程写入公式解释；供应商级 lead time 覆盖店铺默认（`leadTimeDaysUsed` vs `storeLeadTimeDays`）。
- **回退语义**：绑定停用即回退店铺口径；保存供应商后自动重算建议。

## 验收

- 建议表可见取整前后两个数量与解释文案；停用绑定后重算结果回落到店铺参数。
- typecheck/lint 全绿，构建成功。

## 遗留

无。卸载数据清除曾漏配 supplier 两张表，已在 Stage 5 一并修复（见报告 08）。

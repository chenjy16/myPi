import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPlanReference,
  canTransitionPlanStatus,
  groupAdviceBySupplier,
  isPurchasePlanStatus,
  parsePlanQuantity,
  parsePurchaseDate,
  type AdviceDraftLine,
} from "../app/lib/purchase-plans.ts";

function draft(overrides: Partial<AdviceDraftLine>): AdviceDraftLine {
  return {
    variantId: "v1",
    productTitle: "Product",
    variantTitle: "Default",
    sku: null,
    quantity: 10,
    supplierId: null,
    supplierName: null,
    unitCost: null,
    ...overrides,
  };
}

test("计划编号：四位补零，从 1 递增", () => {
  assert.equal(buildPlanReference(1), "PP-0001");
  assert.equal(buildPlanReference(42), "PP-0042");
  assert.equal(buildPlanReference(9999), "PP-9999");
});

test("状态机：只有 open 能流转，终态不再变化", () => {
  assert.equal(isPurchasePlanStatus("open"), true);
  assert.equal(isPurchasePlanStatus("archived"), false);
  assert.equal(canTransitionPlanStatus("open", "ordered"), true);
  assert.equal(canTransitionPlanStatus("open", "cancelled"), true);
  assert.equal(canTransitionPlanStatus("open", "open"), false);
  assert.equal(canTransitionPlanStatus("ordered", "cancelled"), false);
  assert.equal(canTransitionPlanStatus("cancelled", "open"), false);
  assert.equal(canTransitionPlanStatus("ordered", "open"), false);
});

test("归并：按供应商分组，未绑定归 Store default 且排最后", () => {
  const groups = groupAdviceBySupplier([
    draft({ variantId: "v1", supplierId: "s-b", supplierName: "Beta" }),
    draft({ variantId: "v2", supplierId: null, supplierName: null }),
    draft({ variantId: "v3", supplierId: "s-a", supplierName: "Alpha" }),
    draft({ variantId: "v4", supplierId: "s-b", supplierName: "Beta" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.supplierName),
    ["Alpha", "Beta", null],
  );
  assert.equal(groups[1]?.lines.length, 2);
  assert.equal(groups[2]?.lines.length, 1);
});

test("归并：同变体重复提交时并量，且不改动输入行", () => {
  const input = [
    draft({ variantId: "v1", quantity: 6 }),
    draft({ variantId: "v1", quantity: 4 }),
  ];
  const groups = groupAdviceBySupplier(input);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.lines.length, 1);
  assert.equal(groups[0]?.lines[0]?.quantity, 10);
  // 归并拷贝副本，累加不能污染调用方手里的原始行。
  assert.equal(input[0]?.quantity, 6);
});

test("改量输入：只要正整数，越界与脏输入都拒", () => {
  assert.equal(parsePlanQuantity("12"), 12);
  assert.equal(parsePlanQuantity(" 12 "), 12);
  assert.equal(parsePlanQuantity("0"), null);
  assert.equal(parsePlanQuantity("-3"), null);
  assert.equal(parsePlanQuantity("1.5"), null);
  assert.equal(parsePlanQuantity("abc"), null);
  assert.equal(parsePlanQuantity(null), null);
  assert.equal(parsePlanQuantity("3000000000"), null);
});

test("采购日期：合法日历日期通过，伪日期与格式外一律拒", () => {
  assert.equal(parsePurchaseDate("2026-11-02"), "2026-11-02");
  assert.equal(parsePurchaseDate("2026-02-30"), null);
  assert.equal(parsePurchaseDate("2026-13-01"), null);
  assert.equal(parsePurchaseDate("2026-1-2"), null);
  assert.equal(parsePurchaseDate(""), null);
  assert.equal(parsePurchaseDate("today"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DEMAND_WINDOW_DAYS,
  buildObservedDemand,
  calculateInventoryHealth,
  countDaysInclusive,
  roundUpToSupplyTerms,
} from "../app/lib/inventory-calculations.ts";

test("reorder suggestion is deterministic and includes incoming stock", () => {
  const result = calculateInventoryHealth({
    available: 28,
    incoming: 5,
    unitCost: 3.5,
    sales30Days: 60,
    sales60Days: 120,
    sales90Days: 180,
    leadTimeDays: 10,
    safetyStockDays: 5,
    reviewPeriodDays: 14,
    today: "2026-10-31",
  });

  assert.equal(result.averageDailySales, 2);
  assert.equal(result.reorderPoint, 30);
  assert.equal(result.targetStock, 58);
  assert.equal(result.suggestedReorderQuantity, 25);
  assert.equal(result.daysOfInventory, 14);
  assert.equal(result.estimatedStockoutDate, "2026-11-14");
  assert.equal(result.inventoryValue, 98);
  assert.equal(result.status, "low_stock");
});

test("zero sales never produces infinite coverage or an unsupported dead-stock label", () => {
  const incompleteHistory = calculateInventoryHealth({
    available: 10,
    incoming: 0,
    unitCost: null,
    sales30Days: 0,
    sales60Days: 0,
    sales90Days: null,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-10-31",
  });
  assert.equal(incompleteHistory.daysOfInventory, null);
  assert.equal(incompleteHistory.estimatedStockoutDate, null);
  assert.equal(incompleteHistory.status, "no_sales");

  const completeHistory = calculateInventoryHealth({
    ...incompleteHistory,
    sales90Days: 0,
  });
  assert.equal(completeHistory.status, "dead_stock");
});

test("out of stock and overstock statuses use explicit thresholds", () => {
  const stockout = calculateInventoryHealth({
    available: 0,
    incoming: 20,
    unitCost: null,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: 90,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-10-31",
  });
  assert.equal(stockout.status, "stockout");

  const overstock = calculateInventoryHealth({
    available: 100,
    incoming: 0,
    unitCost: 1,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: null,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-10-31",
  });
  assert.equal(overstock.daysOfInventory, 100);
  assert.equal(overstock.status, "overstock");
});

test("overstock starts only above 90 days of inventory", () => {
  const atThreshold = calculateInventoryHealth({
    available: 90,
    incoming: 0,
    unitCost: null,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: 90,
    leadTimeDays: 10,
    safetyStockDays: 10,
    reviewPeriodDays: 14,
    today: "2026-10-31",
  });
  const aboveThreshold = calculateInventoryHealth({
    ...atThreshold,
    available: 91,
  });

  assert.equal(atThreshold.status, "healthy");
  assert.equal(aboveThreshold.status, "overstock");
});

test("observed demand divides by visible days so unread days never dilute the average", () => {
  // 只读得到 10 天订单时，19 件销量就是 1.9/天；按满窗口除会变成 0.63/天的假低谷。
  const partial = buildObservedDemand(19, {
    demandWindowDays: DEFAULT_DEMAND_WINDOW_DAYS,
    sampleDaysAvailable: 10,
    daysWithSales: 6,
  });
  assert.equal(partial.windowDays, 30);
  assert.equal(partial.sampleDaysAvailable, 10);
  assert.equal(partial.perDay, 1.9);
  assert.equal(partial.daysWithSales, 6);

  // 没有可见天数时给 0，不产生 Infinity/NaN。
  const none = buildObservedDemand(0, {
    sampleDaysAvailable: 0,
    daysWithSales: 0,
  });
  assert.equal(none.perDay, 0);

  // 超出窗口的样本天数被夹回窗口，避免把天数当成比观察期还长的分母。
  const clamped = buildObservedDemand(30, { sampleDaysAvailable: 90 });
  assert.equal(clamped.sampleDaysAvailable, DEFAULT_DEMAND_WINDOW_DAYS);
  assert.equal(clamped.perDay, 1);
});

test("coverage and suggested quantity follow the observed daily rate", () => {
  const result = calculateInventoryHealth({
    available: 12,
    incoming: 5,
    unitCost: null,
    sales30Days: 19,
    sales60Days: 40,
    sales90Days: null,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-11-01",
    demandWindowDays: 30,
    sampleDaysAvailable: 10,
    daysWithSales: 4,
  });

  assert.equal(result.observedDemand.perDay, 1.9);
  assert.equal(result.averageDailySales, result.observedDemand.perDay);
  // 1.9 x (14 交期 + 14 Review + 7 安全) = 66.5 目标库存；ceil(66.5 - 12 现有 - 5 在途) = 50
  assert.equal(result.targetStock, 66.5);
  assert.equal(result.suggestedReorderQuantity, 50);
  assert.equal(result.replenishment.coverageDays, 35);
});

test("the formula text explains the numbers behind the suggestion", () => {
  const withSales = calculateInventoryHealth({
    available: 12,
    incoming: 5,
    unitCost: null,
    sales30Days: 19,
    sales60Days: 40,
    sales90Days: null,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-11-01",
    sampleDaysAvailable: 10,
    daysWithSales: 4,
  });
  assert.match(withSales.reorderReason, /1\.9 units\/day/);
  assert.match(
    withSales.reorderReason,
    /19 units observed over 10 visible days/,
  );
  assert.match(
    withSales.reorderReason,
    /35 coverage days \(14 lead \+ 14 review \+ 7 safety\)/,
  );
  assert.equal(withSales.reorderReason, withSales.replenishment.formula);

  const withoutSales = calculateInventoryHealth({
    ...withSales,
    sales30Days: 0,
    sales60Days: 0,
    sales90Days: null,
    daysWithSales: 0,
  });
  assert.match(withoutSales.reorderReason, /No sales were observed/);
});

test("countDaysInclusive counts calendar days at both ends", () => {
  assert.equal(countDaysInclusive("2026-11-01", "2026-11-01"), 1);
  assert.equal(countDaysInclusive("2026-10-03", "2026-11-01"), 30);
  assert.equal(countDaysInclusive("2026-11-02", "2026-11-01"), 0);
  assert.equal(countDaysInclusive("2026-12-31", "2027-01-02"), 3);
});

test("supply-term rounding covers MOQ, case packs and both together", () => {
  // 无箱规：只抬到 MOQ；原始量已过 MOQ 则原样保留。
  assert.equal(roundUpToSupplyTerms(47, { minOrderQuantity: 50, casePack: 0 }), 50);
  assert.equal(roundUpToSupplyTerms(53, { minOrderQuantity: 50, casePack: 0 }), 53);
  // 有箱规：按整箱向上取整。
  assert.equal(roundUpToSupplyTerms(47, { minOrderQuantity: 0, casePack: 12 }), 48);
  // 箱规与 MOQ 同时生效：取「覆盖原始需求」与「凑到 MOQ」里更大的箱数。
  assert.equal(roundUpToSupplyTerms(47, { minOrderQuantity: 50, casePack: 12 }), 60);
  // casePack 1 视为不按箱取整。
  assert.equal(roundUpToSupplyTerms(7, { minOrderQuantity: 0, casePack: 1 }), 7);
  // 没有需求就不该凭空凑出一单。
  assert.equal(roundUpToSupplyTerms(0, { minOrderQuantity: 50, casePack: 12 }), 0);
});

test("supplier terms override lead time and round the final suggestion", () => {
  // 日均 1 件：店铺口径 35 覆盖天、在手 5 → 原始需求 30；
  // 供应商交期 20 天 → 41 覆盖天 → 原始需求 36 → case pack 12 且 MOQ 40 → 4 箱 48。
  const result = calculateInventoryHealth({
    available: 5,
    incoming: 0,
    unitCost: null,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: 90,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-11-02",
    supplyTerms: {
      supplierName: "Acme Supplies",
      leadTimeDays: 20,
      minOrderQuantity: 40,
      casePack: 12,
    },
  });

  assert.equal(result.targetStock, 41);
  assert.equal(result.suggestedReorderQuantity, 48);
  assert.equal(result.supplierTermsApplied?.rawQuantity, 36);
  assert.equal(result.supplierTermsApplied?.finalQuantity, 48);
  assert.equal(result.supplierTermsApplied?.leadTimeDaysUsed, 20);
  assert.match(result.replenishment.formula, /Acme Supplies \(20 days\)/);
  assert.match(result.replenishment.formula, /rounds up to 48/);
});

test("store lead time and unrounded quantity apply without supply terms", () => {
  const result = calculateInventoryHealth({
    available: 5,
    incoming: 0,
    unitCost: null,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: 90,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-11-02",
  });

  assert.equal(result.suggestedReorderQuantity, 30);
  assert.equal(result.supplierTermsApplied, null);
  assert.doesNotMatch(result.replenishment.formula, /rounds up/);
});

test("a paused-equivalent (null) supply term keeps advice on store settings", () => {
  // 绑定存在但供应商停用时的调用形态：route 层直接不传 terms。
  const withTerms = calculateInventoryHealth({
    available: 5,
    incoming: 0,
    unitCost: null,
    sales30Days: 30,
    sales60Days: 60,
    sales90Days: 90,
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
    today: "2026-11-02",
    supplyTerms: null,
  });
  assert.equal(withTerms.suggestedReorderQuantity, 30);
  assert.equal(withTerms.supplierTermsApplied, null);
});

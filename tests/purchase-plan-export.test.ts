import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PURCHASE_PLAN_EXPORT_HEADERS,
  buildPurchasePlanCsv,
  buildPurchasePlanFileName,
  type PurchasePlanExportRow,
} from "../app/lib/purchase-plan-export.ts";

const ROW: PurchasePlanExportRow = {
  reference: "PP-0001",
  planStatus: "open",
  supplierName: "Acme, Inc.",
  productTitle: 'Tee "Classic"',
  variantTitle: "M / Blue",
  sku: "TEE-001",
  quantity: 48,
  unitCost: 4.5,
  lineValue: 216,
  currencyCode: "USD",
  purchaseDate: "2026-11-05",
  planNotes: "=SUM(A1)",
  createdAt: "2026-11-02T08:00:00.000Z",
};

test("表头顺序与列数一致，金额列在币种之后", () => {
  assert.deepEqual(PURCHASE_PLAN_EXPORT_HEADERS, [
    "Plan",
    "Plan status",
    "Supplier",
    "Product",
    "Variant",
    "SKU",
    "Quantity",
    "Currency",
    "Unit cost",
    "Line value",
    "Purchase date",
    "Plan notes",
    "Plan created",
  ]);
});

test("CSV 转义：逗号加引号、内部引号双写、公式前导单引号", () => {
  const csv = buildPurchasePlanCsv([ROW]);
  assert.ok(csv.includes('"Acme, Inc."'), "supplier with comma is quoted");
  assert.ok(
    csv.includes('"Tee ""Classic"""'),
    "inner quotes are doubled inside quotes",
  );
  // =SUM(A1) 先被加前导单引号，再因不含特殊字符而无需包引号。
  assert.ok(
    csv.includes(",'=SUM(A1)",),
    "formula-looking note is guarded outside quoting",
  );
});

test("数字格式化：整数原样、小数两位、空成本留空而不是 0", () => {
  const csv = buildPurchasePlanCsv([
    ROW,
    { ...ROW, reference: "PP-0002", unitCost: null, lineValue: null },
  ]);
  assert.ok(csv.includes("4.50"), "unit cost renders with two decimals");
  assert.ok(
    csv.includes("48,USD,,,2026-11-05"),
    "missing cost and line value stay empty, not zero",
  );
});

test("文件名：单计划带编号，全量用复数", () => {
  assert.equal(
    buildPurchasePlanFileName("2026-11-02", "PP-0001"),
    "mypi-purchase-plan-PP-0001-2026-11-02.csv",
  );
  assert.equal(
    buildPurchasePlanFileName("2026-11-02"),
    "mypi-purchase-plans-2026-11-02.csv",
  );
  // 编号兜底清理：不该出现的字符换成连字符，文件名保持可用。
  assert.equal(
    buildPurchasePlanFileName("2026-11-02", "PP/00 01"),
    "mypi-purchase-plan-PP-00-01-2026-11-02.csv",
  );
});

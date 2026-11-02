import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REORDER_EXPORT_HEADERS,
  buildReorderCsv,
  buildReorderFileName,
  type ReorderExportRow,
} from "../app/lib/reorder-export.ts";

/** 一行可以直接下单的完整数据，用例只改自己要验证的那一列。 */
function row(overrides: Partial<ReorderExportRow> = {}): ReorderExportRow {
  return {
    store: "acme.myshopify.com",
    productTitle: "Linen Shirt",
    variantTitle: "M / Natural",
    sku: "LSH-M-NAT",
    healthStatus: "Low stock",
    actionState: "Pending review",
    available: 12,
    incoming: 5,
    observedDemandQuantity: 19,
    observedDemandWindowDays: 30,
    observedDemandSampleDays: 10,
    observedDailySales: 1.9,
    daysOfInventory: 8,
    estimatedStockoutDate: "2026-11-09",
    leadTimeDays: 14,
    reviewPeriodDays: 14,
    safetyStockDays: 7,
    coverageDays: 35,
    reorderPoint: 40,
    targetStock: 66.5,
    suggestedQuantity: 50,
    decidedQuantity: null,
    confidence: "medium",
    confidenceReasons: ["Only 10 visible sales days", "60-day history only"],
    unitCost: 3.5,
    inventoryValue: 42,
    currencyCode: "USD",
    snapshotDate: "2026-11-01",
    syncedAt: "2026-11-01T10:00:00Z",
    ...overrides,
  };
}

/**
 * 按 RFC 4180 拆一行：带引号的单元格里的逗号不算分隔符，连续两个引号是转义。
 * 测试要读某一列，就必须自己会拆，不能简单 split(",")。
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/** 生成单行导出并按表头名取回原始值（已去引号），避免测试写死列序。 */
function exportedCell(rows: ReorderExportRow[], header: string): string {
  const [headerLine, dataLine] = buildReorderCsv(rows).split("\r\n");
  const cells = splitCsvLine(dataLine);
  assert.equal(
    cells.length,
    REORDER_EXPORT_HEADERS.length,
    `row shifted columns: ${dataLine}`,
  );
  assert.equal(
    splitCsvLine(headerLine).join(","),
    REORDER_EXPORT_HEADERS.join(","),
  );
  return cells[REORDER_EXPORT_HEADERS.indexOf(header)];
}

/** 取某一列的原始文本（还带引号与公式护栏），用来验证转义本身。 */
function exportedRaw(rows: ReorderExportRow[], header: string): string {
  const dataLine = buildReorderCsv(rows).split("\r\n")[1];
  return dataLine.split(",")[REORDER_EXPORT_HEADERS.indexOf(header)];
}

test("the export carries one column per documented header", () => {
  const [headerLine, dataLine, tail] = buildReorderCsv([row()]).split("\r\n");
  assert.equal(REORDER_EXPORT_HEADERS.length, 29);
  assert.deepEqual(splitCsvLine(headerLine), REORDER_EXPORT_HEADERS);
  assert.equal(splitCsvLine(dataLine).length, REORDER_EXPORT_HEADERS.length);
  // 正文以换行收尾，只剩一个空尾行，Excel 不会多出空白记录。
  assert.equal(tail, "");
});

test("rows join with CRLF and end with a trailing line break", () => {
  const csv = buildReorderCsv([row(), row({ variantTitle: "L / Natural" })]);
  assert.ok(csv.endsWith("\r\n"));
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(exportedCell([row()], "Variant"), "M / Natural");
  assert.equal(splitCsvLine(lines[2])[2], "L / Natural");
});

test("every exported row names the store and currency it came from", () => {
  const rows = [row(), row({ currencyCode: "CNY", store: "second.myshopify.com" })];
  assert.equal(exportedCell([row()], "Store"), "acme.myshopify.com");
  assert.equal(exportedCell([row()], "Currency"), "USD");
  assert.equal(exportedCell(rows.slice(1), "Store"), "second.myshopify.com");
  assert.equal(exportedCell(rows.slice(1), "Currency"), "CNY");
  // 来源列必须在第一列，商家把几家店的文件并排放时第一眼就能分开。
  assert.equal(REORDER_EXPORT_HEADERS[0], "Store");
});

test("an empty export still tells the spreadsheet what columns to expect", () => {
  const csv = buildReorderCsv([]);
  assert.deepEqual(splitCsvLine(csv.split("\r\n")[0]), REORDER_EXPORT_HEADERS);
  assert.equal(csv.split("\r\n").length, 2);
});

test("text with commas, quotes or newlines gets wrapped and doubled", () => {
  assert.equal(
    exportedCell([row({ productTitle: 'Oxford "Slim" Shirt' })], "Product"),
    'Oxford "Slim" Shirt',
  );
  assert.equal(
    exportedCell([row({ variantTitle: "M, Natural" })], "Variant"),
    "M, Natural",
  );
  // 换行包在引号里，不会被当成行分隔符。
  const raw = exportedRaw([row({ sku: "A\nB" })], "SKU");
  assert.equal(raw, '"A\nB"');
  assert.equal(buildReorderCsv([row({ sku: "A\nB" })]).split("\r\n").length, 3);
});

test("formula-looking cells are neutralised before they reach a spreadsheet", () => {
  for (const prefix of ["=", "+", "-", "@"]) {
    assert.equal(
      exportedRaw([row({ productTitle: `${prefix}SUM(1+1)` })], "Product"),
      `'${prefix}SUM(1+1)`,
      `${prefix} should be guarded`,
    );
  }
  // 中划线出现在文案中间时不该被误伤。
  assert.equal(
    exportedCell([row({ productTitle: "Well-known brand" })], "Product"),
    "Well-known brand",
  );
});

test("numbers keep two decimals unless they are whole", () => {
  assert.equal(exportedCell([row()], "Available"), "12");
  assert.equal(exportedCell([row()], "Observed daily sales"), "1.90");
  assert.equal(exportedCell([row()], "Target stock"), "66.50");
  assert.equal(exportedCell([row()], "Unit cost"), "3.50");
});

test("unknown values export as blanks, not as the word null", () => {
  const blanks = [
    "SKU",
    "Days of coverage",
    "Est. stockout date",
    "Reorder point",
    "Target stock",
    "Your quantity",
    "Unit cost",
    "Inventory value",
    "Data synced at",
  ];
  const rows = [
    row({
      sku: null,
      daysOfInventory: null,
      estimatedStockoutDate: null,
      reorderPoint: null,
      targetStock: null,
      decidedQuantity: null,
      unitCost: null,
      inventoryValue: null,
      syncedAt: null,
    }),
  ];
  for (const header of blanks) {
    assert.equal(exportedCell(rows, header), "", `${header} should be blank`);
  }
});

test("confidence notes stay one readable column", () => {
  assert.equal(
    exportedCell([row()], "Confidence notes"),
    "Only 10 visible sales days; 60-day history only",
  );
  const noteWithComma = exportedCell(
    [
      row({
        confidenceReasons: ["Costs are not readable, so value is an estimate"],
      }),
    ],
    "Confidence notes",
  );
  assert.equal(
    noteWithComma,
    "Costs are not readable, so value is an estimate",
  );
  assert.equal(
    exportedCell([row({ confidenceReasons: [] })], "Confidence notes"),
    "",
  );
});

test("the file name is date-stamped for the merchant's own records", () => {
  assert.equal(
    buildReorderFileName("2026-11-01"),
    "mypi-reorder-plan-2026-11-01.csv",
  );
});

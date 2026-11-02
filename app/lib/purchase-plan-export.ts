/**
 * 采购计划 CSV：一行一份计划明细，供应商拿到文件就能按行下单。
 * 转义与格式化复用补货导出的同一套口径（escapeCsvCell / formatCsvCell）。
 * 用 .ts 扩展名 import，让 node --test 能直接加载断言列顺序与转义。
 */
import { escapeCsvCell, formatCsvCell } from "./reorder-export.ts";

export type PurchasePlanExportRow = {
  reference: string;
  planStatus: string;
  supplierName: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  unitCost: number | null;
  lineValue: number | null;
  currencyCode: string;
  purchaseDate: string | null;
  planNotes: string | null;
  createdAt: string;
};

type Column = {
  header: string;
  get: (row: PurchasePlanExportRow) => string | number | null | undefined;
};

const COLUMNS: Column[] = [
  { header: "Plan", get: (row) => row.reference },
  { header: "Plan status", get: (row) => row.planStatus },
  { header: "Supplier", get: (row) => row.supplierName },
  { header: "Product", get: (row) => row.productTitle },
  { header: "Variant", get: (row) => row.variantTitle },
  { header: "SKU", get: (row) => row.sku },
  { header: "Quantity", get: (row) => row.quantity },
  { header: "Currency", get: (row) => row.currencyCode },
  { header: "Unit cost", get: (row) => row.unitCost },
  { header: "Line value", get: (row) => row.lineValue },
  { header: "Purchase date", get: (row) => row.purchaseDate },
  { header: "Plan notes", get: (row) => row.planNotes },
  { header: "Plan created", get: (row) => row.createdAt },
];

/** 表头顺序的唯一来源。 */
export const PURCHASE_PLAN_EXPORT_HEADERS: string[] = COLUMNS.map(
  (column) => column.header,
);

export function buildPurchasePlanCsv(
  rows: PurchasePlanExportRow[],
): string {
  const lines = [COLUMNS.map((column) => escapeCsvCell(column.header)).join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => formatCsvCell(column.get(row))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * 文件名：单计划导出带上编号，商家对账时能一眼对上；全量导出用复数。
 * 编号里的空格（不会有）与路径分隔符做兜底清理。
 */
export function buildPurchasePlanFileName(
  today: string,
  reference?: string,
): string {
  if (!reference) return `mypi-purchase-plans-${today}.csv`;
  const safe = reference.replace(/[^A-Za-z0-9._-]/g, "-");
  return `mypi-purchase-plan-${safe}-${today}.csv`;
}

/**
 * CSV 序列化成纯函数：不碰数据库也不碰 Response，方便单测列顺序与转义。
 * 列里同时放诊断、建议、置信度与决策状态，让导出的文件本身就能解释「为什么是这个数」。
 */

export type ReorderExportRow = {
  /** 来源店铺域名：商家可能同时跑几家店，文件本身必须能对上号。 */
  store: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  healthStatus: string;
  actionState: string;
  available: number;
  incoming: number;
  observedDemandQuantity: number;
  observedDemandWindowDays: number;
  observedDemandSampleDays: number;
  observedDailySales: number;
  daysOfInventory: number | null;
  estimatedStockoutDate: string | null;
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyStockDays: number;
  coverageDays: number;
  reorderPoint: number | null;
  targetStock: number | null;
  suggestedQuantity: number;
  decidedQuantity: number | null;
  confidence: string;
  confidenceReasons: string[];
  unitCost: number | null;
  inventoryValue: number | null;
  /** 金额列的计价币种，来自店铺设置；没有它，导出的数字无法判断是哪国货币。 */
  currencyCode: string;
  snapshotDate: string;
  syncedAt: string | null;
};

type Column = {
  header: string;
  get: (row: ReorderExportRow) => string | number | null | undefined;
};

const COLUMNS: Column[] = [
  { header: "Store", get: (row) => row.store },
  { header: "Product", get: (row) => row.productTitle },
  { header: "Variant", get: (row) => row.variantTitle },
  { header: "SKU", get: (row) => row.sku },
  { header: "Stock status", get: (row) => row.healthStatus },
  { header: "Action state", get: (row) => row.actionState },
  { header: "Available", get: (row) => row.available },
  { header: "Incoming", get: (row) => row.incoming },
  {
    header: "Observed demand (units)",
    get: (row) => row.observedDemandQuantity,
  },
  {
    header: "Observed demand window (days)",
    get: (row) => row.observedDemandWindowDays,
  },
  {
    header: "Visible sample days",
    get: (row) => row.observedDemandSampleDays,
  },
  { header: "Observed daily sales", get: (row) => row.observedDailySales },
  { header: "Days of coverage", get: (row) => row.daysOfInventory },
  { header: "Est. stockout date", get: (row) => row.estimatedStockoutDate },
  { header: "Lead time (days)", get: (row) => row.leadTimeDays },
  { header: "Review period (days)", get: (row) => row.reviewPeriodDays },
  { header: "Safety stock (days)", get: (row) => row.safetyStockDays },
  { header: "Coverage days", get: (row) => row.coverageDays },
  { header: "Reorder point", get: (row) => row.reorderPoint },
  { header: "Target stock", get: (row) => row.targetStock },
  { header: "Suggested quantity", get: (row) => row.suggestedQuantity },
  { header: "Your quantity", get: (row) => row.decidedQuantity },
  { header: "Reorder confidence", get: (row) => row.confidence },
  {
    header: "Confidence notes",
    get: (row) => row.confidenceReasons.join("; "),
  },
  { header: "Currency", get: (row) => row.currencyCode },
  { header: "Unit cost", get: (row) => row.unitCost },
  { header: "Inventory value", get: (row) => row.inventoryValue },
  { header: "Snapshot date", get: (row) => row.snapshotDate },
  { header: "Data synced at", get: (row) => row.syncedAt },
];

/** 表头顺序的唯一来源，导出文件名之外不再别处复制一遍。 */
export const REORDER_EXPORT_HEADERS: string[] = COLUMNS.map(
  (column) => column.header,
);

/**
 * 单个字段转义：含逗号、引号或换行才加引号，内部引号双写。
 * 以 = + - @ 开头的文本补一个前导单引号，避免电子表格把说明文案当公式执行。
 * 与 formatCsvCell 一起导出，供补货导出和采购计划导出共用同一套转义口径。
 */
export function escapeCsvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

export function formatCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return escapeCsvCell(value);
}

/** 生成 CSV 正文（不含 BOM，由导出路由决定是否加）。 */
export function buildReorderCsv(rows: ReorderExportRow[]): string {
  const lines = [COLUMNS.map((column) => escapeCsvCell(column.header)).join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => formatCsvCell(column.get(row))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** 导出文件名里的日期后缀，YYYY-MM-DD。 */
export function buildReorderFileName(today: string): string {
  return `mypi-reorder-plan-${today}.csv`;
}

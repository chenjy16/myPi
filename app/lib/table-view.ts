/**
 * Replenishment 工作列表的呈现层视图逻辑（UI 重构 spec §7.2 / §8.2）。
 *
 * 只做「搜索、排序、分页」这三件事，全部在客户端完成：数据本来已由 loader 一次算完，
 * 客户端筛选可避免每次敲关键词都重跑 loader（那会重复打 Admin API，也会把
 * recommendation_viewed 埋点重复计数）。这里不参与任何补货计算，状态机与审计语义不变。
 *
 * 纯函数模块：只依赖类型，可被 node --test 直接加载（.ts 扩展名互导约定）。
 */
import type { ActionBoardState } from "./reorder-action-board.ts";
import type { ReorderConfidenceLevel } from "./reorder-confidence.ts";
import type { InventoryHealthStatus } from "./inventory-calculations.ts";

/** 视图需要的行字段（结构性子集，DashboardVariant 天然满足，无需 cast）。 */
export type ReplenishmentRow = {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  available: number;
  incoming: number;
  averageDailySales: number;
  daysOfInventory: number | null;
  suggestedReorderQuantity: number;
  confidenceLevel: ReorderConfidenceLevel;
  status: InventoryHealthStatus;
  actionState: ActionBoardState | null;
};

/**
 * 从看板行折出视图行。刻意只取呈现字段，避免页面把整条 DashboardVariant
 * 塞进排序逻辑里，将来加列时这里是唯一改动点。
 */
export function toReplenishmentRow(source: {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  available: number;
  incoming: number;
  observedDemand: { perDay: number };
  daysOfInventory: number | null;
  suggestedReorderQuantity: number;
  confidence: { level: ReorderConfidenceLevel };
  status: InventoryHealthStatus;
  actionState: ActionBoardState | null;
}): ReplenishmentRow {
  return {
    id: source.id,
    productTitle: source.productTitle,
    variantTitle: source.variantTitle,
    sku: source.sku,
    available: source.available,
    incoming: source.incoming,
    averageDailySales: source.observedDemand.perDay,
    daysOfInventory: source.daysOfInventory,
    suggestedReorderQuantity: source.suggestedReorderQuantity,
    confidenceLevel: source.confidence.level,
    status: source.status,
    actionState: source.actionState,
  };
}

export const SORT_KEYS = [
  "priority",
  "product",
  "sku",
  "available",
  "incoming",
  "dailySales",
  "coverage",
  "suggested",
  "confidence",
  "status",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  priority: "Most urgent first",
  product: "Product name",
  sku: "SKU",
  available: "Available",
  incoming: "Incoming",
  dailySales: "Daily sales",
  coverage: "Days of coverage",
  suggested: "Suggested quantity",
  confidence: "Confidence",
  status: "Stock status",
};

export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT: SortKey = "priority";
export const PAGE_SIZES = [25, 50, 100] as const;

export type TableViewQuery = {
  search: string;
  sort: SortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
};

export const DEFAULT_QUERY: TableViewQuery = {
  search: "",
  sort: DEFAULT_SORT,
  direction: "asc",
  page: 1,
  pageSize: PAGE_SIZES[0],
};

/** 需求词归一：去首尾空白、压掉连续空格，空串表示不过滤。 */
export function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 一行可被搜索命中的文本：商品名、变体名、SKU。 */
function searchHaystack(row: ReplenishmentRow): string {
  return [row.productTitle, row.variantTitle, row.sku ?? ""]
    .join(" ")
    .toLowerCase();
}

/** 多关键词按「与」匹配：`red sku12` 必须同时命中两段。 */
export function matchesSearch(row: ReplenishmentRow, search: string): boolean {
  const normalized = normalizeSearch(search);
  if (!normalized) return true;
  const haystack = searchHaystack(row);
  return normalized.split(" ").every((term) => haystack.includes(term));
}

/** 数值列的排序原值；null（无观测销量等）统一沉到末尾。 */
function numberValue(row: ReplenishmentRow, key: SortKey): number | null {
  switch (key) {
    case "available":
      return row.available;
    case "incoming":
      return row.incoming;
    case "dailySales":
      return row.averageDailySales;
    case "suggested":
      return row.suggestedReorderQuantity;
    case "coverage":
      return row.daysOfInventory;
    case "priority":
      return row.daysOfInventory;
    default:
      return null;
  }
}

const CONFIDENCE_RANK: Record<ReorderConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** 缺货风险越高越靠前；死库存与无销量数据排在健康项之后。 */
const STATUS_RANK: Record<InventoryHealthStatus, number> = {
  stockout: 0,
  critical: 1,
  stockout_risk: 2,
  low_stock: 3,
  healthy: 4,
  overstock: 5,
  dead_stock: 6,
  no_sales: 7,
};

/**
 * 单列比较：asc 为「更有行动价值」的一端在前（priority 即最低覆盖天数在前），
 * direction=desc 只做方向翻转，null 永远沉底，不参与翻转。
 */
export function compareRows(
  a: ReplenishmentRow,
  b: ReplenishmentRow,
  key: SortKey,
  direction: SortDirection,
): number {
  if (key === "product") {
    const primary = a.productTitle.localeCompare(b.productTitle, "en");
    return applyDirection(
      primary === 0 ? a.variantTitle.localeCompare(b.variantTitle, "en") : primary,
      direction,
    );
  }

  if (key === "sku") {
    if (a.sku === null && b.sku === null) return 0;
    if (a.sku === null) return 1;
    if (b.sku === null) return -1;
    return applyDirection(a.sku.localeCompare(b.sku, "en"), direction);
  }

  if (key === "confidence") {
    return applyDirection(
      CONFIDENCE_RANK[a.confidenceLevel] - CONFIDENCE_RANK[b.confidenceLevel],
      direction,
    );
  }

  if (key === "status") {
    return applyDirection(STATUS_RANK[a.status] - STATUS_RANK[b.status], direction);
  }

  const left = numberValue(a, key);
  const right = numberValue(b, key);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left === right) {
    // 同覆盖天数时，建议量大的更该排在前面，避免每次都让商家自己再扫一遍。
    return b.suggestedReorderQuantity - a.suggestedReorderQuantity;
  }
  return applyDirection(left - right, direction);
}

function applyDirection(value: number, direction: SortDirection): number {
  return direction === "asc" ? value : -value;
}

/** 关键词 → 状态筛选 → 排序，返回全部命中行（未分页）。 */
export function searchAndSort(
  rows: ReplenishmentRow[],
  query: Pick<TableViewQuery, "search" | "sort" | "direction">,
): ReplenishmentRow[] {
  const filtered = rows.filter((row) => matchesSearch(row, query.search));
  return [...filtered].sort((a, b) =>
    compareRows(a, b, query.sort, query.direction),
  );
}

export type PagedView = {
  rows: ReplenishmentRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  /** 当前页首行在整个结果集中的序号（1 起）；无结果为 0。 */
  firstIndex: number;
  /** 当前页末行序号（含）；无结果为 0。 */
  lastIndex: number;
};

/**
 * 分页并夹紧页码：结果集变小时不留在空白页，totalRows=0 时返回空页而不是越界页。
 */
export function paginate(rows: ReplenishmentRow[], page: number, pageSize: number): PagedView {
  const safePageSize = pageSize > 0 ? pageSize : DEFAULT_QUERY.pageSize;
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / safePageSize));
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const start = (safePage - 1) * safePageSize;
  const slice = rows.slice(start, start + safePageSize);
  return {
    rows: slice,
    page: safePage,
    pageSize: safePageSize,
    totalRows,
    totalPages,
    firstIndex: totalRows === 0 ? 0 : start + 1,
    lastIndex: totalRows === 0 ? 0 : start + slice.length,
  };
}

/** 页面唯一入口：搜索 + 排序 + 分页一步到位。 */
export function buildTableView(
  rows: ReplenishmentRow[],
  query: TableViewQuery,
): PagedView {
  return paginate(searchAndSort(rows, query), query.page, query.pageSize);
}

/** 搜索/筛选变更时回到第 1 页，避免出现「第 7 页无结果」的死路。 */
export function resetPage(query: TableViewQuery): TableViewQuery {
  return { ...query, page: 1 };
}

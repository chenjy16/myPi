/**
 * 采购计划的状态机与归并规则，全部是纯函数：
 * 流转合法性只在这一处定义，服务层和 UI 都从这里读，避免两边各写一套再漂移。
 */

export type PurchasePlanStatus = "open" | "ordered" | "cancelled";

export const PURCHASE_PLAN_STATUS_LABELS: Record<PurchasePlanStatus, string> = {
  open: "Open",
  ordered: "Ordered",
  cancelled: "Cancelled",
};

const STATUSES: PurchasePlanStatus[] = ["open", "ordered", "cancelled"];

/** 判断数据库里的 status 是否为合法计划状态。 */
export function isPurchasePlanStatus(
  value: string,
): value is PurchasePlanStatus {
  return STATUSES.includes(value as PurchasePlanStatus);
}

/**
 * 状态流转：open 可以下单或作废；ordered / cancelled 是终态 —— 已经发生过的
 * 采购不该被事后改状态「撤销」，商家要调整就新建一份计划，账目才留得住。
 */
export function canTransitionPlanStatus(
  from: PurchasePlanStatus,
  to: PurchasePlanStatus,
): boolean {
  return from === "open" && (to === "ordered" || to === "cancelled");
}

/** 店内编号：PP-0001 起，四位补零，够用一辈子（9999 份再谈进位）。 */
export function buildPlanReference(sequence: number): string {
  return `PP-${String(sequence).padStart(4, "0")}`;
}

/** 从建议带进计划的一条草稿行（归并前的形态）。 */
export type AdviceDraftLine = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  supplierId: string | null;
  supplierName: string | null;
  unitCost: number | null;
};

export type SupplierPlanGroup = {
  supplierId: string | null;
  supplierName: string | null;
  lines: AdviceDraftLine[];
};

/**
 * 多 SKU 合并：按供应商归并草稿行，一个供应商出一份计划；
 * 没绑定供应商的变体归入「Store default」组。同一变体重复出现时数量累加
 * （正常入口不会重复，这里兜住并发双击产生的重复提交）。
 * 组序按供应商名排序，未绑定组排最后，保证同一次生成的计划顺序稳定可预期。
 */
export function groupAdviceBySupplier(
  lines: AdviceDraftLine[],
): SupplierPlanGroup[] {
  const grouped = new Map<string, SupplierPlanGroup>();
  for (const line of lines) {
    const key = line.supplierId ?? "__store_default__";
    const existing = grouped.get(key);
    if (existing) {
      const merged = existing.lines.find(
        (item) => item.variantId === line.variantId,
      );
      if (merged) {
        merged.quantity += line.quantity;
      } else {
        existing.lines.push({ ...line });
      }
      continue;
    }
    grouped.set(key, {
      supplierId: line.supplierId,
      supplierName: line.supplierName,
      lines: [{ ...line }],
    });
  }
  return Array.from(grouped.values()).sort((left, right) => {
    if (left.supplierId === null) return 1;
    if (right.supplierId === null) return -1;
    return (left.supplierName ?? "").localeCompare(right.supplierName ?? "");
  });
}

/** 校验改量输入：正整数且不超过 Int 上限，非法返回 null 由调用方给文案。 */
export function parsePlanQuantity(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647
    ? parsed
    : null;
}

/** 采购日期收口：只接受 YYYY-MM-DD 的历法上合法的日期，否则 null。 */
export function parsePurchaseDate(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
}

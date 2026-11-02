export type InventoryHealthStatus =
  | "stockout"
  | "critical"
  | "stockout_risk"
  | "low_stock"
  | "healthy"
  | "overstock"
  | "dead_stock"
  | "no_sales";

/** 库存健康状态的对外文案，页面与 CSV 导出共用一份，避免两边说法漂移。 */
export const INVENTORY_STATUS_LABELS: Record<InventoryHealthStatus, string> = {
  stockout: "Out of stock",
  critical: "Critical stock",
  stockout_risk: "Stockout risk",
  low_stock: "Low stock",
  healthy: "Healthy",
  overstock: "Overstock",
  dead_stock: "Dead stock",
  no_sales: "No sales data",
};

/** Observed Demand 的默认观察窗口（天）。P0-lite 只做需求观测，不还原缺货期的真实需求。 */
export const DEFAULT_DEMAND_WINDOW_DAYS = 30;

/**
 * 观测到的需求：只统计「看得见订单的日子里卖掉的量」。
 * perDay 用 sampleDaysAvailable 当分母而不是窗口天数，避免读不到的天数被当成零销量把日均稀释。
 */
export type ObservedDemand = {
  windowDays: number;
  sampleDaysAvailable: number;
  quantity: number;
  perDay: number;
  daysWithSales: number | null;
};

/** 基础补货公式的每一项，供页面把算法摊开展示。 */
export type ReplenishmentPlan = {
  observedDemand: ObservedDemand;
  leadTimeDays: number;
  reviewPeriodDays: number;
  safetyStockDays: number;
  coverageDays: number;
  targetStock: number | null;
  available: number;
  incoming: number;
  suggestedQuantity: number;
  formula: string;
};

/** 变体绑定生效时的供货条款（来自 Supplier + VariantSupplier，停用供应商不参与）。 */
export type VariantSupplyTerms = {
  supplierName: string;
  /** 供应商级交期；null 表示沿用店铺参数。 */
  leadTimeDays: number | null;
  /** 最小起订量（件）；0 = 无门槛。 */
  minOrderQuantity: number;
  /** 整箱单位（件/箱）；0 或 1 = 不按箱取整。 */
  casePack: number;
};

/** 取整过程的完整留痕，让公式能把「原始需求 → 订多少」解释到底。 */
export type SupplierTermsApplied = {
  supplierName: string;
  /** 本次计算实际使用的交期。 */
  leadTimeDaysUsed: number;
  storeLeadTimeDays: number;
  /** 未经供货条款取整的原始建议量。 */
  rawQuantity: number;
  finalQuantity: number;
  minOrderQuantity: number;
  casePack: number;
};

/**
 * 按供货条款向上取整：订出的量必须既是整箱、又达到 MOQ。
 * 有箱规时按「够覆盖原始需求」与「够凑到 MOQ」里更大的箱数取整；
 * 无箱规时只抬到 MOQ。原始量 ≤0 直接返回 0 —— 缺库存不等于要下采购单。
 */
export function roundUpToSupplyTerms(
  rawQuantity: number,
  terms: Pick<VariantSupplyTerms, "minOrderQuantity" | "casePack">,
): number {
  if (rawQuantity <= 0) return 0;
  const pack = terms.casePack > 1 ? terms.casePack : 0;
  if (pack > 0) {
    const cases = Math.max(
      Math.ceil(rawQuantity / pack),
      Math.ceil(terms.minOrderQuantity / pack),
    );
    return cases * pack;
  }
  return Math.max(rawQuantity, terms.minOrderQuantity);
}

export type InventoryHealthInput = {
  available: number;
  incoming: number;
  unitCost: number | null;
  sales30Days: number;
  sales60Days: number;
  sales90Days: number | null;
  leadTimeDays: number;
  safetyStockDays: number;
  reviewPeriodDays: number;
  today: string;
  /** 观察窗口天数，默认 30。 */
  demandWindowDays?: number;
  /** 当前授权与同步进度下真正可见的窗口内天数，缺省按满窗口处理。 */
  sampleDaysAvailable?: number;
  /** 窗口内有过销量的天数，用于判断需求是否稀疏。 */
  daysWithSales?: number;
  /** 变体绑定的生效供货条款；不传即按店铺参数、不做起订取整。 */
  supplyTerms?: VariantSupplyTerms | null;
};

export type InventoryHealth = InventoryHealthInput & {
  averageDailySales: number;
  averageDailySales60Days: number;
  averageDailySales90Days: number | null;
  daysOfInventory: number | null;
  reorderPoint: number | null;
  targetStock: number | null;
  suggestedReorderQuantity: number;
  estimatedStockoutDate: string | null;
  status: InventoryHealthStatus;
  reorderReason: string;
  inventoryValue: number | null;
  observedDemand: ObservedDemand;
  replenishment: ReplenishmentPlan;
  /** 供货条款生效时的完整留痕；未绑定或供应商停用时为 null。 */
  supplierTermsApplied: SupplierTermsApplied | null;
};

/** 按可见样本天数把窗口总量折算成观测日均。 */
export function buildObservedDemand(
  quantity: number,
  input: Pick<
    InventoryHealthInput,
    "demandWindowDays" | "sampleDaysAvailable" | "daysWithSales"
  >,
): ObservedDemand {
  const windowDays = input.demandWindowDays ?? DEFAULT_DEMAND_WINDOW_DAYS;
  const rawSampleDays = input.sampleDaysAvailable ?? windowDays;
  const sampleDaysAvailable = Math.max(
    0,
    Math.min(windowDays, Math.floor(rawSampleDays)),
  );
  return {
    windowDays,
    sampleDaysAvailable,
    quantity,
    perDay: sampleDaysAvailable > 0 ? quantity / sampleDaysAvailable : 0,
    daysWithSales: input.daysWithSales ?? null,
  };
}

/**
 * 按确定性规则计算库存健康：日均销量、覆盖天数、补货点、目标库存、建议量、缺货日和风险状态。
 * 不访问 Shopify / 数据库 / 模型。
 */
export function calculateInventoryHealth(
  input: InventoryHealthInput,
): InventoryHealth {
  const observedDemand = buildObservedDemand(input.sales30Days, input);
  const averageDailySales = observedDemand.perDay;
  const averageDailySales60Days = input.sales60Days / 60;
  const averageDailySales90Days =
    input.sales90Days === null ? null : input.sales90Days / 90;
  const hasSales = averageDailySales > 0;
  // 供应商级交期优先：绑定了自己的 lead time 就用它，风险判定与目标库存同步生效。
  const supplyTerms = input.supplyTerms ?? null;
  const leadTimeDaysUsed =
    supplyTerms?.leadTimeDays ?? input.leadTimeDays;
  const daysOfInventory = hasSales ? input.available / averageDailySales : null;
  const reorderPoint = hasSales
    ? averageDailySales * (leadTimeDaysUsed + input.safetyStockDays)
    : null;
  const targetStock = hasSales
    ? averageDailySales * (leadTimeDaysUsed + input.reviewPeriodDays) +
      averageDailySales * input.safetyStockDays
    : null;
  const rawSuggestedQuantity =
    targetStock === null
      ? 0
      : Math.max(0, Math.ceil(targetStock - input.available - input.incoming));
  const suggestedReorderQuantity = supplyTerms
    ? roundUpToSupplyTerms(
        rawSuggestedQuantity,
        supplyTerms,
      )
    : rawSuggestedQuantity;
  const supplierTermsApplied: SupplierTermsApplied | null = supplyTerms
    ? {
        supplierName: supplyTerms.supplierName,
        leadTimeDaysUsed,
        storeLeadTimeDays: input.leadTimeDays,
        rawQuantity: rawSuggestedQuantity,
        finalQuantity: suggestedReorderQuantity,
        minOrderQuantity: supplyTerms.minOrderQuantity,
        casePack: supplyTerms.casePack,
      }
    : null;
  const coverageDays =
    leadTimeDaysUsed + input.reviewPeriodDays + input.safetyStockDays;
  const estimatedStockoutDate =
    daysOfInventory === null
      ? null
      : shiftDate(input.today, Math.ceil(daysOfInventory));
  const inventoryValue =
    input.unitCost === null ? null : input.available * input.unitCost;

  let status: InventoryHealthStatus;
  if (input.available <= 0) {
    status = "stockout";
  } else if (averageDailySales === 0) {
    status =
      input.sales90Days === 0
        ? "dead_stock"
        : input.sales90Days === null
          ? "no_sales"
          : "no_sales";
  } else if (daysOfInventory! > 90) {
    status = "overstock";
  } else if (daysOfInventory! <= input.safetyStockDays) {
    status = "critical";
  } else if (daysOfInventory! <= leadTimeDaysUsed) {
    status = "stockout_risk";
  } else if (input.available <= reorderPoint!) {
    status = "low_stock";
  } else {
    status = "healthy";
  }

  const supplyNotes: string[] = [];
  if (supplyTerms && supplyTerms.leadTimeDays !== null) {
    supplyNotes.push(
      `lead time uses ${supplyTerms.supplierName} (${supplyTerms.leadTimeDays} days) instead of the store setting (${input.leadTimeDays} days)`,
    );
  }
  if (
    supplyTerms &&
    rawSuggestedQuantity > 0 &&
    suggestedReorderQuantity !== rawSuggestedQuantity
  ) {
    const termsText = [
      supplyTerms.casePack > 1 ? `case pack ${supplyTerms.casePack}` : null,
      supplyTerms.minOrderQuantity > 0
        ? `MOQ ${supplyTerms.minOrderQuantity}`
        : null,
    ]
      .filter(Boolean)
      .join(" and ");
    supplyNotes.push(
      `${rawSuggestedQuantity} units raw need rounds up to ${suggestedReorderQuantity} to order in full packs and meet ${termsText}`,
    );
  }
  const formula =
    reorderPoint === null
      ? `Observed demand is ${formatQuantity(averageDailySales)} units/day over ${observedDemand.sampleDaysAvailable} visible days, so no reorder point can be calculated.`
      : `${formatQuantity(averageDailySales)} units/day (${observedDemand.quantity} units observed over ${observedDemand.sampleDaysAvailable} visible days) x ${coverageDays} coverage days (${leadTimeDaysUsed} lead + ${input.reviewPeriodDays} review + ${input.safetyStockDays} safety) = ${formatQuantity(targetStock!)} target stock; ${formatQuantity(targetStock!)} - ${input.available} on hand - ${input.incoming} incoming = ${suggestedReorderQuantity} units to reorder.${
          supplyNotes.length > 0 ? ` ${supplyNotes.join("; ")}.` : ""
        }`;
  const reorderReason =
    reorderPoint === null
      ? "No sales were observed inside the window this account can read, so a reorder point can't be calculated. Recommendations resume once observed demand exists."
      : formula;

  return {
    ...input,
    averageDailySales,
    averageDailySales60Days,
    averageDailySales90Days,
    daysOfInventory,
    reorderPoint,
    targetStock,
    suggestedReorderQuantity,
    estimatedStockoutDate,
    status,
    reorderReason,
    inventoryValue,
    observedDemand,
    replenishment: {
      observedDemand,
      leadTimeDays: leadTimeDaysUsed,
      reviewPeriodDays: input.reviewPeriodDays,
      safetyStockDays: input.safetyStockDays,
      coverageDays,
      targetStock,
      available: input.available,
      incoming: input.incoming,
      suggestedQuantity: suggestedReorderQuantity,
      formula,
    },
    supplierTermsApplied,
  };
}

/**
 * 闭区间日历天数（含首尾）。起日大于止日时返回 0，不返负数。
 * 用于把「可见历史起点」换算成样本天数。
 */
export function countDaysInclusive(from: string, to: string): number {
  if (from > to) return 0;
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const diff =
    Date.UTC(toYear, toMonth - 1, toDay) -
    Date.UTC(fromYear, fromMonth - 1, fromDay);
  return Math.floor(diff / 86_400_000) + 1;
}

/** 在 YYYY-MM-DD 上加减整天数（按 UTC 日历，避免本地时区把日期算偏）。 */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** 把时间点格式化为指定 IANA 时区下的店铺日历日期 YYYY-MM-DD。 */
export function formatDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** 补货说明文案里的数量展示：整数原样，小数保留一位。 */
function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

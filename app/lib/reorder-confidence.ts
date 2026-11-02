import type { ObservedDemand } from "./inventory-calculations";

export type ReorderConfidenceLevel = "high" | "medium" | "low";

/**
 * hard 直接判 low（数字本身不可信）；soft 累计降档；info 只披露不参与降档。
 * 目的只有一个：数据不完整时不给商家虚假精确度。
 */
export type ConfidenceReasonTone = "hard" | "soft" | "info";

export type ConfidenceReason = {
  code: string;
  label: string;
  tone: ConfidenceReasonTone;
};

export type ReorderConfidence = {
  level: ReorderConfidenceLevel;
  reasons: ConfidenceReason[];
};

/** 快照超过这个小时数就认为库存数字已经过期，不足以支撑一次采购决策。 */
export const SNAPSHOT_STALE_HOURS = 48;

/** 窗口内有过销量的天数占比低于这个比例，视为需求稀疏，日均不可靠。 */
const SPARSE_SALES_RATIO = 0.3;

export type ConfidenceInput = {
  /** 最新快照距今小时数；null 表示该地点还没有任何快照。 */
  snapshotAgeHours: number | null;
  observedDemand: ObservedDemand;
  /** 当前授权可回看的销售历史天数（无 read_all_orders 时为 60）。 */
  historyDaysAvailable: number;
  /** 该变体是否读不到单位成本（只影响库存价值，不影响补货量）。 */
  unitCostMissing: boolean;
  /** 数据健康已判定暂停出建议。 */
  dataPaused: boolean;
};

/** 按固定规则给一条补货建议打置信度档位，并列出为什么降档。 */
export function calculateReorderConfidence(
  input: ConfidenceInput,
): ReorderConfidence {
  const reasons: ConfidenceReason[] = [];
  const { observedDemand } = input;

  if (input.dataPaused) {
    reasons.push({
      code: "data_paused",
      label: "Recommendations are paused because store data is unreliable.",
      tone: "hard",
    });
  }
  if (input.snapshotAgeHours === null) {
    reasons.push({
      code: "no_snapshot",
      label: "No inventory snapshot has been captured for this location yet.",
      tone: "hard",
    });
  } else if (input.snapshotAgeHours > SNAPSHOT_STALE_HOURS) {
    reasons.push({
      code: "snapshot_stale",
      label: `The newest inventory snapshot is ${Math.round(input.snapshotAgeHours)} hours old.`,
      tone: "hard",
    });
  }
  if (observedDemand.sampleDaysAvailable === 0) {
    reasons.push({
      code: "no_visible_days",
      label:
        "No days are visible inside the demand window, so daily sales can't be observed.",
      tone: "hard",
    });
  }

  if (input.historyDaysAvailable < 90) {
    reasons.push({
      code: "history_60d_only",
      label: `This authorization can only read ${input.historyDaysAvailable} days of order history, so long-run demand can't be verified.`,
      tone: "soft",
    });
  }
  if (
    observedDemand.sampleDaysAvailable > 0 &&
    observedDemand.sampleDaysAvailable < observedDemand.windowDays
  ) {
    reasons.push({
      code: "short_sample",
      label: `Daily sales come from ${observedDemand.sampleDaysAvailable} visible days instead of the full ${observedDemand.windowDays}-day window.`,
      tone: "soft",
    });
  }
  const daysWithSales = observedDemand.daysWithSales;
  if (
    daysWithSales !== null &&
    observedDemand.sampleDaysAvailable > 0 &&
    daysWithSales / observedDemand.sampleDaysAvailable < SPARSE_SALES_RATIO
  ) {
    reasons.push({
      code: "sparse_sales",
      label: `Only ${daysWithSales} of ${observedDemand.sampleDaysAvailable} visible days had any sales, so demand is irregular.`,
      tone: "soft",
    });
  }

  if (input.unitCostMissing) {
    reasons.push({
      code: "cost_unavailable",
      label:
        "Product cost isn't readable, so inventory value is an incomplete estimate.",
      tone: "info",
    });
  }

  const hard = reasons.filter((reason) => reason.tone === "hard");
  const soft = reasons.filter((reason) => reason.tone === "soft");
  const level: ReorderConfidenceLevel =
    hard.length > 0
      ? "low"
      : soft.length >= 2
        ? "low"
        : soft.length === 1
          ? "medium"
          : "high";

  // hard 排在前面，页面第一眼就能看到「为什么这条不该直接照抄」。
  return {
    level,
    reasons: [
      ...hard,
      ...soft,
      ...reasons.filter((reason) => reason.tone === "info"),
    ],
  };
}

/** 校验数据库或表单里的置信度档位是否合法。 */
export function isReorderConfidenceLevel(
  value: string,
): value is ReorderConfidenceLevel {
  return value === "high" || value === "medium" || value === "low";
}

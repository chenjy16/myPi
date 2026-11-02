import type { ReorderDecisionStatus } from "./reorder-recommendations";

/**
 * Action Board 的六态：五个落库的决策态加上一个运行时派生的 paused。
 * paused 不写进 ReorderRecommendation.status，避免数据抖动覆盖掉商家已经表过的态。
 */
export type ActionBoardState = ReorderDecisionStatus | "paused";

export const ACTION_BOARD_STATES: ActionBoardState[] = [
  "paused",
  "pending",
  "accepted",
  "edited",
  "ignored",
  "ordered",
];

export const ACTION_BOARD_LABELS: Record<ActionBoardState, string> = {
  paused: "Paused",
  pending: "Pending review",
  accepted: "Accepted",
  edited: "Adjusted",
  ignored: "Ignored",
  ordered: "Ordered",
};

export const ACTION_BOARD_HINTS: Record<ActionBoardState, string> = {
  paused: "Store data is unreliable, so no recommendation should be acted on.",
  pending: "A suggestion is waiting for you to accept, adjust or ignore it.",
  accepted: "You accepted the suggested quantity as-is.",
  edited: "You kept the recommendation but changed the quantity.",
  ignored: "You decided not to purchase this round.",
  ordered: "You raised the purchase and marked it ordered.",
};

export type ActionBoardRowInput = {
  /** 本次计算是否给出正数建议。 */
  hasLiveSuggestion: boolean;
  /** 落库的决策态，null 表示这行还没登记过。 */
  status: ReorderDecisionStatus | null;
  /** 同步后建议量与商家确认时的数字不一致。 */
  needsReview: boolean;
  /** 数据健康判定为暂停。 */
  paused: boolean;
};

/**
 * 把一行归到六态之一，返回 null 表示不进 Action Board。
 * 已下单的行永远保留；已接受/已调整的行即使建议消失也保留，方便回溯；
 * 没表过态或已忽略的行在建议消失后不再占位。
 */
export function resolveActionBoardState(
  row: ActionBoardRowInput,
): ActionBoardState | null {
  if (row.status === "ordered") return "ordered";

  if (!row.hasLiveSuggestion) {
    if (row.status === "accepted" || row.status === "edited") {
      return row.status;
    }
    return null;
  }

  // 暂停优先于待办，但不覆盖已经完成的采购动作，商家不应被系统改写历史。
  if (row.paused) return "paused";
  if (!row.status || row.status === "pending") return "pending";
  if (
    row.needsReview &&
    (row.status === "accepted" || row.status === "edited")
  ) {
    return "pending";
  }
  return row.status;
}

export type ActionBoardCounts = Record<ActionBoardState, number>;

/** 按六态计数，供 Tab 标签与采纳指标共用。 */
export function summarizeActionBoard(
  states: (ActionBoardState | null)[],
): ActionBoardCounts {
  const counts = Object.fromEntries(
    ACTION_BOARD_STATES.map((state) => [state, 0]),
  ) as ActionBoardCounts;
  for (const state of states) {
    if (state) counts[state] += 1;
  }
  return counts;
}

/**
 * 北极星指标：采纳率只看「已表态的建议里有多少被采纳」，处理进度单独给。
 * 分母为 0 时返回 null，让页面显示破折号而不是假的 0%。
 */
export function calculateAdoptionMetrics(counts: ActionBoardCounts): {
  adoptionRate: number | null;
  reviewedRate: number | null;
  actionableCount: number;
} {
  const reviewed =
    counts.accepted + counts.edited + counts.ignored + counts.ordered;
  const adopted = counts.accepted + counts.edited + counts.ordered;
  const actionable =
    counts.pending +
    counts.accepted +
    counts.edited +
    counts.ignored +
    counts.ordered;

  return {
    adoptionRate: reviewed > 0 ? adopted / reviewed : null,
    reviewedRate: actionable > 0 ? reviewed / actionable : null,
    actionableCount: actionable,
  };
}

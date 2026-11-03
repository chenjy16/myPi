/**
 * 业务状态语义的唯一来源（UI 重构 spec §8.6）。
 * 同一个状态在所有页面必须得到同一 tone 与同一文案；页面不得自建 tone-map。
 * 纯数据模块：可被 node --test 直接加载（.ts 扩展名互导约定）。
 */
import { INVENTORY_STATUS_LABELS } from "./inventory-calculations.ts";
import type { DataHealthState, DataHealthTone } from "./data-health.ts";
import type { ActionBoardState } from "./reorder-action-board.ts";
import type { InventoryHealthStatus } from "./inventory-calculations.ts";
import type { ReorderConfidenceLevel } from "./reorder-confidence.ts";
import type { SyncStatusName } from "./sync-job-policy.ts";
import type { FreshnessTone } from "./sync-freshness.ts";
import { isPurchasePlanStatus, type PurchasePlanStatus } from "./purchase-plans.ts";

/** 补货建议 / 采购计划 / 同步台账的全部业务态。 */
export type BusinessState =
  | "pending"
  | "accepted"
  | "edited"
  | "ignored"
  | "ordered"
  | "open"
  | "cancelled"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "paused";

/** Data Health 检查项的健康度（锚定 lib/data-health 的既有 tone，不另立体系）。 */
export type HealthTone = DataHealthTone;

/** 视觉 tone：与 dashboard.css 的 pill* 类一一对应。 */
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "critical";

export const STATUS_TONE: Record<BusinessState, StatusTone> = {
  pending: "neutral",
  accepted: "info",
  edited: "info",
  ignored: "neutral",
  ordered: "success",
  open: "info",
  cancelled: "neutral",
  running: "info",
  succeeded: "success",
  partial: "warning",
  failed: "critical",
  paused: "warning",
};

export const STATUS_LABEL: Record<BusinessState, string> = {
  pending: "Pending review",
  accepted: "Accepted",
  edited: "Adjusted",
  ignored: "Ignored",
  ordered: "Ordered",
  open: "Open",
  cancelled: "Cancelled",
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
  paused: "Paused",
};

export const HEALTH_TONE: Record<HealthTone, StatusTone> = {
  ok: "success",
  warn: "warning",
  critical: "critical",
};

/** 文案沿用 Data Health 页现有口径（Pass / Needs attention / Blocking）。 */
export const HEALTH_LABEL: Record<HealthTone, string> = {
  ok: "Pass",
  warn: "Needs attention",
  critical: "Blocking",
};

/** tone → 样式类（dashboard.css 的 .dsPill + pill* 组合）。 */
export const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "pillMuted",
  info: "pillInfo",
  success: "pillActive",
  warning: "pillDraft",
  critical: "pillCritical",
};

export type StatusView = { tone: StatusTone; label: string; className: string };

/** 业务状态的展示视图：文案 + tone + 类，全站唯一出口。 */
export function statusView(state: BusinessState): StatusView {
  const tone = STATUS_TONE[state];
  return { tone, label: STATUS_LABEL[state], className: TONE_CLASS[tone] };
}

/** 健康检查项的展示视图。 */
export function healthView(tone: HealthTone): StatusView {
  const resolved = HEALTH_TONE[tone];
  return {
    tone: resolved,
    label: HEALTH_LABEL[tone],
    className: TONE_CLASS[resolved],
  };
}

/**
 * Action Board 六态与业务态词汇完全重叠，直接复用同一映射，
 * 这样 Tab、行内徽章、CSV 与审计文案说的是同一套话（spec §8.6）。
 */
export function actionStateView(state: ActionBoardState): StatusView {
  return statusView(state);
}

/** 语义 tone → Polaris `s-badge` 的 tone 取值（warning 在徽章上是 caution）。 */
export const POLARIS_BADGE_TONE: Record<
  StatusTone,
  "neutral" | "info" | "success" | "caution" | "critical"
> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "caution",
  critical: "critical",
};

/** 置信度文案：与库存页既有说法一致，全站唯一。 */
export const CONFIDENCE_LABEL: Record<ReorderConfidenceLevel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

export const CONFIDENCE_TONE: Record<ReorderConfidenceLevel, StatusTone> = {
  high: "success",
  medium: "warning",
  low: "critical",
};

/** 置信度的展示视图（spec §10：Confidence 必须有一致定义与展示方式）。 */
export function confidenceView(level: ReorderConfidenceLevel): StatusView {
  const tone = CONFIDENCE_TONE[level];
  return { tone, label: CONFIDENCE_LABEL[level], className: TONE_CLASS[tone] };
}

/** 同步状态文案，沿用库存页既有口径（P0-2）。 */
export const SYNC_LABEL: Record<SyncStatusName, string> = {
  never: "Never synced",
  running: "Syncing",
  succeeded: "Up to date",
  failed: "Last sync failed",
};

export const SYNC_TONE: Record<SyncStatusName, StatusTone> = {
  never: "neutral",
  running: "info",
  succeeded: "success",
  failed: "critical",
};

/** 同步状态的展示视图。 */
export function syncStatusView(current: SyncStatusName): StatusView {
  const tone = SYNC_TONE[current];
  return { tone, label: SYNC_LABEL[current], className: TONE_CLASS[tone] };
}

/**
 * 库存健康度 → tone。文案继续用 lib/inventory-calculations 的唯一来源（页面与 CSV
 * 共用），这里只补tone，所以不会第二套说法。
 * 口径：红色＝已经断货或库存见底，橙色＝覆盖偏薄，绿色＝正常，蓝色＝压货，灰色＝没有信号。
 */
export const INVENTORY_STATUS_TONE: Record<
  InventoryHealthStatus,
  StatusTone
> = {
  stockout: "critical",
  critical: "critical",
  stockout_risk: "warning",
  low_stock: "warning",
  healthy: "success",
  overstock: "info",
  dead_stock: "neutral",
  no_sales: "neutral",
};

/** 库存健康度的展示视图。 */
export function inventoryStatusView(status: InventoryHealthStatus): StatusView {
  const tone = INVENTORY_STATUS_TONE[status];
  return {
    tone,
    label: INVENTORY_STATUS_LABELS[status],
    className: TONE_CLASS[tone],
  };
}

/**
 * 看板整体健康度（页面标题级状态），与单个检查项的 HEALTH_LABEL 是两个层级：
 * 检查项说 “Pass / Needs attention / Blocking”，看板说的是整体能不能安全下单。
 * 文案沿用首页既有说法，不另立词汇。
 */
export const DATA_HEALTH_STATE_TONE: Record<DataHealthState, StatusTone> = {
  healthy: "success",
  degraded: "warning",
  paused: "critical",
};

export const DATA_HEALTH_STATE_LABEL: Record<DataHealthState, string> = {
  healthy: "Data sync healthy",
  degraded: "Data needs attention",
  paused: "Reorder decisions paused",
};

/** 看板健康度的展示视图。 */
export function dataHealthStateView(state: DataHealthState): StatusView {
  const tone = DATA_HEALTH_STATE_TONE[state];
  return {
    tone,
    label: DATA_HEALTH_STATE_LABEL[state],
    className: TONE_CLASS[tone],
  };
}

/**
 * 功能区就绪度：Settings 的五个分段与首页“功能未启用”标记共用一套说法。
 * 这些不是业务决策态（没有状态机），所以独立成一组，不混进 BusinessState。
 */
export type SettingReadiness =
  | "configured"
  | "needsSetup"
  | "available"
  | "storeSettings"
  | "systemEstimate"
  | "notEnabled";

export const READINESS_TONE: Record<SettingReadiness, StatusTone> = {
  configured: "success",
  needsSetup: "warning",
  available: "success",
  storeSettings: "info",
  systemEstimate: "neutral",
  notEnabled: "neutral",
};

export const READINESS_LABEL: Record<SettingReadiness, string> = {
  configured: "Configured",
  needsSetup: "Needs setup",
  available: "Available",
  storeSettings: "Store settings",
  systemEstimate: "System estimate",
  notEnabled: "Not enabled",
};

/** 就绪度的展示视图。 */
export function readinessView(kind: SettingReadiness): StatusView {
  const tone = READINESS_TONE[kind];
  return { tone, label: READINESS_LABEL[kind], className: TONE_CLASS[tone] };
}

/**
 * 同步新鲜度提示该用哪种横幅。muted（从未同步 / 正在同步）不是问题，用信息横幅；
 * 数据完全可信时返回 null，页面就不画横幅——不给商家看没有信息量的绿条。
 */
export function freshnessBannerTone(
  tone: FreshnessTone,
): "info" | "warning" | "critical" | null {
  if (tone === "ok") return null;
  if (tone === "critical") return "critical";
  if (tone === "warn") return "warning";
  return "info";
}

const BUSINESS_STATES = Object.keys(STATUS_LABEL) as BusinessState[];

/**
 * 判断审计台账里的状态字符串是否属于统一状态词汇。审计写入的是数据库原值，
 * 遇到未知历史值时页面仍原样显示，不会被徽章吞掉（不改审计语义，只决定呈现方式）。
 */
export function isBusinessState(
  value: string | null | undefined,
): value is BusinessState {
  return typeof value === "string" && BUSINESS_STATES.includes(value as BusinessState);
}

/**
 * 供应商的启停状态。刻意不复用 BusinessState 里的 paused：那个是「决策被数据
 * 质量卡住」（warning / critical 语义），这里的 paused 只是「这一家暂时不参与计算」，
 * 说成橙色会让商家以为出了问题。
 */
export type SupplierActivity = "active" | "paused";

export const SUPPLIER_ACTIVITY_TONE: Record<SupplierActivity, StatusTone> = {
  active: "success",
  paused: "neutral",
};

export const SUPPLIER_ACTIVITY_LABEL: Record<SupplierActivity, string> = {
  active: "Active",
  paused: "Paused",
};

/** 供应商启停的展示视图。 */
export function supplierActivityView(kind: SupplierActivity): StatusView {
  const tone = SUPPLIER_ACTIVITY_TONE[kind];
  return { tone, label: SUPPLIER_ACTIVITY_LABEL[kind], className: TONE_CLASS[tone] };
}

/**
 * 采购计划态的展示视图：三态的 tone 与文案完全复用 BusinessState，
 * 于是补货页、计划页、CSV 与审计说的同一套话（spec §8.6），这里不新造词汇。
 * status 来自数据库原值：认不出的历史值原样显示（呈现层兜底，不改审计语义），
 * 绝不让徽章把看不懂的记录吞成空白。
 */
export function planStatusView(status: string): StatusView {
  if (!isPurchasePlanStatus(status)) {
    return { tone: "neutral", label: status, className: TONE_CLASS.neutral };
  }
  return statusView(status as PurchasePlanStatus);
}

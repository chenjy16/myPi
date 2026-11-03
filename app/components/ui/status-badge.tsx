import {
  statusView,
  healthView,
  actionStateView,
  confidenceView,
  syncStatusView,
  inventoryStatusView,
  POLARIS_BADGE_TONE,
  type BusinessState,
  type HealthTone,
} from "../../lib/status";
import type { ActionBoardState } from "../../lib/reorder-action-board";
import type { InventoryHealthStatus } from "../../lib/inventory-calculations";
import type { ReorderConfidenceLevel } from "../../lib/reorder-confidence";
import type { SyncStatusName } from "../../lib/sync-job-policy";

/**
 * 全站唯一状态徽章（spec §8.6）。用 Polaris `s-badge` 承载：色调由 lib/status 统一
 * 决定，文案永远同时出现，绝不只靠颜色表达状态。页面禁止再自建 tone-map 或裸文本状态。
 */
export function StatusBadge({ state }: { state: BusinessState }) {
  const view = statusView(state);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/** Action Board 六态徽章：与 Tab 标签、CSV、审计文案共用同一套词汇。 */
export function ActionStateBadge({ state }: { state: ActionBoardState }) {
  const view = actionStateView(state);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/** Data Health 检查项徽章（ok / warn / critical）。 */
export function HealthBadge({ tone }: { tone: HealthTone }) {
  const view = healthView(tone);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/** 建议置信度徽章（spec §10：Confidence 必须有统一的定义与展示方式）。 */
export function ConfidenceBadge({ level }: { level: ReorderConfidenceLevel }) {
  const view = confidenceView(level);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/** 同步状态徽章（P0-2 的四档口径）。 */
export function SyncStatusBadge({ current }: { current: SyncStatusName }) {
  const view = syncStatusView(current);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/**
 * 库存健康度徽章：文案仍来自 lib/inventory-calculations（与 CSV 同一份），
 * 徽章只负责把同一句话在同一 tone 体系里渲染出来。
 */
export function InventoryStatusBadge({
  status,
}: {
  status: InventoryHealthStatus;
}) {
  const view = inventoryStatusView(status);
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

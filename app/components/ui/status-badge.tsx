import {
  statusView,
  healthView,
  actionStateView,
  confidenceView,
  syncStatusView,
  inventoryStatusView,
  dataHealthStateView,
  readinessView,
  supplierActivityView,
  planStatusView,
  POLARIS_BADGE_TONE,
  type StatusView,
  type BusinessState,
  type HealthTone,
  type SettingReadiness,
  type SupplierActivity,
} from "../../lib/status";
import type { ActionBoardState } from "../../lib/reorder-action-board";
import type { DataHealthState } from "../../lib/data-health";
import type { InventoryHealthStatus } from "../../lib/inventory-calculations";
import type { ReorderConfidenceLevel } from "../../lib/reorder-confidence";
import type { SyncStatusName } from "../../lib/sync-job-policy";

/**
 * 徽章的唯一渲染出口：tone 与文案都来自 lib/status 的 view，页面不得自己拼。
 * 文案永远同时出现，绝不只靠颜色表达状态（spec §8.6 / §11 可访问性）。
 */
function ViewBadge({ view }: { view: StatusView }) {
  return <s-badge tone={POLARIS_BADGE_TONE[view.tone]}>{view.label}</s-badge>;
}

/** 全站唯一状态徽章：补货建议 / 审计台账 / 计划共用的 BusinessState。 */
export function StatusBadge({ state }: { state: BusinessState }) {
  return <ViewBadge view={statusView(state)} />;
}

/** Action Board 六态徽章：与 Tab 标签、CSV、审计文案共用同一套词汇。 */
export function ActionStateBadge({ state }: { state: ActionBoardState }) {
  return <ViewBadge view={actionStateView(state)} />;
}

/** Data Health 检查项徽章（ok / warn / critical）。 */
export function HealthBadge({ tone }: { tone: HealthTone }) {
  return <ViewBadge view={healthView(tone)} />;
}

/** 建议置信度徽章（spec §10：Confidence 必须有统一的定义与展示方式）。 */
export function ConfidenceBadge({ level }: { level: ReorderConfidenceLevel }) {
  return <ViewBadge view={confidenceView(level)} />;
}

/** 同步状态徽章（P0-2 的四档口径）。 */
export function SyncStatusBadge({ current }: { current: SyncStatusName }) {
  return <ViewBadge view={syncStatusView(current)} />;
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
  return <ViewBadge view={inventoryStatusView(status)} />;
}

/**
 * 看板整体健康度徽章（首页与数据健康页的标题级状态）。
 * 与 HealthBadge 的区别：那个说单个检查项，这个说整块数据能不能安全下单。
 */
export function DataHealthStateBadge({ state }: { state: DataHealthState }) {
  return <ViewBadge view={dataHealthStateView(state)} />;
}

/** 功能区就绪度徽章：Settings 分段状态与首页未启用模块共用同一词汇与 tone。 */
export function ReadinessBadge({ kind }: { kind: SettingReadiness }) {
  return <ViewBadge view={readinessView(kind)} />;
}

/**
 * 供应商启停徽章。paused 走中性色而不是橙色：停用是商家的正常选择，
 * 不是「数据有问题所以决策被暂停」那种需要报警的语义。
 */
export function SupplierActivityBadge({ kind }: { kind: SupplierActivity }) {
  return <ViewBadge view={supplierActivityView(kind)} />;
}

/**
 * 采购计划态徽章。数据库原值进来：认得的状态走统一 tone，认不出的历史值
 * 原样显示（徽章不该把看不懂的记录吞成空白）。
 */
export function PlanStatusBadge({ status }: { status: string }) {
  return <ViewBadge view={planStatusView(status)} />;
}

/**
 * 业务状态语义的唯一来源（UI 重构 spec §8.6）。
 * 同一个状态在所有页面必须得到同一 tone 与同一文案；页面不得自建 tone-map。
 * 纯数据模块：可被 node --test 直接加载（.ts 扩展名互导约定）。
 */
import type { DataHealthTone } from "./data-health.ts";

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
  pending: "Pending",
  accepted: "Accepted",
  edited: "Edited",
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

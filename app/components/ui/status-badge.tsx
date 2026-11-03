import { statusView, healthView, type BusinessState, type HealthTone } from "../../lib/status";

/**
 * 全站唯一状态徽章（spec §8.6）。文案 + 色调双通道，绝不只靠颜色表达状态。
 * 页面禁止再自建 pill tone-map 或裸文本状态。
 */
export function StatusBadge({ state }: { state: BusinessState }) {
  const view = statusView(state);
  return (
    <span className={`dsPill ${view.className}`} role="status">
      {view.label}
    </span>
  );
}

/** Data Health 检查项徽章（ok / warn / critical）。 */
export function HealthBadge({ tone }: { tone: HealthTone }) {
  const view = healthView(tone);
  return (
    <span className={`dsPill ${view.className}`} role="status">
      {view.label}
    </span>
  );
}

import { automationsService } from "./automations.server";
import { activityService } from "./activity.server";
import { triggerSummary } from "./lib/automation-wizard";
import { DEFAULT_METRIC_WINDOW_MS } from "./lib/health-automation";
import {
  buildDashboardMetrics,
  windowStart,
  type DashboardMetrics,
} from "./lib/dashboard-metrics";

/**
 * Dashboard 指标编排：一次并发取真实计数，交给纯装配核。
 * 一切按 shopId 收口（P4-03 硬边界），页面不拼 SQL、不做算术。
 * 时间窗口固定 24h（P4-17 同源），成功率口径与 /health 探针一致。
 */
export async function getDashboardMetrics(shopId: string): Promise<DashboardMetrics> {
  const now = new Date();
  const since = windowStart(now, DEFAULT_METRIC_WINDOW_MS);

  const [automations, recentPage, totalExecutions, statusCounts24h] =
    await Promise.all([
      automationsService.list(shopId),
      activityService.list(shopId, { limit: 100 }),
      activityService.count(shopId),
      activityService.countsByStatus(shopId, since),
    ]);

  const automationNameById = new Map(
    automations.map((a) => [a.id, a.name]),
  );

  return buildDashboardMetrics({
    automations,
    recentExecutions: recentPage.items,
    totalExecutions,
    statusCounts24h,
    triggerLabel: (t) => (t ? triggerSummary(t) : "—"),
    automationNameById,
    now,
  });
}

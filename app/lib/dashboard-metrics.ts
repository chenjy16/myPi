// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// V2.0 Dashboard 指标装配核（UI Alignment R1-B3）。纯函数、零运行时依赖、时钟注入。
// PRD §9 关键要求：所有 KPI 都从 ExecutionLog/Automation 的真实计数换算，
// 无样本时诚实回 null（Success Rate 不谎报 100%），SKIPPED / 在途不计入分母
// ——口径与 P4-17 buildAutomationHealth 完全一致，页面与 /health 探针说的
// 是同一套数据话术。任何"演示数字"、"看起来更完整的空态"都是本模块的禁区。
import type { AutomationListItem } from "./automations-core.ts";
import type { ExecutionStatusCounts, SuccessRate } from "./health-automation.ts";
import { computeSuccessRate } from "./health-automation.ts";
import type { ExecutionSummary } from "./activity.ts";

/** 首屏最多展示的 Active 自动化条数（PRD §5.5）。 */
export const MAX_ACTIVE_ROWS = 5;
/** Recent Activity 展示条数（PRD §5.6：5–10 条）。 */
export const MAX_RECENT_ROWS = 10;

export type DashboardKpis = {
  activeAutomations: number;
  totalExecutions: number;
  /** 24h 成功率明细；无终态样本时 rate 为 null，不谎报。 */
  successRate: SuccessRate;
  /** 24h 窗口内 FAILED 计数（KPI Card 4）。 */
  failedExecutions24h: number;
};

export type DashboardActiveRow = {
  id: string;
  name: string;
  trigger: string;
  status: string;
  /** 该规则的历史执行数（从注入的 recent 页聚合而来；超过 100 条时是"最近 100 条中"的次数）。 */
  executions: number;
  /** 该规则近 100 条执行的成功率；无终态样本时 null。 */
  successRate: number | null;
  lastRun: { status: string; at: Date } | null;
};

export type DashboardRecentRow = {
  executionId: string;
  automationId: string;
  automationName: string;
  status: string;
  trigger: string;
  when: Date;
  /** 商家语言摘要（无 PII，来自 buildHumanSummary）。 */
  summary: string;
};

export type DashboardMetrics = {
  hasAutomations: boolean;
  kpis: DashboardKpis;
  activeAutomations: DashboardActiveRow[];
  recentActivity: DashboardRecentRow[];
};

export type BuildInput = {
  /** automationsService.list 的输出（不含 deleted）。 */
  automations: AutomationListItem[];
  /** activityService.list 的近 N 条执行（用于本页聚合，不代表全库计数）。 */
  recentExecutions: ExecutionSummary[];
  /** ExecutionLog 累计计数（真实 DB count，不受 recentExecutions 分页影响）。 */
  totalExecutions: number;
  /** 24h 窗口按状态分组计数（ExecutionLog.groupBy 结果）。 */
  statusCounts24h: ExecutionStatusCounts;
  /** 触发器类型→商家可读名（由 server 注入 triggerSummary，本模块不 import registry）。 */
  triggerLabel: (triggerType: string | null | undefined) => string;
  /** 每条执行对应自动化名的映射（server 端从 automations 派生传入）。 */
  automationNameById: ReadonlyMap<string, string>;
  /** 注入时钟（当前未直接参与运算，但保留契约便于后续时间相关指标做纯测）。 */
  now: Date;
};

/** 每自动化"最近 100 条中"的状态计数与最近一次运行时刻。 */
type PerAutomationRollup = {
  total: number;
  /** 本地累加用宽松 map；传给 computeSuccessRate 时再折成 ExecutionStatusCounts。 */
  counts: Record<string, number>;
  lastRun: ExecutionSummary | null;
};

function rollupRecent(
  rows: readonly ExecutionSummary[],
): Map<string, PerAutomationRollup> {
  const acc = new Map<string, PerAutomationRollup>();
  // rows 已按 createdAt desc 排序（lib/activity.listExecutions 保证），首见即最新。
  for (const r of rows) {
    const bucket = acc.get(r.automationId) ?? {
      total: 0,
      counts: {},
      lastRun: null,
    };
    bucket.total += 1;
    bucket.counts[r.status] = (bucket.counts[r.status] ?? 0) + 1;
    if (!bucket.lastRun) bucket.lastRun = r;
    acc.set(r.automationId, bucket);
  }
  return acc;
}

/**
 * 装配 Dashboard：4 KPI + Active Automations 首屏 + Recent Activity。
 * 输入进去全部为纯数据；任何外部性（DB、时钟）都由调用方（dashboard-metrics.server.ts）注入。
 */
export function buildDashboardMetrics(input: BuildInput): DashboardMetrics {
  const activeAutomations = input.automations.filter((a) => a.status === "active");
  const statusCounts = input.statusCounts24h;
  const rate = computeSuccessRate(statusCounts);
  const rollup = rollupRecent(input.recentExecutions);

  const activeRows: DashboardActiveRow[] = activeAutomations
    .map((a) => {
      const b = rollup.get(a.id);
      const successRate = b
        ? computeSuccessRate(b.counts as ExecutionStatusCounts).rate
        : null;
      return {
        id: a.id,
        name: a.name,
        trigger: input.triggerLabel(a.triggerType),
        status: a.status,
        executions: b?.total ?? 0,
        successRate,
        lastRun: b?.lastRun
          ? { status: b.lastRun.status, at: b.lastRun.createdAt }
          : null,
      };
    })
    // 首屏优先展示"最近有跑过"的规则；未跑过的按 updatedAt 兜底排在末尾。
    .sort((left, right) => {
      const l = left.lastRun?.at.getTime() ?? 0;
      const r = right.lastRun?.at.getTime() ?? 0;
      return r - l;
    })
    .slice(0, MAX_ACTIVE_ROWS);

  const recentActivity: DashboardRecentRow[] = input.recentExecutions
    .slice(0, MAX_RECENT_ROWS)
    .map((e) => ({
      executionId: e.id,
      automationId: e.automationId,
      automationName:
        input.automationNameById.get(e.automationId) ?? "Removed automation",
      status: e.status,
      trigger: input.triggerLabel(e.triggerType),
      when: e.createdAt,
      summary: "", // 由 server 端注入 buildHumanSummary 产物（避免本模块 import 步骤读）
    }));

  return {
    hasAutomations: input.automations.length > 0,
    kpis: {
      activeAutomations: activeAutomations.length,
      totalExecutions: input.totalExecutions,
      successRate: rate,
      failedExecutions24h: statusCounts.FAILED ?? 0,
    },
    activeAutomations: activeRows,
    recentActivity,
  };
}

/** 时间窗口起点（24h 前），供 server 传 since 参数；单独导出便于测试断言。 */
export function windowStart(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

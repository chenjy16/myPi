// /health 自动化态势的绑库编排面（P4-17）。查询注入 client 便于脱库测试；
// 每条查询都带超时护栏，任一失败只把对应字段降级为 null（探针里呈现 unknown），
// 绝不抛穿到路由——只有数据库整体不可用时 /health 才 503（该判定在 app/routes/health.tsx）。
import type { PrismaClient } from "@prisma/client";
import { EXECUTION_JOB_TYPE } from "./lib/execution-job-policy.ts";
import { createLogger } from "./lib/logger.ts";
import {
  buildAutomationHealth,
  parseAutomationQueryTimeoutMs,
  parseHeartbeatStaleMs,
  parseMetricWindowMs,
  type AutomationHealth,
  type ExecutionStatusCounts,
} from "./lib/health-automation.ts";

const logger = createLogger({ component: "health.automation" });

export type AutomationHealthClient = Pick<
  PrismaClient,
  "dataSyncJob" | "executionLog" | "executionStep" | "scheduledJob"
>;

/** 单查询超时护栏：超时或抛错都回退 fallback，并把原因写日志（不含堆栈透传）。 */
async function guarded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch (error) {
    logger.error("automation health query failed; degrading to unknown", { error });
    return fallback;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export type CollectAutomationHealthOptions = {
  now?: Date;
  windowMs?: number;
  heartbeatStaleMs?: number;
  queryTimeoutMs?: number;
};

/** 聚合队列积压、近窗成功率、待确认堆积、worker 心跳——全部降级安全。 */
export async function collectAutomationHealth(
  client: AutomationHealthClient,
  options: CollectAutomationHealthOptions = {},
): Promise<AutomationHealth> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? parseMetricWindowMs();
  const heartbeatStaleMs = options.heartbeatStaleMs ?? parseHeartbeatStaleMs();
  const queryTimeoutMs = options.queryTimeoutMs ?? parseAutomationQueryTimeoutMs();
  const since = new Date(now.getTime() - windowMs);

  const [queueDepth, grouped, awaiting, heartbeat] = await Promise.all([
    guarded(
      client.dataSyncJob.count({
        where: { jobType: EXECUTION_JOB_TYPE, status: "queued" },
      }),
      queryTimeoutMs,
      null,
    ),
    guarded(
      client.executionLog.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      queryTimeoutMs,
      null,
    ),
    guarded(
      client.executionStep.count({ where: { status: "AWAITING_CONFIRMATION" } }),
      queryTimeoutMs,
      null,
    ),
    // worker 心跳：各店 ScheduledJob 最近一次实际执行时间（lastRunAt 只由 worker 写入）。
    guarded(
      client.scheduledJob.aggregate({ _max: { lastRunAt: true } }),
      queryTimeoutMs,
      null,
    ),
  ]);

  const statusCounts: ExecutionStatusCounts | null = grouped
    ? Object.fromEntries(
        (grouped as { status: string; _count: { _all: number } }[]).map((row) => [
          row.status,
          row._count._all,
        ]),
      )
    : null;

  const lastHeartbeatAt = heartbeat?._max?.lastRunAt ?? null;

  return buildAutomationHealth({
    windowMs,
    heartbeatStaleMs,
    now,
    queueDepth,
    statusCounts,
    awaitingConfirmation: awaiting,
    lastHeartbeatAt,
  });
}

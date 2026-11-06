// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：/health 的自动化子系统态势聚合（P4-17）。不碰 DB、不自取时钟——
// 原始计数、时间戳与查询降级结果都由调用方（app/health-automation.server.ts）算好传入，
// 本模块只做「成功率 / 心跳时效 / 堆积」的确定性换算，保证探针契约稳定：
// 任何自动化维度异常只降级为字段值（null / "unknown"），绝不把 /health 拖成 503
// （只有数据库整体不可用才 503 摘流量，见 app/routes/health.tsx）。

/** 指标统计窗（近 24h）。 */
export const DEFAULT_METRIC_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 心跳判 stale 的水位：worker automation cron 每 2 分钟一轮，>15 分钟无心跳视为异常。 */
export const DEFAULT_HEARTBEAT_STALE_MS = 15 * 60 * 1000;
/** 单条自动化态势查询的等待上限；超时即降级为 unknown，不拖垮探针窗口。 */
export const DEFAULT_AUTOMATION_QUERY_TIMEOUT_MS = 2000;

/** ExecutionLog 按状态分组的原始计数（缺项视为 0）。 */
export type ExecutionStatusCounts = {
  SUCCESS?: number;
  FAILED?: number;
  PARTIAL_SUCCESS?: number;
  SKIPPED?: number;
  RETRYING?: number;
  RUNNING?: number;
};

/**
 * 近窗执行成功率。口径（诚实且可解释）：
 * 分母只数「跑到终态且有实际动作」的执行 = SUCCESS + FAILED + PARTIAL_SUCCESS；
 * SKIPPED（条件未命中 / loop-blocked）与在途态 RUNNING / RETRYING 不计入，
 * 避免把「本就不该执行」稀释成成功率，也不虚报未完成的执行。
 * 无终态样本时 rate 为 null（unknown），不谎报 100%。
 */
export type SuccessRate = {
  rate: number | null;
  succeeded: number;
  failed: number;
  partial: number;
  terminalTotal: number;
};

export function computeSuccessRate(counts: ExecutionStatusCounts): SuccessRate {
  const succeeded = counts.SUCCESS ?? 0;
  const failed = counts.FAILED ?? 0;
  const partial = counts.PARTIAL_SUCCESS ?? 0;
  const terminalTotal = succeeded + failed + partial;
  const rate = terminalTotal === 0 ? null : succeeded / terminalTotal;
  return { rate, succeeded, failed, partial, terminalTotal };
}

export type HeartbeatStatus = "fresh" | "stale" | "unknown";

/** 心跳时效（毫秒）：无心跳时间戳返回 null；时钟回拨（负值）钳到 0。 */
export function heartbeatAgeMs(
  now: Date,
  lastHeartbeatAt: Date | null | undefined,
): number | null {
  if (!lastHeartbeatAt) return null;
  const delta = now.getTime() - lastHeartbeatAt.getTime();
  return delta < 0 ? 0 : delta;
}

export function interpretHeartbeat(
  ageMs: number | null,
  staleMs = DEFAULT_HEARTBEAT_STALE_MS,
): HeartbeatStatus {
  if (ageMs === null) return "unknown";
  return ageMs <= staleMs ? "fresh" : "stale";
}

export type AutomationHealthInput = {
  windowMs: number;
  heartbeatStaleMs: number;
  now: Date;
  /** null 表示对应查询失败 / 无数据 → 降级为探针里的 unknown 字段值。 */
  queueDepth: number | null;
  statusCounts: ExecutionStatusCounts | null;
  awaitingConfirmation: number | null;
  lastHeartbeatAt: Date | null;
};

export type AutomationHealth = {
  windowSeconds: number;
  /** 待执行队列积压（automation-execute 且 status=queued）；null=未知。 */
  queueDepth: number | null;
  /** 近窗执行成功率明细；null=查询降级。 */
  executionSuccess: SuccessRate | null;
  /** AWAITING_CONFIRMATION 步骤堆积数；null=未知。 */
  awaitingConfirmation: number | null;
  heartbeat: {
    lastRunAt: string | null;
    ageMs: number | null;
    status: HeartbeatStatus;
  };
};

/** 把原始计数/时间戳折成探针可序列化的 automation 维度快照（纯、可回放）。 */
export function buildAutomationHealth(
  input: AutomationHealthInput,
): AutomationHealth {
  const ageMs = heartbeatAgeMs(input.now, input.lastHeartbeatAt);
  return {
    windowSeconds: Math.round(input.windowMs / 1000),
    queueDepth: input.queueDepth,
    executionSuccess: input.statusCounts
      ? computeSuccessRate(input.statusCounts)
      : null,
    awaitingConfirmation: input.awaitingConfirmation,
    heartbeat: {
      lastRunAt: input.lastHeartbeatAt
        ? input.lastHeartbeatAt.toISOString()
        : null,
      ageMs,
      status: interpretHeartbeat(ageMs, input.heartbeatStaleMs),
    },
  };
}

function positiveIntEnv(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 指标窗（毫秒），默认 24h，上限 7 天。 */
export function parseMetricWindowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntEnv(env.HEALTH_AUTOMATION_WINDOW_MS, DEFAULT_METRIC_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
}

/** 心跳 stale 水位（毫秒），默认 15 分钟，上限 1 小时。 */
export function parseHeartbeatStaleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntEnv(env.HEALTH_WORKER_HEARTBEAT_STALE_MS, DEFAULT_HEARTBEAT_STALE_MS, 3_600_000);
}

/** 单查询超时（毫秒），默认 2s，上限 8s（须小于 HEALTH_CHECK_TIMEOUT_MS 预算）。 */
export function parseAutomationQueryTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveIntEnv(env.HEALTH_AUTOMATION_QUERY_TIMEOUT_MS, DEFAULT_AUTOMATION_QUERY_TIMEOUT_MS, 8_000);
}

// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与 sync-job-policy.ts 同一约定）。
// 纯逻辑：自动化执行队列的策略层（jobType 登记 / 认领键 / 租约算术），零 db 依赖。
// 承载方式沿用 docs/V2-PHASE1-TASKS.md P1-09 决策：复用 DataSyncJob 表 + activeKey 锁范式，
// 以 jobType="automation-execute" 前缀隔离命名空间，避免与 V1 cron 同步任务抢锁。
import type { StandardEvent } from "./event-normalizer.ts";

/** 队列任务类型；与 sync-job-policy 的 SyncJobType 刻意不同池，防抢 activeKey。 */
export const EXECUTION_JOB_TYPE = "automation-execute";

/** queued/running/succeeded/failed 之外不引入新状态，语义与 DataSyncJob 台账一致。 */
export type ExecutionJobStatus = "queued" | "running" | "succeeded" | "failed";

/**
 * 事件指纹：优先用 WebhookDelivery 的 webhookId（Shopify 官方唯一投递 id），
 * 定时触发等无 deliveryId 场景退化为 shop:topic:entityId:occurredAt 组合键。
 */
export function executionEventKey(event: StandardEvent, deliveryId?: string): string {
  if (deliveryId) return `d:${deliveryId}`;
  return `e:${event.shopDomain}:${event.topic}:${event.entityId ?? "-"}:${event.occurredAt.toISOString()}`;
}

/** 认领键：同一事件全集群只允许一行占用（activeKey @unique 即去重锁）。 */
export function executionClaimKey(eventKey: string): string {
  return `${EXECUTION_JOB_TYPE}:${eventKey}`;
}

/** 执行任务租约（分钟）：running 超此龄视为进程崩溃残留，可回收。 */
export function executionLeaseMinutes(): number {
  const configured = Number(process.env.EXECUTION_LEASE_MINUTES ?? 10);
  if (!Number.isFinite(configured) || configured <= 0) return 10;
  return Math.min(configured, 60);
}

export function executionLeaseCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - executionLeaseMinutes() * 60_000);
}

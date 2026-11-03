import db from "./db.server";
import * as ledger from "./lib/sync-job-ledger";
import type { SyncJobType } from "./lib/sync-job-policy";

// 策略层原样转出：调用方继续从本模块拿类型与错误，不必知道它拆在 lib/ 下。
export {
  SyncAlreadyRunningError,
  deriveSyncStatus,
  jobLeaseMinutes,
  leaseCutoff,
  syncJobClaimKey,
  type SyncJobRow,
  type SyncJobType,
  type SyncStatus,
  type SyncTrigger,
} from "./lib/sync-job-policy";

/**
 * 台账编排的数据库绑定层：真正的抢锁 / running→succeeded/failed / 租约回收逻辑
 * 在可注入的 lib/sync-job-ledger 里（便于单测与 CI 集成测试复用同一份逻辑），
 * 这里只把全应用共享的 Prisma 单例绑进去，保持对外签名不变。
 */
export function reapStaleRunningJobs(
  shop?: string,
  now: Date = new Date(),
): Promise<number> {
  return ledger.reapStaleRunningJobs(db, shop, now);
}

export function hasRunningJob(
  shop: string,
  jobType: SyncJobType,
  now: Date = new Date(),
): Promise<boolean> {
  return ledger.hasRunningJob(db, shop, jobType, now);
}

export function lastSucceededAt(
  shop: string,
  jobType: SyncJobType,
): Promise<Date | null> {
  return ledger.lastSucceededAt(db, shop, jobType);
}

export function consecutiveFailures(
  shop: string,
  jobType: SyncJobType,
): Promise<number> {
  return ledger.consecutiveFailures(db, shop, jobType);
}

export function recentJobs(shop: string, take = 20) {
  return ledger.recentJobs(db, shop, take);
}

export function syncStatusSnapshot(
  shop: string,
  jobType: SyncJobType = "inventory-snapshot",
  now: Date = new Date(),
) {
  return ledger.syncStatusSnapshot(db, shop, jobType, now);
}

export function withSyncJob<T>(
  input: ledger.SyncJobInput,
  task: () => Promise<ledger.JobOutcome<T>>,
): Promise<T> {
  return ledger.withSyncJob(db, input, task);
}

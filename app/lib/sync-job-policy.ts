// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（运行时值导入，类型会被擦除的那种不行），
// 而仓库其余内部导入走打包器解析，省略扩展名也没问题。
import { AppError } from "./app-error.ts";

/**
 * 同步任务的「策略层」：类型、锁键、租约算术、撞锁错误。
 * 单独成文件是因为它必须能在不连数据库的情况下被测试 —— 台账读写留在 sync-jobs.server.ts。
 */

/** 同步任务的触发来源。 */
export type SyncTrigger = "manual" | "cron" | "webhook";

/** 同步任务类型；新增任务时在此登记，避免自由字符串扩散。 */
export type SyncJobType =
  "inventory-snapshot" | "locations" | "sales-daily" | "webhook-incremental";

/** 面向商家的任务名，撞锁文案要说清是哪一个任务在跑。 */
const SYNC_JOB_LABELS: Record<SyncJobType, string> = {
  "inventory-snapshot": "inventory sync",
  locations: "location sync",
  "sales-daily": "sales sync",
  "webhook-incremental": "incremental sync",
};

/** 锁键：一店一类型只允许一个 running 行占用。 */
export function syncJobClaimKey(shop: string, jobType: SyncJobType): string {
  return `${shop}:${jobType}`;
}

/**
 * 同一店铺同类任务已在运行。这是并发保护，不是故障：商家该等，而不是再点一次。
 * kind 用 validation，因为它对商家可行动（等待即可），不属于系统不可用。
 */
export class SyncAlreadyRunningError extends AppError {
  constructor(jobType: SyncJobType) {
    super(
      "validation",
      `Another ${SYNC_JOB_LABELS[jobType]} is already running for this store. Please wait for it to finish before starting another one.`,
    );
    this.name = "SyncAlreadyRunningError";
  }
}

/** Prisma 唯一约束冲突（P2002）＝ 锁已被别的进程占走。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * running 行的租约时长（分钟）。
 *
 * 没有租约会出大事：进程被 OOM 或部署打断时，台账会永远停在 running，
 * 于是 hasRunningJob 之后永久返回 true，这个店的 cron / webhook / 手动同步全部静默不再执行。
 * 超过租约就回收为 failed，商家和 worker 都还能继续推进。
 */
export function jobLeaseMinutes(): number {
  const configured = Number(process.env.WORKER_JOB_LEASE_MINUTES ?? 30);
  if (!Number.isFinite(configured) || configured <= 0) return 30;
  return Math.min(configured, 24 * 60);
}

/** 租约截止时间：早于这个时刻开始的 running 行视为已死。 */
export function leaseCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - jobLeaseMinutes() * 60_000);
}

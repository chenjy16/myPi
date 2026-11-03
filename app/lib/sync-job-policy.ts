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

/* ---------------- 同步状态与数据新鲜度（P0-2） ---------------- */

/**
 * 当前同步任务对外呈现的状态。刻意不加 PARTIAL：
 * 现有同步在事务外抓取、任一 fetch 失败即整体抛错，不会写半份快照，
 * 所以「部分成功」在当前实现里等价于「失败且保留上次成功数据」，不新增状态去伪装没发生过的中间态。
 */
export type SyncStatusName = "never" | "running" | "succeeded" | "failed";

/** deriveSyncStatus 需要的最小行形状（从台账取，字段都可由 DataSyncJob 可靠提供）。 */
export type SyncJobRow = {
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type SyncStatus = {
  /** 最近一次任务给出的当前状态；running 只认租约内的行。 */
  current: SyncStatusName;
  /** 最后一次「尝试」同步的时间（无论成败），与「成功」严格分开。 */
  lastSyncAttemptAt: Date | null;
  /** 最后一次「成功」同步的时间；一次都没成功为 null。 */
  lastSuccessfulSyncAt: Date | null;
  /** 最近一次失败尝试的原因（安全一行文本）；最近一次成功则 null。 */
  lastSyncError: string | null;
  /** true 表示最新尝试已失败但仍留着更早的成功数据——UI 必须显式告知在看旧数据。 */
  staleWithFallback: boolean;
};

/**
 * 从一家店某类任务最近的台账行推导同步状态。纯函数、可测、不连库。
 * rows 必须按 createdAt 倒序（最新在前）。running 判定复用租约算术，避免崩溃残留的 running 行被当成在跑。
 */
export function deriveSyncStatus(
  rows: SyncJobRow[],
  now: Date = new Date(),
): SyncStatus {
  const cutoff = leaseCutoff(now);
  const withinLease = (row: SyncJobRow): boolean =>
    row.startedAt !== null && row.startedAt >= cutoff;

  const running = rows.find(
    (row) => row.status === "running" && withinLease(row),
  );
  const firstSucceeded = rows.find((row) => row.status === "succeeded");
  const lastSuccessfulSyncAt = firstSucceeded
    ? (firstSucceeded.finishedAt ?? firstSucceeded.createdAt)
    : null;

  // 租约外的 running＝进程崩溃遗留的死行（台账策略本就把它回收成 failed）。
  // 读取路径不写库，所以在纯函数里同样按「已失败」呈现，绝不伪装成「还在同步」。
  const latestRaw = rows[0] ?? null;
  const latest: SyncJobRow | null =
    latestRaw && latestRaw.status === "running" && !withinLease(latestRaw)
      ? { ...latestRaw, status: "failed" }
      : latestRaw;

  const latestFailed = latest?.status === "failed" ? latest : null;

  let current: SyncStatusName;
  if (running) current = "running";
  else if (!latest) current = "never";
  else if (latest.status === "failed") current = "failed";
  else if (latest.status === "succeeded") current = "succeeded";
  else current = "running"; // queued 视作进行中，商家只会等、不会看到「失败」

  return {
    current,
    lastSyncAttemptAt: latest ? latest.createdAt : null,
    lastSuccessfulSyncAt,
    // 只有最新一次尝试确实是失败时才回显原因；否则旧失败不应盖住当前的成功状态。
    lastSyncError: latestFailed?.error ?? null,
    staleWithFallback:
      current === "failed" && lastSuccessfulSyncAt !== null,
  };
}

// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-policy.ts 同一约定）。
// 台账编排（抢锁 / running→succeeded/failed / 租约回收）从 sync-jobs.server.ts 下沉到这里，
// 只依赖注入的 dataSyncJob 代理——所以同一份逻辑既能喂假客户端（本地门禁单测），
// 也能喂真实 Prisma（CI 一次性 Postgres 集成测试），无需连库即可被测试。
import type { PrismaClient } from "@prisma/client";
import { describeError } from "./app-error.ts";
import {
  SyncAlreadyRunningError,
  deriveSyncStatus,
  isUniqueViolation,
  jobLeaseMinutes,
  leaseCutoff,
  syncJobClaimKey,
  type SyncJobRow,
  type SyncJobType,
  type SyncStatus,
  type SyncTrigger,
} from "./sync-job-policy.ts";

/** 台账只用到 dataSyncJob 一个代理；注入它即可脱离具体数据库实现编排逻辑。 */
export type SyncJobClient = Pick<PrismaClient, "dataSyncJob">;

export type JobOutcome<T> = {
  result: T;
  recordsProcessed?: number;
};

export type SyncJobInput = {
  shop: string;
  jobType: SyncJobType;
  triggeredBy: SyncTrigger;
  cursor?: string | null;
};

/** 把超龄的 running 行回收成 failed，返回回收条数。可按店铺收窄。 */
export async function reapStaleRunningJobs(
  client: SyncJobClient,
  shop?: string,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await client.dataSyncJob.updateMany({
    where: {
      status: "running",
      startedAt: { lt: leaseCutoff(now) },
      ...(shop ? { shop } : {}),
    },
    data: {
      status: "failed",
      finishedAt: now,
      // 回收必须同时放锁，否则这一店的后续同步会永远撞在这个死行上。
      activeKey: null,
      error: `Job lease expired after ${jobLeaseMinutes()} minutes without completing; the process most likely stopped mid-run.`,
    },
  });
  return count;
}

/**
 * 插入 running 行并占用 activeKey。唯一约束冲突说明已有进程在跑同一任务，
 * 折成 SyncAlreadyRunningError 抛出，让「撞锁」与「同步失败」在台账与 UI 上是两类事。
 */
async function createSyncJob(client: SyncJobClient, input: SyncJobInput) {
  try {
    return await client.dataSyncJob.create({
      data: {
        shop: input.shop,
        jobType: input.jobType,
        triggeredBy: input.triggeredBy,
        cursor: input.cursor ?? null,
        status: "running",
        startedAt: new Date(),
        activeKey: syncJobClaimKey(input.shop, input.jobType),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SyncAlreadyRunningError(input.jobType);
    }
    throw error;
  }
}

/**
 * 把一次同步登记进 DataSyncJob 台账：running → succeeded / failed。
 * 建行即抢锁（activeKey 唯一约束），因此 web 进程与 worker 进程同时触发时只会跑一个，
 * 撞锁的一方抛 SyncAlreadyRunningError，由调用方按「已有任务在跑」呈现而不是按失败呈现。
 * 任务本体抛错会原样向上抛出，台账只负责记录失败原因。
 */
export async function withSyncJob<T>(
  client: SyncJobClient,
  input: SyncJobInput,
  task: () => Promise<JobOutcome<T>>,
): Promise<T> {
  // 先回收超龄行再抢锁：否则崩溃留下的 running 行会把这家店锁到租约之外还要久。
  await reapStaleRunningJobs(client, input.shop);

  const job = await createSyncJob(client, input);

  try {
    const { result, recordsProcessed } = await task();
    await client.dataSyncJob.update({
      where: { id: job.id },
      data: {
        status: "succeeded",
        finishedAt: new Date(),
        activeKey: null,
        recordsProcessed: recordsProcessed ?? 0,
      },
    });
    return result;
  } catch (error) {
    await client.dataSyncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        activeKey: null,
        // 台账里留可诊断的一行（含 Prisma 错误码），原始堆栈只进进程日志。
        error: describeError(error),
      },
    });
    throw error;
  }
}

/**
 * 该店铺是否已有同类任务在跑，供 cron 与 webhook 去重，避免并发重复同步。
 * 先看租约内的 running；顺手回收超龄行，所以一次崩溃不会把这个店的后续同步永久锁死。
 */
export async function hasRunningJob(
  client: SyncJobClient,
  shop: string,
  jobType: SyncJobType,
  now: Date = new Date(),
): Promise<boolean> {
  await reapStaleRunningJobs(client, shop, now);
  const running = await client.dataSyncJob.findFirst({
    where: {
      shop,
      jobType,
      status: "running",
      startedAt: { gte: leaseCutoff(now) },
    },
    select: { id: true },
  });
  return Boolean(running);
}

/** 取该店铺某类任务最后一次成功完成的时间，用于判断是否需要同步。 */
export async function lastSucceededAt(
  client: SyncJobClient,
  shop: string,
  jobType: SyncJobType,
): Promise<Date | null> {
  const job = await client.dataSyncJob.findFirst({
    where: { shop, jobType, status: "succeeded" },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  return job?.finishedAt ?? null;
}

/**
 * 从最新往回数同类任务的连续失败次数；遇到一次成功就停。
 * 数据健康用「连续」而不是「总量」计数，避免历史失败把健康店铺永久标脏。
 */
export async function consecutiveFailures(
  client: SyncJobClient,
  shop: string,
  jobType: SyncJobType,
): Promise<number> {
  const recent = await client.dataSyncJob.findMany({
    where: { shop, jobType },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { status: true },
  });
  let failures = 0;
  for (const job of recent) {
    if (job.status !== "failed") break;
    failures += 1;
  }
  return failures;
}

/** 最近的任务台账，供 Data Health 页面直接展示同步历史。 */
export async function recentJobs(client: SyncJobClient, shop: string, take = 20) {
  return client.dataSyncJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      jobType: true,
      status: true,
      triggeredBy: true,
      recordsProcessed: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
}

/**
 * 组装某类任务（默认库存快照）的对外同步状态：最近尝试时间 / 最近成功时间 / 当前状态 / 最近失败原因。
 * 全部由台账可靠计算得出，不新增冗余列（P0-2「不要重复存储可可靠计算的数据」）。
 * running 判定复用租约算术，所以一次崩溃不会把状态永远停在「运行中」。
 */
export async function syncStatusSnapshot(
  client: SyncJobClient,
  shop: string,
  jobType: SyncJobType = "inventory-snapshot",
  now: Date = new Date(),
): Promise<SyncStatus> {
  const rows = (await client.dataSyncJob.findMany({
    where: { shop, jobType },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      status: true,
      error: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  })) as unknown as SyncJobRow[];
  return deriveSyncStatus(rows, now);
}

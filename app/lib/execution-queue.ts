// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// DB 持久执行队列：入队（activeKey 即事件去重锁）/ 认领（queued→running）/ 收尾 / 租约回收。
// 只依赖注入的 dataSyncJob 代理——同一份逻辑可喂假客户端（单测）也可喂真实 Prisma（集成测）。
import type { PrismaClient } from "@prisma/client";
import type { StandardEvent } from "./event-normalizer.ts";
import { isUniqueViolation } from "./sync-job-policy.ts";
import {
  EXECUTION_JOB_TYPE,
  executionClaimKey,
  executionEventKey,
  executionLeaseCutoff,
} from "./execution-job-policy.ts";

/** 队列只用 dataSyncJob 一个代理（复用 V1 台账表，见 P1-09 承载决策）。 */
export type ExecutionQueueClient = Pick<PrismaClient, "dataSyncJob">;

export type EnqueueResult = {
  jobId: string | null;
  /** false=同一事件指纹已在队列/在跑，被 activeKey 唯一约束挡下。 */
  enqueued: boolean;
  duplicate: boolean;
};

/** 认领成功后的载荷：行 id + 反序列化出的标准化事件。 */
export type ClaimedEvent = {
  jobId: string;
  event: StandardEvent;
};

/**
 * 入队一条标准化事件。cursor 存事件 JSON（Phase 1 技术债：粒度不足时在 Phase 2 拆独立队列表，
 * 见 docs/V2-PHASE1-TASKS.md P1-09）。activeKey 从 queued 起就占用事件指纹，
 * 因此「入队去重」与「执行互斥」共用同一把锁，重复投递不可能两度入队。
 */
export async function enqueueStandardEvent(
  client: ExecutionQueueClient,
  event: StandardEvent,
  options: { deliveryId?: string; shopId?: string } = {},
): Promise<EnqueueResult> {
  const claimKey = executionClaimKey(executionEventKey(event, options.deliveryId));
  try {
    const job = await client.dataSyncJob.create({
      data: {
        shop: event.shopDomain,
        jobType: EXECUTION_JOB_TYPE,
        triggeredBy: "webhook",
        status: "queued",
        cursor: JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() }),
        activeKey: claimKey,
      },
      select: { id: true },
    });
    return { jobId: job.id, enqueued: true, duplicate: false };
  } catch (error) {
    if (isUniqueViolation(error)) return { jobId: null, enqueued: false, duplicate: true };
    throw error;
  }
}

/**
 * 回收超租约的残留行：running 崩了、或 queued 从未被认领（入队进程随后崩溃）。
 * 两类都折成 failed 并放锁，否则该事件指纹被永久占用、同 key 重投再也不能入队。
 */
export async function reapStaleExecutionJobs(
  client: ExecutionQueueClient,
  shop?: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = executionLeaseCutoff(now);
  const ageField = (status: string) =>
    status === "running" ? { startedAt: { lt: cutoff } } : { createdAt: { lt: cutoff } };
  let total = 0;
  for (const status of ["running", "queued"] as const) {
    const { count } = await client.dataSyncJob.updateMany({
      where: {
        jobType: EXECUTION_JOB_TYPE,
        status,
        ...ageField(status),
        ...(shop ? { shop } : {}),
      },
      data: {
        status: "failed",
        finishedAt: now,
        activeKey: null,
        error: `Execution job lease expired without completing; the worker most likely stopped mid-run.`,
      },
    });
    total += count;
  }
  return total;
}

/** 反序列化 cursor；坏行折成 failed 并放锁，返回 null 让认领方继续下一个。 */
async function materialize(
  client: ExecutionQueueClient,
  jobId: string,
  cursor: string | null,
  now: Date,
): Promise<ClaimedEvent | null> {
  if (!cursor) {
    await releaseAsFailed(client, jobId, now, "Execution job row carries no event payload.");
    return null;
  }
  try {
    const parsed = JSON.parse(cursor) as Omit<StandardEvent, "occurredAt"> & {
      occurredAt: string;
    };
    const event: StandardEvent = { ...parsed, occurredAt: new Date(parsed.occurredAt) };
    if (Number.isNaN(event.occurredAt.getTime()) || !event.shopDomain || !event.topic) {
      throw new Error("malformed");
    }
    return { jobId, event };
  } catch {
    await releaseAsFailed(client, jobId, now, "Execution job payload is not a valid StandardEvent.");
    return null;
  }
}

async function releaseAsFailed(
  client: ExecutionQueueClient,
  jobId: string,
  now: Date,
  reason: string,
): Promise<void> {
  await client.dataSyncJob.update({
    where: { id: jobId },
    data: { status: "failed", finishedAt: now, activeKey: null, error: reason },
  });
}

/**
 * 认领并执行下一件事：条件更新 queued→running（撞租约残留先回收），
 * updateMany 的 count 保证多 worker 并发下同一行只被一人认领。
 * 执行体抛错则折 failed 并把锁留给租约回收路径处理——绝不无声吞异常。
 */
export async function claimNextEvent(
  client: ExecutionQueueClient,
  shop: string,
  now: Date = new Date(),
): Promise<ClaimedEvent | null> {
  await reapStaleExecutionJobs(client, shop, now);
  for (;;) {
    const candidate = await client.dataSyncJob.findFirst({
      where: { shop, jobType: EXECUTION_JOB_TYPE, status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { id: true, cursor: true },
    });
    if (!candidate) return null;
    const { count } = await client.dataSyncJob.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", startedAt: now },
    });
    if (count !== 1) continue; // 被别的 worker 抢走，看下一行
    const claimed = await materialize(client, candidate.id, candidate.cursor, now);
    if (claimed) return claimed;
    // 坏行已被折成 failed 并放锁，继续尝试下一条，不把一次脏数据当成队列空转
  }
}

/** 执行收尾：成功 succeeded / 失败 failed，一律放锁。 */
export async function completeExecutionJob(
  client: ExecutionQueueClient,
  jobId: string,
  ok: boolean,
  errorText?: string,
  now: Date = new Date(),
): Promise<void> {
  await client.dataSyncJob.update({
    where: { id: jobId },
    data: {
      status: ok ? "succeeded" : "failed",
      finishedAt: now,
      activeKey: null,
      ...(ok ? {} : { error: errorText?.slice(0, 500) ?? "unknown failure" }),
    },
  });
}

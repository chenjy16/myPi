// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 execution-log.ts 同一约定）。
// 执行史保留清理核（P4-10）：窗口计算在 retention-policy，掩蔽在 customer-compliance，
// 本模块只负责编排「先掩蔽客户引用、再整行删除」两步，并把 client 留成注入面（可脱库单测）。
// 只碰 ExecutionLog/ExecutionStep —— WebhookDelivery 的 TTL 瘦身已有独立 prune（P1-11）。
import type { Prisma } from "@prisma/client";
import {
  extractCustomerIds,
  maskCustomerReferences,
  REDACTED,
} from "./customer-compliance.ts";
import {
  cutoffDate,
  DEFAULT_EXECUTION_RETENTION_DAYS,
  parseRetentionDays,
  selectPrunableExecutions,
} from "./retention-policy.ts";

type PruneClient = Pick<
  Prisma.TransactionClient,
  "executionLog" | "executionStep"
>;

export type PruneOldExecutionsDependencies = {
  /** 可注入时钟：单测确定化；默认取当前时间。 */
  now?: () => Date;
  /** 保留天数；缺省读 EXECUTION_RETENTION_DAYS，非法值回退 180。 */
  retentionDays?: number;
  /** 单轮上限：防首次上线时把积压旧行一次性删成慢事务；worker 下一轮继续。 */
  batch?: number;
};

export type PruneOldExecutionsResult = {
  retentionDays: number;
  /** 本轮窗口起点（审计用：早于它的行进入删除集合）。 */
  cutoff: Date;
  scanned: number;
  masked: number;
  deleted: number;
  /** true = 本轮删满了 batch，积压未清空，下一轮继续。 */
  hitBatchCap: boolean;
};

/**
 * 删除超出保留窗口的执行记录。固定「先掩蔽、后删除」的次序：中途失败时存活的行
 * 要么已掩蔽要么未被碰过，下一轮重跑幂等接续，不会留下新增的裸客户引用窗口。
 */
export async function pruneOldExecutions(
  client: PruneClient,
  deps: PruneOldExecutionsDependencies = {},
): Promise<PruneOldExecutionsResult> {
  const retentionDays =
    deps.retentionDays ??
    parseRetentionDays(process.env.EXECUTION_RETENTION_DAYS);
  const now = deps.now?.() ?? new Date();
  const cutoff = cutoffDate(now, retentionDays);
  const batch = deps.batch ?? 500;

  const rows = await client.executionLog.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, createdAt: true, entityRef: true, payload: true },
    orderBy: { createdAt: "asc" },
    take: batch,
  });
  const { toDelete } = selectPrunableExecutions(rows, cutoff);

  let masked = 0;
  for (const row of toDelete) {
    const customerIds = extractCustomerIds({
      entityRef: row.entityRef,
      payload: row.payload,
    });
    if (customerIds.length === 0) continue;

    let entityRef = row.entityRef;
    let payload: Prisma.JsonValue | null = row.payload as Prisma.JsonValue | null;
    for (const id of customerIds) {
      if (entityRef?.includes(`shopify/Customer/${id}`)) entityRef = REDACTED;
      if (payload != null) payload = maskCustomerReferences(payload, id) as Prisma.JsonValue;
    }
    await client.executionLog.update({
      where: { id: row.id },
      data: {
        entityRef,
        payload: payload as never,
      },
    });

    const steps = await client.executionStep.findMany({
      where: { executionId: row.id },
      select: { id: true, result: true },
    });
    for (const step of steps) {
      const stepIds = extractCustomerIds(step.result);
      if (stepIds.length === 0) continue;
      let result: Prisma.JsonValue | null = step.result as Prisma.JsonValue | null;
      for (const id of stepIds) result = maskCustomerReferences(result, id) as Prisma.JsonValue;
      await client.executionStep.update({
        where: { id: step.id },
        data: { result: result as never },
      });
    }
    masked += 1;
  }

  const { count } = await client.executionLog.deleteMany({
    where: { id: { in: toDelete.map((row) => row.id) } },
  });

  return {
    retentionDays,
    cutoff,
    scanned: rows.length,
    masked,
    deleted: count,
    hitBatchCap: rows.length >= batch,
  };
}

export { DEFAULT_EXECUTION_RETENTION_DAYS };

// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 automation-ingest.ts 同一约定）。
// 对账落库编排（P4-13）：把「Admin 拉回的实体变更」与「已登记投递 / 已落执行」比对，
// 只补真正漏掉的，并复用 ingest 同款去重原语（tryRecordDelivery + enqueueStandardEvent）。
// 判定逻辑在 reconcile-policy（纯），db 读写全走注入客户端：可喂假客户端单测，也可喂真 Prisma 集成。
import type { PrismaClient } from "@prisma/client";
import {
  isReconcileWebhookId,
  planRequeue,
  reconcileDedupeKey,
  type ReconcileDelta,
} from "./reconcile-policy.ts";
import { tryRecordDelivery } from "./webhook-delivery.ts";
import { enqueueStandardEvent } from "./execution-queue.ts";

export type ReconcileClient = Pick<
  PrismaClient,
  "webhookDelivery" | "executionLog" | "dataSyncJob"
>;

export type ReconcileShopInput = {
  shopDomain: string;
  shopId: string;
  /** 本轮时间窗：投递/执行覆盖都只在此窗内取证（窗外的旧执行不该挡住新变更）。 */
  since: Date;
  /** 待判定的实体变更（由绑定面从 Admin API 归一而来）。 */
  deltas: readonly ReconcileDelta[];
};

export type ReconcileShopResult = {
  scanned: number;
  requeued: number;
  skipped: number;
  /** 补投出去的合成投递键，便于日志与「不重复执行」的集成断言取证。 */
  requeuedKeys: string[];
};

/**
 * 对账单店：先收「往轮已补的合成键」与「窗内已落执行的实体」，planRequeue 挑出漏网，
 * 再逐个登记合成投递 + 入队。登记撞唯一约束（并发/重跑）即视为已补、跳过——三层幂等的第二层兜底。
 */
export async function reconcileShopEntities(
  client: ReconcileClient,
  input: ReconcileShopInput,
): Promise<ReconcileShopResult> {
  const deliveries = await client.webhookDelivery.findMany({
    where: { shop: input.shopDomain, receivedAt: { gte: input.since } },
    select: { webhookId: true },
  });
  const priorReconcileKeys = new Set(
    deliveries.map((d) => d.webhookId).filter(isReconcileWebhookId),
  );

  const logs = await client.executionLog.findMany({
    where: { shopId: input.shopId, createdAt: { gte: input.since } },
    select: { entityRef: true, createdAt: true },
  });
  const handledByEntity = new Map<string, Date>();
  for (const log of logs) {
    if (!log.entityRef) continue;
    const seen = handledByEntity.get(log.entityRef);
    if (!seen || log.createdAt > seen) handledByEntity.set(log.entityRef, log.createdAt);
  }

  const missing = planRequeue({
    deltas: input.deltas,
    priorReconcileKeys,
    handledByEntity,
  });

  const requeuedKeys: string[] = [];
  for (const delta of missing) {
    const key = reconcileDedupeKey(delta);
    if (!key) continue;
    const { accepted } = await tryRecordDelivery(client, {
      shop: input.shopDomain,
      shopId: input.shopId,
      webhookId: key,
      topic: delta.event.topic,
    });
    if (!accepted) continue; // 并发/重跑：这一变更已被登记，跳过
    await enqueueStandardEvent(client, delta.event, {
      deliveryId: key,
      shopId: input.shopId,
    });
    requeuedKeys.push(key);
  }

  return {
    scanned: input.deltas.length,
    requeued: requeuedKeys.length,
    skipped: input.deltas.length - requeuedKeys.length,
    requeuedKeys,
  };
}

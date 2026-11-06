// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// 统一 webhook 接收前置流程（PRD §23.1）：头校验 → 租户落账 → 投递去重 → 归一 → 入队。
// HMAC 验签由 authenticate.webhook 在库层完成（原始 body，不重算），这里只做其后的编排；
// 所有依赖经注入客户端进入，脱库可测。路由侧保持「快速 200」，重活留给 worker。
import type { PrismaClient } from "@prisma/client";
import { normalizeEvent, type StandardEvent } from "./event-normalizer.ts";
import { tryRecordDelivery } from "./webhook-delivery.ts";
import { enqueueStandardEvent } from "./execution-queue.ts";
import { ensureShop } from "./shop-directory.ts";

/** 编排用到的模型并集；真实侧传 PrismaClient，测试侧传结构相同的假客户端。 */
export type IngestClient = Pick<
  PrismaClient,
  "shop" | "session" | "inventorySettings" | "webhookDelivery" | "dataSyncJob"
>;

export type IngestInput = {
  /** authenticate.webhook 解出的已鉴权店铺域名。 */
  shopDomain: string;
  topic: string;
  /** X-Shopify-Webhook-Id；缺失即拒——没有幂等键的投递不可信也不可去重。 */
  webhookId?: string | null;
  payload: unknown;
  occurredAt?: Date;
};

export type IngestOutcome =
  | { status: "accepted"; event: StandardEvent; jobId: string }
  | { status: "duplicate" }
  | { status: "rejected"; reason: "missing_webhook_id" | "unparsable_payload" };

/**
 * 接收一次 webhook 投递。返回 rejected 时上层只记日志、照样 200——
 * Shopify 对非 200 会无限重试同一份坏 payload，拒收处理完的投递比放行更糟。
 */
export async function ingestWebhook(
  client: IngestClient,
  input: IngestInput,
): Promise<IngestOutcome> {
  if (!input.webhookId) return { status: "rejected", reason: "missing_webhook_id" };

  const shop = await ensureShop(client, input.shopDomain);
  const delivery = await tryRecordDelivery(client, {
    shop: input.shopDomain,
    shopId: shop.id,
    webhookId: input.webhookId,
    topic: input.topic,
  });
  if (!delivery.accepted) return { status: "duplicate" };

  const event = normalizeEvent({
    shopDomain: input.shopDomain,
    topic: input.topic,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
  if (!event) return { status: "rejected", reason: "unparsable_payload" };

  const queued = await enqueueStandardEvent(client, event, {
    deliveryId: input.webhookId,
    shopId: shop.id,
  });
  // 能走到这里说明 deliveryId 是全新的；理论上不该 duplicate，撞上即数据异常，照实上抛。
  if (!queued.enqueued || !queued.jobId) {
    throw new Error(`Execution enqueue lost the race for delivery ${input.webhookId}`);
  }
  return { status: "accepted", event, jobId: queued.jobId };
}

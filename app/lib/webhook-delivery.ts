// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// Webhook 投递去重编排：靠 WebhookDelivery.webhookId @unique 实现落库幂等，
// 只依赖注入的 webhookDelivery 代理——同一份逻辑既能喂假客户端（单测），也能喂真实 Prisma。
import type { PrismaClient } from "@prisma/client";
import { isUniqueViolation } from "./sync-job-policy.ts";

/** 去重只用 webhookDelivery 一个代理。 */
export type WebhookDeliveryClient = Pick<PrismaClient, "webhookDelivery">;

export type DeliveryInput = {
  shop: string;
  shopId?: string | null;
  /** X-Shopify-Webhook-Id：官方保证的投递唯一标识。 */
  webhookId: string;
  topic: string;
};

export type DeliveryResult = {
  /** true=首次投递、已落库；false=重复投递被拒。 */
  accepted: boolean;
  duplicate: boolean;
};

/** 投递记录保留窗口（小时），供 TTL 清理。默认 24h，可用 env 覆盖。 */
export function webhookDeliveryTtlHours(): number {
  const configured = Number(process.env.WEBHOOK_DELIVERY_TTL_HOURS ?? 24);
  if (!Number.isFinite(configured) || configured <= 0) return 24;
  return Math.min(configured, 24 * 7); // 上限 7 天，避免去重表无界增长
}

/** 早于此时刻的投递记录视为可清理。 */
export function deliveryTtlCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - webhookDeliveryTtlHours() * 3_600_000);
}

/**
 * 尝试登记一次投递。撞 webhookId 唯一约束（P2002）即判定为 Shopify 的重复投递，
 * 返回 accepted:false —— 上层据此直接回 200、不再重复处理。缺 webhookId 视为非法，拒收。
 */
export async function tryRecordDelivery(
  client: WebhookDeliveryClient,
  input: DeliveryInput,
): Promise<DeliveryResult> {
  if (!input.webhookId) return { accepted: false, duplicate: false };
  try {
    await client.webhookDelivery.create({
      data: {
        shop: input.shop,
        shopId: input.shopId ?? null,
        webhookId: input.webhookId,
        topic: input.topic,
      },
    });
    return { accepted: true, duplicate: false };
  } catch (error) {
    if (isUniqueViolation(error)) return { accepted: false, duplicate: true };
    throw error;
  }
}

/** 清理超 TTL 的投递记录，返回删除条数（挂在 worker 周期任务上）。 */
export async function pruneOldDeliveries(
  client: WebhookDeliveryClient,
  before: Date = deliveryTtlCutoff(),
): Promise<number> {
  const { count } = await client.webhookDelivery.deleteMany({
    where: { receivedAt: { lt: before } },
  });
  return count;
}

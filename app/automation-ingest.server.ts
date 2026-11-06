import db from "./db.server";
import {
  ingestWebhook as ingestCore,
  type IngestInput,
  type IngestOutcome,
} from "./lib/automation-ingest";
import { trackEvent } from "./analytics.server";
import { createLogger } from "./lib/logger";

const logger = createLogger({ component: "automation-ingest" });

/**
 * 统一 webhook 接收壳的真实库绑定面；编排在 lib/automation-ingest，脱库可测。
 * 调用点：已接入的 webhooks.*.tsx 路由，在 V1 处理之后追加，失败不影响快速 200。
 */
export function ingestWebhook(input: IngestInput): Promise<IngestOutcome> {
  return ingestCore(db, input);
}

/**
 * 路由侧安全入口：V2 接收链的任何异常只记日志、绝不上抛——
 * 不能因为自动化基建的异常把 V1 的同步处理与快速 200 一起带崩。
 */
export async function ingestWebhookSafely(input: IngestInput): Promise<void> {
  try {
    const outcome = await ingestWebhook(input);
    logger.info(`ingest ${input.topic}: ${outcome.status}`, {
      shop: input.shopDomain,
    });
    // 投递去重命中埋点（P4-20）：shop 维度、无 PII；同 X-Shopify-Webhook-Id 重复投递的观测面。
    if (outcome.status === "duplicate") {
      trackEvent(input.shopDomain, "webhook_dedup_hit", { topic: input.topic });
    }
  } catch (error) {
    logger.error(`ingest failed for ${input.topic}`, {
      shop: input.shopDomain,
      error,
    });
  }
}

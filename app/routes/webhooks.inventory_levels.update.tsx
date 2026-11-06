import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestWebhookSafely } from "../automation-ingest.server";
import { handleInventoryLevelWebhook } from "../webhook-sync.server";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "webhook.inventory-update" });

/**
 * 库存层级变化：按地点重算当日快照并追写可售变化事件。
 * 无论是否真的重算都返回 200——让 Shopify 重试只会把同一批数据反复写进来，没有意义。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, payload, topic, webhookId } = await authenticate.webhook(request);

  const status = await handleInventoryLevelWebhook({ shop, admin, payload });
  logger.info(`Received inventory_levels/update webhook: ${status}`, { shop });

  // V2 自动化接收链（P1-07）：去重→归一→入队；内部全捕获，不影响这里的快速 200。
  await ingestWebhookSafely({
    shopDomain: shop,
    topic: String(topic),
    webhookId,
    payload,
  });

  return new Response();
};

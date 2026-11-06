import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestWebhookSafely } from "../automation-ingest.server";
import { handleOrderWebhook } from "../webhook-sync.server";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "webhook.orders-cancelled" });

/** 订单取消：走和创建完全相同的整日重算，因此不需要按方向加减，也不会算出负销量。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, shop, payload, topic, webhookId } = await authenticate.webhook(request);

  const status = await handleOrderWebhook({
    shop,
    admin,
    payload,
    canReadAllOrders:
      session?.scope
        ?.split(",")
        .map((scope) => scope.trim())
        .includes("read_all_orders") ?? false,
  });
  logger.info(`Received orders/cancelled webhook: ${status}`, { shop });

  // V2 自动化接收链（P1-07）：去重→归一→入队；内部全捕获，不影响这里的快速 200。
  await ingestWebhookSafely({
    shopDomain: shop,
    topic: String(topic),
    webhookId,
    payload,
  });

  return new Response();
};

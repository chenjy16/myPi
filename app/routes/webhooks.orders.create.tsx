import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestWebhookSafely } from "../automation-ingest.server";
import { handleOrderWebhook } from "../webhook-sync.server";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "webhook.orders-create" });

/** 新订单：整日重算该单归属销售日的销量。 */
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
  logger.info(`Received orders/create webhook: ${status}`, { shop });

  // V2 自动化接收链（P1-07）：去重→归一→入队；内部全捕获，不影响这里的快速 200。
  await ingestWebhookSafely({
    shopDomain: shop,
    topic: String(topic),
    webhookId,
    payload,
  });

  return new Response();
};

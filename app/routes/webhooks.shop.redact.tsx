import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShopBusinessData } from "../webhook-sync.server";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "webhook.shop-redact" });

/** 商店删除合规 webhook：清理该商店在应用里的全部数据（与卸载同一口径，一张表都不留）。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info(`Received ${topic} webhook`, { shop });

  const removed = await purgeShopBusinessData(shop);

  logger.info("Redacted shop data", { shop, removed });

  return new Response();
};

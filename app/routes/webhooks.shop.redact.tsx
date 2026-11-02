import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShopBusinessData } from "../webhook-sync.server";

/** 商店删除合规 webhook：清理该商店在应用里的全部数据（与卸载同一口径，一张表都不留）。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const removed = await purgeShopBusinessData(shop);

  console.log(`Redacted shop data for ${shop}: ${removed.join(", ")}`);

  return new Response();
};

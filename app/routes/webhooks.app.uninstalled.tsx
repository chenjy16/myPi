import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShopBusinessData } from "../webhook-sync.server";

/** 应用卸载：校验 webhook 后删除该 shop 的 session 与全部业务数据。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhooks can be retried after the session has already been removed.
  const removed = await purgeShopBusinessData(shop);

  console.log(`Purged business data for ${shop}: ${removed.join(", ")}`);

  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleInventoryLevelWebhook } from "../webhook-sync.server";

/**
 * 库存层级变化：按地点重算当日快照并追写可售变化事件。
 * 无论是否真的重算都返回 200——让 Shopify 重试只会把同一批数据反复写进来，没有意义。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, shop, payload } = await authenticate.webhook(request);

  const status = await handleInventoryLevelWebhook({ shop, admin, payload });
  console.log(
    `Received inventory_levels/update webhook for ${shop}: ${status}`,
  );

  return new Response();
};

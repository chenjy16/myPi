import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderWebhook } from "../webhook-sync.server";

/** 订单取消：走和创建完全相同的整日重算，因此不需要按方向加减，也不会算出负销量。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, shop, payload } = await authenticate.webhook(request);

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
  console.log(`Received orders/cancelled webhook for ${shop}: ${status}`);

  return new Response();
};

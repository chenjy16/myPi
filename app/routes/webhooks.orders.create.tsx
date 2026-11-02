import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleOrderWebhook } from "../webhook-sync.server";

/** 新订单：整日重算该单归属销售日的销量。 */
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
  console.log(`Received orders/create webhook for ${shop}: ${status}`);

  return new Response();
};

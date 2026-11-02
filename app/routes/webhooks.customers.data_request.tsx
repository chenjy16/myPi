import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/** 客户数据请求：本应用不存储客户数据，校验后仅记录日志。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(
    `Received ${topic} webhook for ${shop}; no customer data is stored.`,
  );
  return new Response();
};

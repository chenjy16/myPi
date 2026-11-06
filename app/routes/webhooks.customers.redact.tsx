import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createLogger } from "../lib/logger";
import { redactCustomerComplianceData } from "../customer-compliance.server";

const logger = createLogger({ component: "webhook.customers.redact" });

/**
 * 客户数据删除（GDPR/CCPA，P4-09）：清除执行史里对该客户的全部引用——
 * ExecutionLog.entityRef/payload 与 ExecutionStep.result/errorText 中的客户标识
 * 一律掩蔽为占位串；执行时间线本身保留（自动化审计所需，不再可关联到具体客户）。
 * 整店删除由 shop/redact → purgeShopBusinessData 负责（含全部 V2 表）。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const body = payload as {
    customer?: { id?: number | string };
    customer_ids?: (number | string)[];
  };
  const ids: (number | string)[] = Array.isArray(body?.customer_ids)
    ? body.customer_ids
    : body?.customer?.id !== undefined
      ? [body.customer.id]
      : [];

  let masked = { executionsScanned: 0, logsMasked: 0, stepsMasked: 0 };
  if (ids.length > 0) {
    masked = await redactCustomerComplianceData(shop, ids);
  }
  logger.info(`redact for ${topic} ${shop}`, {
    requestedIds: ids.length,
    ...masked,
  });

  return new Response();
};

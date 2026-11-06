import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createLogger } from "../lib/logger";
import { exportCustomerComplianceData } from "../customer-compliance.server";

const logger = createLogger({ component: "webhook.customers.data_request" });

/**
 * 客户数据请求（GDPR/CCPA，P4-09）：回传本应用存储的、与该客户相关的自动化执行记录。
 * 事实口径：我们不落库原始客户 PII（事件快照走白名单裁剪），存量是「执行史对该客户的引用」
 * ——触发实体、掩蔽后的步骤结果。响应即该清单（JSON 回传；无相关记录时为空数组）。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const customerId = (payload as { customer?: { id?: number | string } })
    ?.customer?.id;
  let records: Awaited<ReturnType<typeof exportCustomerComplianceData>> = [];
  if (customerId !== undefined && customerId !== null) {
    records = await exportCustomerComplianceData(shop, customerId);
  }
  logger.info(`data_request for ${topic} ${shop}`, {
    customerId: String(customerId ?? ""),
    matched: records.length,
  });

  return Response.json({
    shop_domain: shop,
    customer_id: customerId ?? null,
    // 本应用不存储客户姓名/邮箱/地址等原始 PII；以下为自动化执行史中与该客户相关的引用记录，
    // 客户标识之外的字段已掩蔽。
    privacy_note:
      "StockPilot stores no raw customer PII. Listed records are automation execution references to this customer, with customer identifiers masked in payloads.",
    records,
  });
};

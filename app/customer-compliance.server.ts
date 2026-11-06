import db from "./db.server";
import { ensureShop } from "./shop-directory.server";
import {
  findCustomerExecutionRecords,
  redactCustomerReferences,
  type CustomerExecutionRecord,
  type RedactOutcome,
} from "./lib/customer-compliance";

/**
 * 客户级合规处理的真实库绑定面（P4-09）。判定/掩蔽逻辑在 lib/customer-compliance，脱库可测；
 * 这里只补两件事：把已鉴权的 shop 域名落成租户行（与 ingest 同一口径），以及喂真 Prisma。
 */

export async function exportCustomerComplianceData(
  shopDomain: string,
  customerId: string | number,
): Promise<CustomerExecutionRecord[]> {
  const shop = await ensureShop(shopDomain);
  return findCustomerExecutionRecords(db, shop.id, customerId);
}

export async function redactCustomerComplianceData(
  shopDomain: string,
  customerIds: (string | number)[],
): Promise<RedactOutcome> {
  const shop = await ensureShop(shopDomain);
  return redactCustomerReferences(db, shop.id, customerIds);
}

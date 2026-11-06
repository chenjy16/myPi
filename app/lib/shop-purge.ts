// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// 合规整店清理的服务核（P4-09/P1-15）：`app/uninstalled` 与 `shop/redact` 共用的删除口径。
// client 注入：脱库单测喂假客户端，DB 集成测喂真 Prisma（跨店 purge 只清本店是他的强断言面）。
// 这里列出「本店在应用里的全部业务数据」，只按 `shop`/`shopId` 过滤，不留任何表在外。
// 新增业务模型时必须同步加进这张清单 —— 漏一张就等于把该删的数据留在库里。
import type { PrismaClient } from "@prisma/client";

export type PurgeClient = Pick<
  PrismaClient,
  | "session"
  | "productDraft"
  | "inventorySnapshot"
  | "inventoryEvent"
  | "location"
  | "dataSyncJob"
  | "salesDaily"
  | "reorderRecommendation"
  | "recommendationAudit"
  | "inventorySettings"
  | "variantSupplier"
  | "supplier"
  | "purchasePlanLine"
  | "purchasePlan"
  | "adviceFeedback"
  | "analyticsEvent"
  | "executionLog"
  | "automation"
  | "scheduledJob"
  | "integration"
  | "webhookDelivery"
  | "shop"
>;

type ShopScopedDelete = (
  client: PurgeClient,
  shop: string,
) => Promise<{ count: number }>;

// 子表排在父表前面删，deleteMany 的计数才是各行自己的行数。
const SHOP_SCOPED_DELETES: Array<[model: string, remove: ShopScopedDelete]> = [
  ["session", (c, shop) => c.session.deleteMany({ where: { shop } })],
  ["productDraft", (c, shop) => c.productDraft.deleteMany({ where: { shop } })],
  [
    "inventorySnapshot",
    (c, shop) => c.inventorySnapshot.deleteMany({ where: { shop } }),
  ],
  ["inventoryEvent", (c, shop) => c.inventoryEvent.deleteMany({ where: { shop } })],
  ["location", (c, shop) => c.location.deleteMany({ where: { shop } })],
  ["dataSyncJob", (c, shop) => c.dataSyncJob.deleteMany({ where: { shop } })],
  ["salesDaily", (c, shop) => c.salesDaily.deleteMany({ where: { shop } })],
  [
    "reorderRecommendation",
    (c, shop) => c.reorderRecommendation.deleteMany({ where: { shop } }),
  ],
  [
    "recommendationAudit",
    (c, shop) => c.recommendationAudit.deleteMany({ where: { shop } }),
  ],
  [
    "inventorySettings",
    (c, shop) => c.inventorySettings.deleteMany({ where: { shop } }),
  ],
  ["variantSupplier", (c, shop) => c.variantSupplier.deleteMany({ where: { shop } })],
  ["supplier", (c, shop) => c.supplier.deleteMany({ where: { shop } })],
  [
    "purchasePlanLine",
    (c, shop) => c.purchasePlanLine.deleteMany({ where: { shop } }),
  ],
  ["purchasePlan", (c, shop) => c.purchasePlan.deleteMany({ where: { shop } })],
  ["adviceFeedback", (c, shop) => c.adviceFeedback.deleteMany({ where: { shop } })],
  ["analyticsEvent", (c, shop) => c.analyticsEvent.deleteMany({ where: { shop } })],
  // —— V2 自动化子系统：按租户关系删，父表 deleteMany 借 DB 级 Cascade 带走子表。——
  // executionStep 由 executionLog 的 Cascade 删除，无需单列。
  ["executionLog", (c, shop) => c.executionLog.deleteMany({ where: { shop: { shop } } })],
  // automationVersion 由 automation 的 Cascade 删除，无需单列。
  ["automation", (c, shop) => c.automation.deleteMany({ where: { shop: { shop } } })],
  ["scheduledJob", (c, shop) => c.scheduledJob.deleteMany({ where: { shop: { shop } } })],
  ["integration", (c, shop) => c.integration.deleteMany({ where: { shop: { shop } } })],
  // WebhookDelivery 直接带 shop 域名字符串，按域名删。
  ["webhookDelivery", (c, shop) => c.webhookDelivery.deleteMany({ where: { shop } })],
  // Shop 租户行最后删（其 Cascade 已把上面任何漏网子表带走）。
  ["shop", (c, shop) => c.shop.deleteMany({ where: { shop } })],
];

/** 返回每张表实际删掉的行数，便于在日志里留下「确实删干净了」的证据。 */
export async function purgeShopBusinessData(
  client: PurgeClient,
  shop: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const [model, remove] of SHOP_SCOPED_DELETES) {
    const { count } = await remove(client, shop);
    removed.push(`${model}:${count}`);
  }
  return removed;
}

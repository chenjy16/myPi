import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "./db.server";
import { refreshLocationSnapshot, syncOrderDay } from "./inventory.server";
import { hasRunningJob, lastSucceededAt } from "./sync-jobs.server";

/**
 * webhook 增量同步的落库策略。
 *
 * 共同原则：payload 只当「什么东西变了」的失效信号，数值一律回 Admin API 重读。
 * 两条链路都是重算式写入（同日 upsert / 整日重建），所以 Shopify 的重试不需要额外的去重表。
 * 解析不出关键 id 时只记日志、不抛错——抛错会让 Shopify 反复重试同一份无法处理的 payload。
 */

/** 库存快照要翻页读完全部变体，代价高，短时间连发的事件合并成一次重算。 */
const SNAPSHOT_COALESCE_MS =
  Number(process.env.WEBHOOK_SNAPSHOT_COALESCE_SECONDS ?? 60) * 1000;

export type WebhookSyncStatus =
  "refreshed" | "coalesced" | "running" | "skipped";

/** 把 payload 里的 id 归一成 GID：兼容 REST 数字 id 与 GraphQL 原生字符串 id 两种形状。 */
function toGid(value: unknown, type: "Location" | "Order"): string | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return `gid://shopify/${type}/${value}`;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("gid://")) return value;
  return /^\d+$/.test(value) ? `gid://shopify/${type}/${value}` : null;
}

async function snapshotBusy(shop: string): Promise<WebhookSyncStatus> {
  if (await hasRunningJob(shop, "inventory-snapshot")) return "running";
  const last = await lastSucceededAt(shop, "inventory-snapshot");
  return last && Date.now() - last.getTime() < SNAPSHOT_COALESCE_MS
    ? "coalesced"
    : "refreshed";
}

/**
 * inventory_levels/update：payload 只保证给到地点，变体要靠重读拿。
 * 因此按地点整批改当日快照，并把与库里当前值不同的可售出成事件。
 */
export async function handleInventoryLevelWebhook(input: {
  admin: AdminApiContext | undefined;
  shop: string;
  payload: Record<string, unknown>;
}): Promise<WebhookSyncStatus> {
  if (!input.admin) return "skipped";

  const locationId = toGid(
    input.payload.location_id ?? input.payload.locationId,
    "Location",
  );
  if (!locationId) return "skipped";

  const status = await snapshotBusy(input.shop);
  if (status !== "refreshed") return status;

  await refreshLocationSnapshot(input.admin, input.shop, locationId, "webhook");
  return "refreshed";
}

/**
 * orders/create 与 orders/cancelled：定位这张单归属的销售日并整日重算销量。
 * canReadAllOrders 决定可回看窗口，窗口外的日子读不全，重算会误删，交给每日 cron 兜底。
 */
export async function handleOrderWebhook(input: {
  admin: AdminApiContext | undefined;
  shop: string;
  payload: Record<string, unknown>;
  canReadAllOrders: boolean;
}): Promise<WebhookSyncStatus> {
  if (!input.admin) return "skipped";

  const orderId = toGid(
    input.payload.admin_graphql_api_id ?? input.payload.id,
    "Order",
  );
  if (!orderId) return "skipped";

  if (await hasRunningJob(input.shop, "sales-daily")) return "running";

  await syncOrderDay(
    input.admin,
    input.shop,
    orderId,
    input.canReadAllOrders,
    "webhook",
  );
  return "refreshed";
}

type ShopScopedDelete = (shop: string) => Promise<{ count: number }>;

/**
 * 合规删除（`app/uninstalled` 与 `shop/redact`）共用的清理口径。
 *
 * 这里列出「本店在应用里的全部业务数据」，只按 `shop` 过滤，不留任何表在外。
 * 新增业务模型时必须同步加进这张清单 —— 漏一张就等于把该删的数据留在库里，
 * `RecommendationAudit` 是阶段 2 才加的，之前两条 webhook 都还没覆盖到它。
 */
const SHOP_SCOPED_DELETES: Array<[model: string, remove: ShopScopedDelete]> = [
  ["session", (shop) => db.session.deleteMany({ where: { shop } })],
  ["productDraft", (shop) => db.productDraft.deleteMany({ where: { shop } })],
  [
    "inventorySnapshot",
    (shop) => db.inventorySnapshot.deleteMany({ where: { shop } }),
  ],
  [
    "inventoryEvent",
    (shop) => db.inventoryEvent.deleteMany({ where: { shop } }),
  ],
  ["location", (shop) => db.location.deleteMany({ where: { shop } })],
  ["dataSyncJob", (shop) => db.dataSyncJob.deleteMany({ where: { shop } })],
  ["salesDaily", (shop) => db.salesDaily.deleteMany({ where: { shop } })],
  [
    "reorderRecommendation",
    (shop) => db.reorderRecommendation.deleteMany({ where: { shop } }),
  ],
  [
    "recommendationAudit",
    (shop) => db.recommendationAudit.deleteMany({ where: { shop } }),
  ],
  [
    "inventorySettings",
    (shop) => db.inventorySettings.deleteMany({ where: { shop } }),
  ],
  // 子表排在父表前面删，deleteMany 的计数才是各行自己的行数。
  [
    "variantSupplier",
    (shop) => db.variantSupplier.deleteMany({ where: { shop } }),
  ],
  [
    "supplier",
    (shop) => db.supplier.deleteMany({ where: { shop } }),
  ],
  [
    "purchasePlanLine",
    (shop) => db.purchasePlanLine.deleteMany({ where: { shop } }),
  ],
  [
    "purchasePlan",
    (shop) => db.purchasePlan.deleteMany({ where: { shop } }),
  ],
  [
    "adviceFeedback",
    (shop) => db.adviceFeedback.deleteMany({ where: { shop } }),
  ],
  [
    "analyticsEvent",
    (shop) => db.analyticsEvent.deleteMany({ where: { shop } }),
  ],
];

/** 返回每张表实际删掉的行数，便于在日志里留下「确实删干净了」的证据。 */
export async function purgeShopBusinessData(shop: string): Promise<string[]> {
  const removed: string[] = [];
  for (const [model, remove] of SHOP_SCOPED_DELETES) {
    const { count } = await remove(shop);
    removed.push(`${model}:${count}`);
  }
  return removed;
}

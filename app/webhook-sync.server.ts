import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "./db.server";
import { toGid } from "./lib/shopify-id";
import { purgeShopBusinessData as purgeCore } from "./lib/shop-purge";
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

/**
 * 合规删除（`app/uninstalled` 与 `shop/redact`）共用的清理口径：
 * 删除清单与子先父后顺序在 lib/shop-purge（可注入客户端、脱库可测），这里是真库绑定。
 */

/** 返回每张表实际删掉的行数，便于在日志里留下「确实删干净了」的证据。 */
export async function purgeShopBusinessData(shop: string): Promise<string[]> {
  return purgeCore(db, shop);
}

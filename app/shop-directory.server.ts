import db from "./db.server";
import {
  ensureShop as ensureShopCore,
  resolveShopFromSession as resolveShopCore,
  backfillShops as backfillShopsCore,
  type ShopDefaults,
} from "./lib/shop-directory";

/** Shop 租户目录的真实库绑定面；逻辑在 lib/shop-directory，便于脱库单测。 */
export function ensureShop(shopDomain: string, defaults: ShopDefaults = {}) {
  return ensureShopCore(db, shopDomain, defaults);
}

export function resolveShopFromSession(
  shopDomain: string,
  defaults: ShopDefaults = {},
) {
  return resolveShopCore(db, shopDomain, defaults);
}

export function backfillAllShops() {
  return backfillShopsCore(db);
}

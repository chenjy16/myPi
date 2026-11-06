// 对账绑定面（P4-13）：把纯判定 reconcile-core 接到真实 db 与 Admin API。
// 默认只对账「非 protected、当前已订阅」的 products/update —— orders/customers 受 Protected
// Customer Data 审批阻塞（见 docs/V2-PHASE4-TASKS.md R1/B-1），审批通过后按同形状并入 fetchDeltas。
// fetchDeltas 作为注入点：DB 集成测与单测喂假实体，绕开真实 Shopify；生产喂 adminGraphql 拉取。
import db from "./db.server";
import { adminGraphql } from "./lib/admin-graphql.server";
import { ensureShop } from "./lib/shop-directory";
import { toGid } from "./lib/shopify-id";
import { trackEvent } from "./analytics.server";
import type { StandardEvent } from "./lib/event-normalizer";
import {
  reconcileShopEntities,
  type ReconcileShopResult,
} from "./lib/reconcile-core";
import type { ReconcileDelta } from "./lib/reconcile-policy";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/** products/update 对账查询：按 updatedAt 过滤窗口内的活跃商品，取判定所需最小字段。 */
const RECENT_PRODUCTS_QUERY = `#graphql
  query ReconcileRecentProducts($query: String!) {
    products(first: 50, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        title
        status
        updatedAt
      }
    }
  }`;

type ProductNode = {
  id: string;
  title?: string | null;
  status?: string | null;
  updatedAt: string;
};

/** 默认取数：Admin 拉窗口内更新过的商品，归一成 products/update 变更。 */
export async function fetchProductDeltas(input: {
  admin: AdminApiContext;
  shopDomain: string;
  since: Date;
  until: Date;
}): Promise<ReconcileDelta[]> {
  const query = `updated_at:>=${input.since.toISOString()} updated_at:<${input.until.toISOString()}`;
  const data = await adminGraphql<{ products: { nodes: ProductNode[] } }>(
    input.admin,
    RECENT_PRODUCTS_QUERY,
    { variables: { query } },
  );
  const deltas: ReconcileDelta[] = [];
  for (const node of data.products?.nodes ?? []) {
    const entityId = toGid(node.id, "Product");
    const changedAt = new Date(node.updatedAt);
    if (!entityId || Number.isNaN(changedAt.getTime())) continue;
    const event: StandardEvent = {
      shopDomain: input.shopDomain,
      topic: "products/update",
      entityType: "Product",
      entityId,
      occurredAt: changedAt,
      // 与 event-normalizer 对 products/update 的输出同形，保证补投与正常投递指纹一致。
      data: { status: node.status ?? undefined, title: node.title ?? undefined },
    };
    deltas.push({ event, changedAt });
  }
  return deltas;
}

export type ReconcileShopArgs = {
  admin: AdminApiContext;
  shopDomain: string;
  since: Date;
  until: Date;
  /** 取数注入点：测试替换为假实体，生产用默认 fetchProductDeltas。 */
  fetchDeltas?: (input: {
    admin: AdminApiContext;
    shopDomain: string;
    since: Date;
    until: Date;
  }) => Promise<ReconcileDelta[]>;
};

/** 对账单店：落租户行 → 拉变更 → 交给 reconcile-core 判漏并补投。 */
export async function reconcileShop(
  args: ReconcileShopArgs,
): Promise<ReconcileShopResult> {
  const shop = await ensureShop(db, args.shopDomain);
  const fetch = args.fetchDeltas ?? fetchProductDeltas;
  const deltas = await fetch({
    admin: args.admin,
    shopDomain: args.shopDomain,
    since: args.since,
    until: args.until,
  });
  const result = await reconcileShopEntities(db, {
    shopDomain: args.shopDomain,
    shopId: shop.id,
    since: args.since,
    deltas,
  });
  // 对账补投埋点（P4-20）：仅在真补了才记，shop 维度、无 PII，供漏投修复可观测。
  if (result.requeued > 0) {
    trackEvent(args.shopDomain, "reconcile_requeued", {
      requeued: result.requeued,
      scanned: result.scanned,
    });
  }
  return result;
}

// 带扩展名是故意的：本文件要能被 `node --test` 直接加载。
// 纯逻辑：把某 topic 的原始 webhook body 归一成 StandardEvent，屏蔽 REST/GraphQL 两种形状差异。
// 解析不出关键 id 时返回 null（由 ingest 层记日志、绝不抛错——抛错会让 Shopify 反复重试坏 payload，
// 沿用 V1 webhook-sync 的既定原则）。data 只带条件判定所需的最小字段，不塞客户联系方式等 PII。
import { toGid } from "./shopify-id.ts";

export type StandardEvent = {
  shopDomain: string;
  topic: string;
  entityType: string;
  /** 触发实体的 GID；null 表示无法定位实体（上层据此跳过）。 */
  entityId: string | null;
  occurredAt: Date;
  /** 供 Condition Evaluator 消费的安全字段集。 */
  data: Record<string, unknown>;
};

/** 本归一器覆盖的 Phase 1 topic（其余返回 null，交由后续扩展）。 */
export const SUPPORTED_TOPICS: readonly string[] = [
  "orders/create",
  "orders/paid",
  "orders/cancelled",
  "customers/create",
  "products/update",
  "inventory_levels/update",
];

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 字符串/数字金额 → number；不可解析返回 null（不猜测）。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 兼容 Shopify 逗号串（REST）与字符串数组（GraphQL）两种 tags 形状。 */
function toTagArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof value === "string" && value.trim() !== "")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === "string" && v.length) return v;
  return undefined;
}

/**
 * 归一一条事件。occurredAt 由调用方注入（引擎侧传 Shopify 时间戳 / 当前时间），
 * 纯函数不自取时钟，保证可测与确定性。
 */
export function normalizeEvent(input: {
  shopDomain: string;
  topic: string;
  payload: unknown;
  occurredAt?: Date;
}): StandardEvent | null {
  const body = asObject(input.payload);
  if (!body) return null;
  const occurredAt = input.occurredAt ?? new Date();
  const base = { shopDomain: input.shopDomain, topic: input.topic, occurredAt };

  switch (input.topic) {
    case "orders/create":
    case "orders/paid":
    case "orders/cancelled": {
      const entityId = toGid(
        body.admin_graphql_api_id ?? body.id,
        "Order",
      );
      if (!entityId) return null;
      const customer = asObject(body.customer);
      return {
        ...base,
        entityType: "Order",
        entityId,
        data: {
          total_price: toNumber(body.total_price ?? body.current_total_price),
          currency: firstString(body.currency),
          cancelled_at: firstString(body.cancelled_at) ?? null,
          customer_tags: toTagArray(customer?.tags),
        },
      };
    }
    case "customers/create": {
      const entityId = toGid(
        body.admin_graphql_api_id ?? body.id,
        "Customer",
      );
      if (!entityId) return null;
      return {
        ...base,
        entityType: "Customer",
        entityId,
        data: {
          tags: toTagArray(body.tags),
          note: firstString(body.note) ?? "",
        },
      };
    }
    case "products/update": {
      const entityId = toGid(
        body.admin_graphql_api_id ?? body.id,
        "Product",
      );
      if (!entityId) return null;
      return {
        ...base,
        entityType: "Product",
        entityId,
        data: {
          status: firstString(body.status),
          title: firstString(body.title),
        },
      };
    }
    case "inventory_levels/update": {
      // 库存层级没有独立 GID：以 inventory_item_id（ProductVariant GID）为触发实体，
      // 地点归一成 Location GID 放进 data，供 T4 定位补货来源。
      const entityId = toGid(
        body.admin_graphql_api_id ?? body.inventory_item_id,
        "ProductVariant",
      );
      if (!entityId) return null;
      return {
        ...base,
        entityType: "ProductVariant",
        entityId,
        data: {
          available: toNumber(body.available),
          location_id: toGid(body.location_id ?? body.locationId, "Location"),
        },
      };
    }
    default:
      return null;
  }
}

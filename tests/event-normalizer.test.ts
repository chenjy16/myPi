import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUPPORTED_TOPICS,
  normalizeEvent,
} from "../app/lib/event-normalizer.ts";

/**
 * 事件归一器单测（P1-08）：REST 与 GraphQL 两种 payload 形状必须归出同一个
 * StandardEvent；解析不出关键 id 时返回 null 而非抛错（坏 payload 不该让 Shopify 无限重试）；
 * data 只带条件判定所需的安全字段，客户联系方式等 PII 绝不外溢。
 */

const occurredAt = new Date("2026-11-05T08:00:00Z");

function normalize(topic: string, payload: unknown) {
  return normalizeEvent({
    shopDomain: "demo.myshopify.com",
    topic,
    payload,
    occurredAt,
  });
}

test("orders/create（REST 数字 id）归一成 Order 事件", () => {
  const event = normalize("orders/create", {
    id: 1234,
    total_price: "199.00",
    currency: "USD",
    customer: { email: "vip@example.com", tags: "wholesale,vip" },
  });
  assert.ok(event);
  assert.equal(event.entityType, "Order");
  assert.equal(event.entityId, "gid://shopify/Order/1234");
  assert.equal(event.shopDomain, "demo.myshopify.com");
  assert.equal(event.occurredAt, occurredAt);
  assert.equal(event.data.total_price, 199);
  assert.deepEqual(event.data.customer_tags, ["wholesale", "vip"]);
});

test("GraphQL 原生 GID 形状与 REST 数字形状归一出相同 entityId", () => {
  const rest = normalize("orders/paid", { id: 42, total_price: 10 });
  const graphql = normalize("orders/paid", {
    admin_graphql_api_id: "gid://shopify/Order/42",
    current_total_price: "10",
  });
  assert.ok(rest && graphql);
  assert.equal(rest.entityId, graphql.entityId);
  assert.equal(rest.data.total_price, 10);
  assert.equal(graphql.data.total_price, 10);
});

test("payload 里绝不携带客户 email 等 PII", () => {
  const event = normalize("orders/create", {
    id: 1,
    email: "buyer@example.com",
    customer: { email: "buyer@example.com", phone: "13800000000" },
  });
  assert.ok(event);
  const serialized = JSON.stringify(event.data);
  assert.ok(!serialized.includes("buyer@example.com"));
  assert.ok(!serialized.includes("13800000000"));
});

test("customers/create：tags 兼容逗号串与数组两种形状", () => {
  const comma = normalize("customers/create", { id: 7, tags: "a, b ,,c" });
  const array = normalize("customers/create", {
    admin_graphql_api_id: "gid://shopify/Customer/7",
    tags: ["a", "b", "", "c"],
  });
  assert.ok(comma && array);
  assert.deepEqual(comma.data.tags, ["a", "b", "c"]);
  assert.deepEqual(array.data.tags, ["a", "b", "c"]);
});

test("inventory_levels/update 以 inventory_item_id 为触发实体并归一 Location GID", () => {
  const event = normalize("inventory_levels/update", {
    inventory_item_id: 555,
    location_id: 666,
    available: 3,
  });
  assert.ok(event);
  assert.equal(event.entityType, "ProductVariant");
  assert.equal(event.entityId, "gid://shopify/ProductVariant/555");
  assert.equal(event.data.available, 3);
  assert.equal(event.data.location_id, "gid://shopify/Location/666");
});

test("缺关键 id / 非对象 payload / 未支持 topic 一律返回 null，不抛错", () => {
  assert.equal(normalize("orders/create", { total_price: 1 }), null);
  assert.equal(normalize("orders/create", "not-an-object"), null);
  assert.equal(normalize("orders/create", null), null);
  assert.equal(normalize("purchases/create", { id: 1 }), null);
});

test("未显式传 occurredAt 时不自取奇时钟以外的行为：两次调用仅相差运行耗时", () => {
  const event = normalizeEvent({
    shopDomain: "demo.myshopify.com",
    topic: "products/update",
    payload: { id: 9, status: "active", title: "Tee" },
  });
  assert.ok(event);
  assert.ok(event.occurredAt instanceof Date);
  assert.ok(Math.abs(event.occurredAt.getTime() - Date.now()) < 5_000);
});

test("Phase 1 覆盖的 6 个 topic 全部能归一", () => {
  const payloads: Record<string, unknown> = {
    "orders/create": { id: 1 },
    "orders/paid": { id: 2 },
    "orders/cancelled": { orders: [], id: 3 },
    "customers/create": { id: 4 },
    "products/update": { id: 5 },
    "inventory_levels/update": { inventory_item_id: 6, location_id: 7 },
  };
  assert.deepEqual([...SUPPORTED_TOPICS].sort(), Object.keys(payloads).sort());
  for (const [topic, payload] of Object.entries(payloads)) {
    assert.ok(normalize(topic, payload), `${topic} 应能归一`);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_TRIGGER_TYPES,
  fieldWhitelist,
  getTrigger,
  triggerForTopic,
  triggerMatchesEvent,
} from "../app/lib/trigger-registry.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

function event(topic: string): StandardEvent {
  return {
    shopDomain: "s.myshopify.com",
    topic,
    entityType: "Order",
    entityId: "gid://shopify/Order/1",
    occurredAt: new Date("2026-11-05T00:00:00Z"),
    data: {},
  };
}

test("getTrigger：已登记类型返回元数据，未知类型抛错不带病运行", () => {
  const t = getTrigger("inventory.low");
  assert.equal(t.source, "shopify.webhook+reconcile");
  assert.equal(t.composite, true);
  assert.equal(t.availability, "VERIFIED");
  assert.throws(() => getTrigger("order.deleted"), /Unknown trigger type/);
});

test("白名单严格以 VERIFIED 清单为界：company 等未验证字段绝不在内", () => {
  const customer = fieldWhitelist("customer.created");
  assert.deepEqual([...customer].sort(), ["note", "tags"]);
  assert.ok(!customer.has("company"));
  const order = fieldWhitelist("order.created");
  assert.ok(order.has("total_price") && order.has("customer_tags"));
  assert.ok(!order.has("email")); // PII 不进条件判据
  // scheduler 无事件字段：白名单为空
  assert.equal(fieldWhitelist("daily.schedule").size, 0);
});

test("protected 标记：订单/客户触发全部标 R1 审批墙，product/inventory 不受限", () => {
  for (const type of ["order.created", "order.paid", "order.cancelled", "customer.created"])
    assert.equal(getTrigger(type).protectedCustomerData, true, type);
  for (const type of ["product.updated", "inventory.low", "daily.schedule"])
    assert.equal(getTrigger(type).protectedCustomerData, false, type);
});

test("availability：受 R1 阻塞的订单/客户触发标 PENDING，已验证链路标 VERIFIED", () => {
  assert.equal(getTrigger("order.created").availability, "PENDING");
  assert.equal(getTrigger("customer.created").availability, "PENDING");
  assert.equal(getTrigger("product.updated").availability, "VERIFIED");
  assert.equal(getTrigger("inventory.low").availability, "VERIFIED");
});

test("triggerForTopic：反查唯一；无绑定 topic 返回 null", () => {
  assert.equal(triggerForTopic("orders/create")?.type, "order.created");
  assert.equal(triggerForTopic("inventory_levels/update")?.type, "inventory.low");
  assert.equal(triggerForTopic("orders/updated"), null);
});

test("triggerMatchesEvent：topic 一致才匹配；scheduler 触发不接受 webhook 事件", () => {
  assert.ok(triggerMatchesEvent(getTrigger("order.paid"), event("orders/paid")));
  assert.ok(!triggerMatchesEvent(getTrigger("order.paid"), event("orders/create")));
  const scheduler = getTrigger("daily.schedule");
  assert.ok(!triggerMatchesEvent(scheduler, event("orders/paid")));
  assert.ok(triggerMatchesEvent(scheduler, event("")));
});

test("注册表自检：7 类触发全部可在 KNOWN_TRIGGER_TYPES 中枚举", () => {
  assert.deepEqual([...KNOWN_TRIGGER_TYPES].sort(), [
    "customer.created",
    "daily.schedule",
    "inventory.low",
    "order.cancelled",
    "order.created",
    "order.paid",
    "product.updated",
  ].sort());
});

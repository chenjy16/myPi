import assert from "node:assert/strict";
import { test } from "node:test";
import { toGid } from "../app/lib/shopify-id.ts";

/**
 * toGid 单一实现单测（P1-08）：从 webhook-sync.server.ts 抽出后，
 * V1 同步与 V2 归一共用同一份「payload id → GID」语义。
 */

test("REST 数字 id → GID", () => {
  assert.equal(toGid(123, "Order"), "gid://shopify/Order/123");
});

test("REST 纯数字字符串 id → GID", () => {
  assert.equal(toGid("456", "Product"), "gid://shopify/Product/456");
});

test("GraphQL 原生 GID 字符串原样透传", () => {
  const gid = "gid://shopify/Customer/789";
  assert.equal(toGid(gid, "Customer"), gid);
});

test("解析不出时返回 null，由调用方决定跳过（绝不抛错）", () => {
  assert.equal(toGid("", "Order"), null);
  assert.equal(toGid("abc", "Order"), null);
  assert.equal(toGid("12.5", "Order"), null);
  assert.equal(toGid(1.5, "Order"), null);
  assert.equal(toGid(null, "Order"), null);
  assert.equal(toGid(undefined, "Order"), null);
  assert.equal(toGid({ id: 1 }, "Order"), null);
});

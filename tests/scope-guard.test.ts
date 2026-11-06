import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateScopeGap,
  missingScopes,
  normalizeScope,
  requiredScopesForActions,
} from "../app/lib/scope-guard.ts";

// P4-06：写 scope 缺口判定的纯函数契约。
// 与 action-registry 的 requiredScopes 保持同一份事实源，避免 UI 与执行器口径分岔。

test("normalizeScope：逗号/空格混合、大小写、空串都归一", () => {
  assert.deepEqual(
    [...normalizeScope("read_orders, WRITE_PRODUCTS  read_inventory")].sort(),
    ["read_inventory", "read_orders", "write_products"],
  );
  assert.equal(normalizeScope(null).size, 0);
  assert.equal(normalizeScope(undefined).size, 0);
  assert.equal(normalizeScope("").size, 0);
  assert.equal(normalizeScope("  ").size, 0);
});

test("requiredScopesForActions：取并集去重、排序；无写动作返回空", () => {
  // tags.add → write_orders + write_customers + write_products（保守口径）
  assert.deepEqual(requiredScopesForActions(["tags.add"]), [
    "write_customers",
    "write_orders",
    "write_products",
  ]);
  // email.send / webhook.send 不占 Shopify scope
  assert.deepEqual(requiredScopesForActions(["email.send", "webhook.send"]), []);
  // 混合去重：tags.remove + product.updateStatus → 三写 scope，write_products 不重复
  assert.deepEqual(
    requiredScopesForActions(["tags.remove", "product.updateStatus"]),
    ["write_customers", "write_orders", "write_products"],
  );
  // 空集合
  assert.deepEqual(requiredScopesForActions([]), []);
});

test("missingScopes：保留 required 顺序，只筛掉未授权项", () => {
  const granted = new Set(["write_products"]);
  assert.deepEqual(missingScopes(granted, ["write_orders", "write_products"]), [
    "write_orders",
  ]);
  assert.deepEqual(missingScopes(granted, []), []);
});

test("evaluateScopeGap：只读现状下 tags.add 全缺、email.send 直通", () => {
  // Beta 默认 scope 与 shopify.app.toml 一致：全部只读
  const betaScope = "read_products,read_inventory,read_orders,read_locations";
  const tagGap = evaluateScopeGap(betaScope, ["tags.add"]);
  assert.equal(tagGap.ok, false);
  assert.deepEqual(tagGap.required, [
    "write_customers",
    "write_orders",
    "write_products",
  ]);
  assert.deepEqual(tagGap.missing, tagGap.required);

  const emailGap = evaluateScopeGap(betaScope, ["email.send"]);
  assert.equal(emailGap.ok, true);
  assert.deepEqual(emailGap.missing, []);
  assert.deepEqual(emailGap.required, []);
});

test("evaluateScopeGap：部分授权只缺差集，product.updateStatus 只要 write_products", () => {
  const gap = evaluateScopeGap(
    "read_products,write_products,read_orders",
    ["product.updateStatus"],
  );
  assert.equal(gap.ok, true);
  assert.deepEqual(gap.missing, []);

  const partial = evaluateScopeGap(
    "read_products,write_products,read_orders",
    ["tags.add"],
  );
  assert.equal(partial.ok, false);
  // write_products 已给，仍缺另外两写
  assert.deepEqual(partial.missing, ["write_customers", "write_orders"]);
});

test("evaluateScopeGap：空/ null 授权 → 所有写 scope 都缺", () => {
  const gap = evaluateScopeGap(null, ["tags.add"]);
  assert.equal(gap.ok, false);
  assert.equal(gap.missing.length, 3);
});

test("evaluateScopeGap：未知 actionId 由 getAction 抛错，不静默", () => {
  assert.throws(
    () => evaluateScopeGap("read_products", ["order.delete"]),
    /Unknown action id/,
  );
});

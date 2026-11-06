import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ShopScopeError,
  assertShopScope,
  requireShopId,
} from "../app/lib/shop-scope.ts";

test("requireShopId：空/缺失一律炸，绝不退化成「查全部」", () => {
  assert.equal(requireShopId("shop_1"), "shop_1");
  assert.throws(() => requireShopId(""), ShopScopeError);
  assert.throws(() => requireShopId(null), ShopScopeError);
  assert.throws(() => requireShopId(undefined), ShopScopeError);
});

test("assertShopScope：归属一致时原样返回（可链式）", () => {
  const row = { id: "a1", shopId: "shop_1", name: "x" };
  assert.equal(assertShopScope("shop_1", row), row);
});

test("assertShopScope：跨店抛 ShopScopeError（不区分存在性，不泄露别店有此行）", () => {
  const row = { id: "a1", shopId: "shop_2" };
  assert.throws(() => assertShopScope("shop_1", row), ShopScopeError);
});

test("assertShopScope：null/undefined/缺 shopId 列都视为不可见", () => {
  const rowNoShopId = { id: "x" } as { shopId?: string };
  assert.throws(() => assertShopScope("shop_1", null), ShopScopeError);
  assert.throws(() => assertShopScope("shop_1", undefined), ShopScopeError);
  assert.throws(() => assertShopScope("shop_1", rowNoShopId), ShopScopeError);
});

test("assertShopScope：先校验会话 shopId 本身——空会话拿着任何行也过不了", () => {
  assert.throws(
    () => assertShopScope("", { id: "a1", shopId: "shop_1" }),
    ShopScopeError,
  );
});

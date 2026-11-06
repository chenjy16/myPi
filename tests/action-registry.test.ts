import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_ACTION_IDS,
  getAction,
  listActions,
  validateActionParams,
  validateActionTarget,
} from "../app/lib/action-registry.ts";

test("注册表闸口：未知 actionId 抛错；改价/删单永不注册（PRD §8 非目标）", () => {
  assert.throws(() => getAction("order.refund"), /Unknown action id/);
  assert.ok(!KNOWN_ACTION_IDS.includes("order.delete"));
  assert.ok(!KNOWN_ACTION_IDS.includes("product.updatePrice"));
  assert.deepEqual([...KNOWN_ACTION_IDS].sort(), [
    "email.send",
    "product.updateStatus",
    "tags.add",
    "tags.remove",
    "webhook.send",
  ].sort());
});

test("风险派生不自建一套：high 动作 required，low 动作 auto", () => {
  assert.equal(getAction("product.updateStatus").riskLevel, "high");
  assert.equal(getAction("product.updateStatus").confirmation, "required");
  assert.equal(getAction("tags.add").riskLevel, "low");
  assert.equal(getAction("tags.add").confirmation, "auto");
});

test("必填缺失/空串都算缺失；类型校验；枚举越界点名合法值", () => {
  assert.deepEqual(validateActionParams("tags.add", {}), [
    "actions[tags.add]: missing required param: tag",
  ]);
  assert.deepEqual(validateActionParams("tags.add", { tag: "" }), [
    "actions[tags.add]: missing required param: tag",
  ]);
  assert.deepEqual(validateActionParams("tags.add", { tag: 42 }), [
    "actions[tags.add]: param tag must be a string",
  ]);
  assert.deepEqual(validateActionParams("product.updateStatus", { status: "PAUSED" }), [
    "actions[product.updateStatus]: param status must be one of: ACTIVE, DRAFT, ARCHIVED",
  ]);
  assert.deepEqual(validateActionParams("product.updateStatus", { status: "ARCHIVED" }), []);
});

test("stringArray 参数：vars 必须全字符串数组", () => {
  assert.deepEqual(validateActionParams("email.send", { template: "t", vars: ["sku"] }), []);
  assert.deepEqual(validateActionParams("email.send", { template: "t", vars: "sku" }), [
    "actions[email.send]: param vars must be an array of strings",
  ]);
  assert.deepEqual(validateActionParams("email.send", { template: "t", vars: [1] }), [
    "actions[email.send]: param vars must be an array of strings",
  ]);
});

test("未登记参数名一律拒绝：防 DSL 夹带越界字段", () => {
  assert.deepEqual(validateActionParams("tags.add", { tag: "x", shadow: "y" }), [
    "actions[tags.add]: unknown param: shadow",
  ]);
});

test("target 校验：按登记实体大小写无关匹配；无实体动作不设限", () => {
  assert.deepEqual(validateActionTarget("tags.add", "order"), []);
  assert.deepEqual(validateActionTarget("tags.add", "Customer"), []);
  assert.deepEqual(validateActionTarget("tags.add", "inventory"), [
    "actions[tags.add]: target must be one of: order, customer, product",
  ]);
  assert.deepEqual(validateActionTarget("product.updateStatus", "product"), []);
  assert.deepEqual(validateActionTarget("email.send", "anything"), []);
});

test("listActions 与 getAction 同源；每个动作都带幂等说明与错误模板", () => {
  for (const action of listActions()) {
    assert.equal(getAction(action.actionId), action);
    assert.ok(action.idempotency.length > 0, action.actionId);
    assert.ok(action.errorTemplate.includes("{detail}"), action.actionId);
  }
});

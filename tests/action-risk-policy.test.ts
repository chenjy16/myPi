import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWN_ACTION_IDS,
  actionRiskLevel,
  confirmationForAction,
  resolveConfirmation,
} from "../app/lib/action-risk-policy.ts";

/**
 * 风险分级纯逻辑单测（P1-13）：核心是「缺省即 high」——
 * 未登记的 actionId 绝不能被误判成 auto，这是 P6 Safe by Default 的底线。
 */

test("已登记的低风险动作返回 low", () => {
  assert.equal(actionRiskLevel("tags.add"), "low");
  assert.equal(actionRiskLevel("tags.remove"), "low");
  assert.equal(actionRiskLevel("email.send"), "low");
  assert.equal(actionRiskLevel("webhook.send"), "low");
});

test("已登记的高风险动作返回 high", () => {
  assert.equal(actionRiskLevel("product.updateStatus"), "high");
});

test("未登记动作缺省 high，绝不静默放行", () => {
  assert.equal(actionRiskLevel("order.delete"), "high");
  assert.equal(actionRiskLevel(""), "high");
  assert.equal(actionRiskLevel("price.update"), "high");
});

test("风险 → 确认模式：low→auto，high→required", () => {
  assert.equal(resolveConfirmation("low"), "auto");
  assert.equal(resolveConfirmation("high"), "required");
});

test("confirmationForAction 组合派生与单独调用一致", () => {
  assert.equal(confirmationForAction("tags.add"), "auto");
  assert.equal(confirmationForAction("product.updateStatus"), "required");
  assert.equal(confirmationForAction("unknown.action"), "required");
});

test("KNOWN_ACTION_IDS 覆盖首版登记的 5 个动作", () => {
  assert.deepEqual([...KNOWN_ACTION_IDS].sort(), [
    "email.send",
    "product.updateStatus",
    "tags.add",
    "tags.remove",
    "webhook.send",
  ]);
});

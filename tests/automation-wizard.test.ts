import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateTemplateParams,
  describeTemplate,
} from "../app/lib/automation-wizard.ts";
import { buildPlanFromTemplate } from "../app/lib/automations-core.ts";
import { getTemplate } from "../app/lib/template-catalog.ts";

// P3-08 向导测：表单字符串 → 类型化值 → 可编译 DSL（T4）；非法参数被字段级拒绝、不半态。

test("T4 form strings coerce to numbers and compile into a plan", () => {
  const t4 = getTemplate("T4-low-stock")!;
  const result = validateTemplateParams(t4, { threshold: "3", tag: "  restock-me  " });
  assert.equal(result.ok, true);
  assert.equal(result.values.threshold, 3); // number, not string
  const plan = buildPlanFromTemplate(t4, result.values);
  assert.equal(plan.triggerType, "inventory.low");
  assert.equal(plan.actions[0].params.tag, "restock-me"); // trimmed
});

test("amount is parsed as a number for the VIP template", () => {
  const t1 = getTemplate("T1-vip-tag")!;
  const result = validateTemplateParams(t1, { amount: "750", tag: "VIP" });
  assert.equal(result.ok, true);
  assert.equal(result.values.amount, 750);
  const plan = buildPlanFromTemplate(t1, result.values);
  assert.equal(plan.conditions.clauses[0].value, 750);
});

test("required param missing yields a field error, not a half state", () => {
  const t1 = getTemplate("T1-vip-tag")!;
  const result = validateTemplateParams(t1, { amount: "", tag: "VIP" });
  assert.equal(result.ok, false);
  assert.match(result.fieldErrors.amount ?? "", /required/);
  assert.equal(result.values.amount, undefined);
});

test("negative and non-numeric values are rejected", () => {
  const t4 = getTemplate("T4-low-stock")!;
  assert.equal(validateTemplateParams(t4, { threshold: "-2", tag: "x" }).ok, false);
  assert.equal(validateTemplateParams(t4, { threshold: "abc", tag: "x" }).ok, false);
});

test("invalid email is rejected; empty optional email is allowed", () => {
  const t2 = getTemplate("T2-high-value-email")!;
  assert.equal(validateTemplateParams(t2, { amount: "100", template: "hi", recipient: "nope" }).ok, false);
  const ok = validateTemplateParams(t2, { amount: "100", template: "hi", recipient: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.recipient, undefined); // optional blank omitted → template default
});

test("optional blank recipient still produces a compilable plan via defaults", () => {
  const t2 = getTemplate("T2-high-value-email")!;
  const result = validateTemplateParams(t2, { amount: "500", template: "alert", recipient: "" });
  const plan = buildPlanFromTemplate(t2, result.values);
  assert.equal(plan.actions[0].actionId, "email.send");
});

test("describeTemplate gives a merchant-readable headline with no jargon", () => {
  const t1 = getTemplate("T1-vip-tag")!;
  const { headline, steps } = describeTemplate(t1, { amount: 500, tag: "VIP" });
  assert.match(headline, /When an order is paid/);
  assert.match(headline, /order total is at least 500/);
  assert.equal(headline.includes("Mutation"), false);
  assert.equal(headline.includes("GID"), false);
  assert.ok(steps.length >= 1);
});

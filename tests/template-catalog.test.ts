import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_TEMPLATES,
  LAUNCH_TEMPLATES,
  EXTENDED_TEMPLATES,
  defaultParams,
  getTemplate,
  whitelistFor,
} from "../app/lib/template-catalog.ts";
import { validateDefinition } from "../app/lib/automation-dsl.ts";
import { compile } from "../app/lib/automation-compiler.ts";
import { getTrigger } from "../app/lib/trigger-registry.ts";

// P3-05 契约测：模板目录是"数据驱动"的唯一真相，画廊/向导/创建服务都读它。
// 这里锁死四条红线：每个 definitionTemplate 产出的 DSL 既能过 P1-14 校验
// （含 trigger 字段白名单）又能被 P2-18 编译；requiresProtectedData 与注册表一致；
// 首发 5 模板齐全；EXTENDED 不混入首发。

test("every template's default DSL validates against its trigger whitelist and compiles", () => {
  for (const t of ALL_TEMPLATES) {
    const dsl = t.definitionTemplate(defaultParams(t));
    const whitelist = whitelistFor(t.triggerType);
    const result = validateDefinition(dsl, whitelist.size > 0 ? whitelist : undefined);
    assert.equal(
      result.ok,
      true,
      `${t.id}: validateDefinition failed: ${result.errors.join("; ")}`,
    );
    assert.doesNotThrow(
      () => compile(dsl),
      `${t.id}: compile threw`,
    );
  }
});

test("definitionTemplate falls back to defaults when params are empty", () => {
  // 向导"空表单实时预览"依赖：无参也能产出合法可编译 DSL
  for (const t of ALL_TEMPLATES) {
    const dsl = t.definitionTemplate({});
    assert.doesNotThrow(() => compile(dsl), `${t.id}: empty-params compile threw`);
  }
});

test("requiresProtectedData is derived from the trigger registry, never hand-written", () => {
  for (const t of ALL_TEMPLATES) {
    assert.equal(
      t.requiresProtectedData,
      getTrigger(t.triggerType).protectedCustomerData,
      `${t.id}: requiresProtectedData drifts from registry`,
    );
  }
});

test("order/customer triggers are protected; inventory/product/daily are not", () => {
  const protectedMap = Object.fromEntries(
    ALL_TEMPLATES.map((t) => [t.triggerType, t.requiresProtectedData]),
  );
  assert.equal(protectedMap["order.paid"], true);
  assert.equal(protectedMap["order.created"], true);
  assert.equal(protectedMap["order.cancelled"], true);
  assert.equal(protectedMap["customer.created"], true);
  assert.equal(protectedMap["inventory.low"], false);
  assert.equal(protectedMap["product.updated"], false);
  assert.equal(protectedMap["daily.schedule"], false);
});

test("exactly five LAUNCH templates, no duplicates, all resolvable by id", () => {
  assert.equal(LAUNCH_TEMPLATES.length, 5);
  const ids = LAUNCH_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) {
    assert.equal(getTemplate(id)?.tier, "LAUNCH", `${id} should resolve as LAUNCH`);
  }
});

test("EXTENDED templates never leak into the LAUNCH set", () => {
  const launchIds = new Set(LAUNCH_TEMPLATES.map((t) => t.id));
  for (const t of EXTENDED_TEMPLATES) {
    assert.equal(t.tier, "EXTENDED");
    assert.equal(launchIds.has(t.id), false, `${t.id} must not be in LAUNCH`);
  }
});

test("getTemplate returns undefined for unknown ids", () => {
  assert.equal(getTemplate("nope"), undefined);
});

test("T4 low-stock is demoable without a confirmation wall (protected false, tags action)", () => {
  const t4 = getTemplate("T4-low-stock");
  assert.ok(t4);
  assert.equal(t4!.requiresProtectedData, false);
  assert.equal(t4!.triggerType, "inventory.low");
  const plan = compile(t4!.definitionTemplate(defaultParams(t4!)));
  assert.equal(plan.triggerType, "inventory.low");
  assert.ok(plan.actions.some((a) => a.actionId === "tags.add"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPILER_VERSION,
  compile,
  planMatches,
} from "../app/lib/automation-compiler.ts";

// PRD §21.2 委托的三个示例 DSL：编译器必须原样吃下
const highValueVip = {
  dslVersion: "2.0",
  name: "High-value VIP Tagging",
  status: "active",
  trigger: { type: "order.created", source: "shopify.webhook", topic: "orders/create" },
  conditions: { logic: "AND", clauses: [
    { field: "total_price", op: "greater_than_or_equal", value: 300, type: "number" },
  ]},
  actions: [
    { actionId: "tags.add", target: "customer", params: { tags: ["VIP"] } },
    { actionId: "tags.add", target: "order", params: { tags: ["High-Value"] } },
  ],
};

const emailAlert = {
  dslVersion: "2.0",
  name: "High-value Order Alert",
  status: "active",
  trigger: { type: "order.paid", source: "shopify.webhook", topic: "orders/paid" },
  conditions: { logic: "AND", clauses: [
    { field: "total_price", op: "greater_than_or_equal", value: 500, type: "number" },
  ]},
  actions: [
    { actionId: "email.send", params: { to: "{{shop.opsEmail}}", template: "high_value_alert" } },
  ],
};

const lowStock = {
  dslVersion: "2.0",
  name: "Low Stock Emergency",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
  conditions: { logic: "AND", clauses: [
    { field: "available", op: "less_than_or_equal", value: 5, type: "number" },
  ]},
  actions: [
    { actionId: "email.send", params: { to: "{{shop.buyerEmail}}", template: "low_stock", vars: ["sku", "available", "locationName"] } },
  ],
};

test("示例①：tags 数组展开成独立步骤，target 固化，matcherKey 带 topic", () => {
  const plan = compile(highValueVip);
  assert.equal(plan.compiledVersion, COMPILER_VERSION);
  assert.equal(plan.dslVersion, "2.0");
  assert.equal(plan.triggerMatcherKey, "order.created|orders/create");
  assert.deepEqual(plan.conditions.clauses, [
    { field: "total_price", op: "greater_than_or_equal", value: 300, type: "number" },
  ]);
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions[0], {
    actionId: "tags.add",
    target: "customer",
    params: { tag: "VIP" },
    riskLevel: "low",
    confirmation: "auto",
  });
  assert.equal(plan.actions[1].params.tag, "High-Value");
  assert.equal(plan.actions[1].target, "order");
});

test("示例②：邮件动作编译，riskLevel/confirmation 按注册表派生", () => {
  const plan = compile(emailAlert);
  assert.equal(plan.triggerMatcherKey, "order.paid|orders/paid");
  assert.deepEqual(plan.actions[0].params, {
    to: "{{shop.opsEmail}}",
    template: "high_value_alert",
  });
  assert.equal(plan.actions[0].riskLevel, "low");
  assert.equal(plan.actions[0].confirmation, "auto");
});

test("示例③：复合 trigger 源一致、vars 数组过 stringArray 校验", () => {
  const plan = compile(lowStock);
  assert.equal(plan.triggerSource, "shopify.webhook+reconcile");
  assert.equal(plan.triggerMatcherKey, "inventory.low|inventory_levels/update");
  assert.deepEqual(plan.actions[0].params.vars, ["sku", "available", "locationName"]);
});

test("向后兼容：未知顶层/trigger/params 字段忽略不报错", () => {
  const plan = compile({
    ...highValueVip,
    automationId: "auto_x1",
    templateRef: { templateId: "high-value-order-vip", templateVersion: "1.0.0" },
    someFutureField: { x: 1 },
    trigger: { ...highValueVip.trigger, cadence: "daily" },
  });
  assert.equal(plan.triggerType, "order.created");
});

test("风险闸门：high 风险动作的 auto 声明被强制回收为 required", () => {
  const plan = compile({
    dslVersion: "2.0",
    name: "Archive drafty stuff",
    status: "active",
    trigger: { type: "product.updated", source: "shopify.webhook" },
    actions: [
      { actionId: "product.updateStatus", params: { status: "ARCHIVED" }, confirmation: "auto" },
    ],
  });
  assert.equal(plan.actions[0].riskLevel, "high");
  assert.equal(plan.actions[0].confirmation, "required");
});

test("缺省值固化：DSL 未给的可选参数以注册表默认写进计划（回放不查表）", () => {
  const plan = compile({
    dslVersion: "2.0",
    name: "Alert without to",
    status: "active",
    trigger: { type: "product.updated", source: "shopify.webhook" },
    actions: [{ actionId: "email.send", params: { template: "t" } }],
  });
  assert.equal(plan.actions[0].params.to, null);
});

test("非法输入聚合抛错：trigger 越界时直接拦下", () => {
  assert.throws(
    () =>
      compile({
        dslVersion: "2.0",
        name: "broken",
        status: "active",
        trigger: { type: "order.deleted", source: "kafka" },
        actions: [{ actionId: "tags.add", params: { tag: "x" } }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      const flat = err.errors.join("\n");
      assert.match(flat, /not in registry/);
      assert.match(flat, /trigger\.source/);
      return true;
    },
  );
  assert.throws(() => compile("nope"), /definition must be a JSON object|is not an object/);
  assert.throws(() => compile(null), /definition must be a JSON object|is not an object/);
});

test("聚合报错一次列全：白名单外字段 + 未登记动作 + 坏 target", () => {
  assert.throws(
    () =>
      compile({
        ...highValueVip,
        conditions: { logic: "AND", clauses: [{ field: "company", op: "equals", value: "x", type: "string" }] },
        actions: [
          { actionId: "order.refund", params: {} },
          { actionId: "tags.add", target: "inventory", params: { tag: "ok" } },
        ],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      const flat = err.errors.join("\n");
      assert.match(flat, /whitelist/);
      assert.match(flat, /order\.refund/);
      assert.match(flat, /target must be one of/);
      return true;
    },
  );
});

test("动作级越界：未知参数、空 tags、坏 target 都在编译期拒绝", () => {
  assert.throws(
    () =>
      compile({
        ...highValueVip,
        actions: [{ actionId: "tags.add", params: { tag: "x", smuggled: "y" } }],
      }),
  );
  assert.throws(
    () => compile({ ...highValueVip, actions: [{ actionId: "tags.add", params: { tags: [] } }] }),
    (err: unknown) =>
      err instanceof AggregateError && /at least one/.test(err.errors.join("\n")),
  );
  assert.throws(
    () => compile({ ...highValueVip, actions: [{ actionId: "tags.add", target: "inventory", params: { tag: "x" } }] }),
    (err: unknown) =>
      err instanceof AggregateError && /target must be one of/.test(err.errors.join("\n")),
  );
});

test("确定性与回放：同 DSL 两次编译 hash 相同；planMatches 识别内容漂移", () => {
  const p1 = compile(highValueVip);
  const p2 = compile(highValueVip);
  assert.equal(p1.planHash, p2.planHash);
  assert.ok(planMatches(p1, highValueVip));
  assert.ok(!planMatches(p1, {
    ...highValueVip,
    conditions: { logic: "OR", clauses: highValueVip.conditions.clauses },
  }));
  // 冻结产物：运行时计划不可被引擎篡改
  assert.ok(Object.isFrozen(p1));
});

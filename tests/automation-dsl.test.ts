import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateDefinition,
  type ValidationResult,
} from "../app/lib/automation-dsl.ts";

/**
 * DSL 结构校验器单测（P1-14）：重点是「一次性收集全部错误」——
 * UI 要整屏列出所有问题，所以非法输入绝不能 fail-fast 只报第一条。
 */

const validDefinition = {
  dslVersion: "2.0",
  name: "低库存自动打标",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook" },
  actions: [{ actionId: "tags.add", params: { tag: "low-stock" } }],
};

function expectErrors(result: ValidationResult, count?: number): void {
  assert.equal(result.ok, false);
  if (count !== undefined) assert.equal(result.errors.length, count);
}

test("合法定义通过校验且零错误", () => {
  const result = validateDefinition(validDefinition);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("非对象输入直接拒绝（未 parse 的 JSON 也走这里）", () => {
  for (const input of [null, undefined, "string", 42, []]) {
    const result = validateDefinition(input);
    expectErrors(result, 1);
    assert.match(result.errors[0], /must be a JSON object/);
  }
});

test("顶层必填缺失：逐条报出而不是只报第一条", () => {
  const result = validateDefinition({});
  expectErrors(result, 5);
  for (const key of ["dslVersion", "name", "status", "trigger", "actions"]) {
    assert.ok(
      result.errors.some((e) => e.includes(key)),
      `缺少 ${key} 的错误条目`,
    );
  }
});

test("枚举越界：dslVersion / status / trigger.type / trigger.source", () => {
  const result = validateDefinition({
    dslVersion: "1.0",
    name: "x",
    status: "running",
    trigger: { type: "order.deleted", source: "kafka" },
    actions: [{ actionId: "tags.add", params: {} }],
  });
  expectErrors(result, 4);
  assert.ok(result.errors.some((e) => e.startsWith("dslVersion")));
  assert.ok(result.errors.some((e) => e.startsWith("status")));
  assert.ok(result.errors.some((e) => e.includes("trigger.type")));
  assert.ok(result.errors.some((e) => e.includes("trigger.source")));
});

test("webhook+reconcile 是合法触发源（官方允许漏投，需对账）", () => {
  const result = validateDefinition({
    ...validDefinition,
    trigger: { type: "order.created", source: "shopify.webhook+reconcile" },
  });
  assert.equal(result.ok, true);
});

test("actions 空数组非法；每项必须有 actionId 与 params 对象", () => {
  const empty = validateDefinition({ ...validDefinition, actions: [] });
  expectErrors(empty, 1);
  assert.match(empty.errors[0], /at least 1 item/);

  const bad = validateDefinition({
    ...validDefinition,
    actions: [{ params: {} }, { actionId: "tags.add", params: "nope" }],
  });
  expectErrors(bad, 2);
  assert.ok(bad.errors.some((e) => e.includes("actions[0].actionId")));
  assert.ok(bad.errors.some((e) => e.includes("actions[1].params")));
});

test("conditions 可省略；clauses 缺失视作无条件", () => {
  const result = validateDefinition({
    ...validDefinition,
    conditions: { logic: "AND" },
  });
  assert.equal(result.ok, true);
});

test("clause 必填四件套并校验 op/type 枚举", () => {
  const result = validateDefinition({
    ...validDefinition,
    conditions: {
      logic: "XOR",
      clauses: [{ field: "total_price", op: "greater", value: 100 }],
    },
  });
  expectErrors(result, 3);
  assert.ok(result.errors.some((e) => e.includes("conditions.logic")));
  assert.ok(result.errors.some((e) => e.includes("missing required field: type")));
  assert.ok(result.errors.some((e) => e.includes(".op must be one of")));
});

test("布尔类型同时接受 bool 与 boolean，避免口径分歧误拒", () => {
  for (const type of ["bool", "boolean"]) {
    const result = validateDefinition({
      ...validDefinition,
      conditions: {
        clauses: [{ field: "fulfilled", op: "equals", value: true, type }],
      },
    });
    assert.equal(result.ok, true, `type=${type} 应合法`);
  }
});

test("传入白名单时越界字段被点名，界内字段放行", () => {
  const allowed = new Set(["total_price", "customer_tags"]);
  const ok = validateDefinition(
    {
      ...validDefinition,
      conditions: {
        clauses: [
          { field: "total_price", op: "greater_than", value: 100, type: "number" },
        ],
      },
    },
    allowed,
  );
  assert.equal(ok.ok, true);

  const bad = validateDefinition(
    {
      ...validDefinition,
      conditions: {
        clauses: [{ field: "email", op: "equals", value: "a@b.c", type: "string" }],
      },
    },
    allowed,
  );
  expectErrors(bad, 1);
  assert.match(bad.errors[0], /field not in whitelist: email/);
});

test("action 上显式声明的 riskLevel / confirmation 走枚举校验", () => {
  const result = validateDefinition({
    ...validDefinition,
    actions: [
      {
        actionId: "product.updateStatus",
        params: { status: "draft" },
        riskLevel: "medium",
        confirmation: "ask",
      },
    ],
  });
  expectErrors(result, 2);
  assert.ok(result.errors.some((e) => e.includes("riskLevel must be one of")));
  assert.ok(result.errors.some((e) => e.includes("confirmation must be one of")));
});

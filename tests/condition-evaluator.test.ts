import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateConditions,
  fieldValueAt,
  type CompiledConditions,
} from "../app/lib/condition-evaluator.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

const whitelist = new Set(["total_price", "customer_tags"]);

function event(data: Record<string, unknown>): StandardEvent {
  return {
    shopDomain: "s.myshopify.com",
    topic: "orders/create",
    entityType: "Order",
    entityId: "gid://shopify/Order/1",
    occurredAt: new Date("2026-11-05T00:00:00Z"),
    data,
  };
}

test("fieldValueAt：点路径逐段下钻；缺段 undefined 不抛；支持数组数字段", () => {
  const data = { a: { b: { c: 1 } }, tags: ["vip", "x"] };
  assert.equal(fieldValueAt(data, "a.b.c"), 1);
  assert.equal(fieldValueAt(data, "a.b.z"), undefined);
  assert.equal(fieldValueAt(data, "a.missing.deep"), undefined);
  assert.equal(fieldValueAt(data, "tags.0"), "vip");
  assert.equal(fieldValueAt(data, "tags.9"), undefined);
  assert.equal(fieldValueAt(data, ""), undefined); // 空路径落在对象取不到
});

test("无条件（undefined/空 clauses）⇒ result true，明细为空", () => {
  assert.deepEqual(evaluateConditions(undefined, event({}), whitelist), {
    result: true,
    logic: "AND",
    clauses: [],
  });
  const empty: CompiledConditions = { logic: "AND", clauses: [] };
  assert.equal(evaluateConditions(empty, event({}), whitelist).result, true);
});

test("AND 全真才真；OR 一真即真；逐条明细带 actual/pass", () => {
  const conditions: CompiledConditions = {
    logic: "AND",
    clauses: [
      { field: "total_price", op: "greater_than_or_equal", value: 300, type: "number" },
      { field: "customer_tags", op: "contains", value: "vip", type: "array" },
    ],
  };
  const pass = evaluateConditions(conditions, event({ total_price: 500, customer_tags: ["vip"] }), whitelist);
  assert.equal(pass.result, true);
  assert.deepEqual(pass.clauses.map((c) => c.pass), [true, true]);
  assert.equal(pass.clauses[0].actual, 500);

  const fail = evaluateConditions(conditions, event({ total_price: 100, customer_tags: ["vip"] }), whitelist);
  assert.equal(fail.result, false);
  assert.deepEqual(fail.clauses.map((c) => c.pass), [false, true]);

  const or: CompiledConditions = { ...conditions, logic: "OR" };
  assert.equal(evaluateConditions(or, event({ total_price: 100, customer_tags: ["vip"] }), whitelist).result, true);
  assert.equal(evaluateConditions(or, event({ total_price: 100, customer_tags: [] }), whitelist).result, false);
});

test("白名单外字段：不取值、标 invalidField、判 false，整体不误执行", () => {
  const conditions: CompiledConditions = {
    logic: "OR",
    clauses: [
      { field: "email", op: "contains", value: "a@b.com", type: "string" },
      { field: "total_price", op: "greater_than", value: 1, type: "number" },
    ],
  };
  const result = evaluateConditions(conditions, event({ email: "a@b.com", total_price: 100 }), whitelist);
  const bad = result.clauses[0];
  assert.equal(bad.invalidField, true);
  assert.equal(bad.actual, undefined); // 越界字段连值都不透传（不进日志/不回显）
  assert.equal(bad.pass, false);
  assert.equal(result.result, true); // OR 由合法条款命中
  const and: CompiledConditions = { logic: "AND", clauses: [conditions.clauses[0]] };
  assert.equal(evaluateConditions(and, event({ email: "a@b.com" }), whitelist).result, false);
});

test("确定性：同一事件+同一编译结果重复求值输出全等（P2 铁律）", () => {
  const conditions: CompiledConditions = {
    logic: "AND",
    clauses: [{ field: "total_price", op: "equals", value: "300", type: "number" }],
  };
  const e = event({ total_price: 300 });
  assert.deepEqual(
    evaluateConditions(conditions, e, whitelist),
    evaluateConditions(conditions, e, whitelist),
  );
});

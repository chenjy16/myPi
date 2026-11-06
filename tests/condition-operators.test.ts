import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPERATOR_NAMES,
  evaluateOperator,
} from "../app/lib/condition-operators.ts";

test("运算符清单齐全 12 个", () => {
  assert.equal(OPERATOR_NAMES.length, 12);
});

test("null 铁律：缺失字段除空判定外一律 false（PRD §19）", () => {
  for (const op of ["equals", "not_equals", "greater_than", "in", "contains"] as const)
    assert.equal(evaluateOperator(op, null, 100, "number"), false, op);
  assert.equal(evaluateOperator("is_empty", null, undefined, "string"), true);
  assert.equal(evaluateOperator("is_empty", "x", undefined, "string"), false);
  assert.equal(evaluateOperator("is_not_empty", "", undefined, "string"), false);
  assert.equal(evaluateOperator("is_empty", [], undefined, "array"), true);
});

test("equals：数值宽松匹配字符串金额；布尔严格；类型不匹配不抛只 false", () => {
  assert.equal(evaluateOperator("equals", 300, "300", "number"), true);
  assert.equal(evaluateOperator("equals", 300, 300, "number"), true);
  assert.equal(evaluateOperator("equals", "vip", "VIP", "string"), false); // 大小写敏感
  assert.equal(evaluateOperator("equals", true, true, "boolean"), true);
  assert.equal(evaluateOperator("equals", true, "true", "boolean"), false);
  assert.equal(evaluateOperator("equals", NaN, NaN, "number"), false);
});

test("序比较只在 number/date 上有语义；string 上一律 false", () => {
  assert.equal(evaluateOperator("greater_than", 301, 300, "number"), true);
  assert.equal(evaluateOperator("greater_than", 300, 300, "number"), false);
  assert.equal(evaluateOperator("greater_than_or_equal", 300, 300, "number"), true);
  assert.equal(evaluateOperator("less_than", "9", "10", "number"), true); // 字符串数字化后比较
  assert.equal(evaluateOperator("greater_than", "b", "a", "string"), false);
  assert.equal(evaluateOperator("less_than", null, 5, "number"), false);
});

test("date 按绝对时间戳比较，时区偏移参与换算", () => {
  const utc = "2026-11-05T00:00:00Z";
  const later = "2026-11-05T08:00:00+08:00"; // 同一时刻（= 00:00Z）
  const after = "2026-11-06T00:00:00Z";
  assert.equal(evaluateOperator("equals", utc, later, "date"), true);
  assert.equal(evaluateOperator("greater_than", after, utc, "date"), true);
  assert.equal(evaluateOperator("less_than", after, utc, "date"), false);
  // 非 ISO 形状不猜测：判 false 而非抛
  assert.equal(evaluateOperator("greater_than", "11/05/2026", utc, "date"), false);
});

test("contains：数组逐项宽松命中；字符串子串；其余形状 false", () => {
  assert.equal(evaluateOperator("contains", ["vip", "wholesale"], "vip", "array"), true);
  assert.equal(evaluateOperator("contains", ["1", 2], 2, "array"), true); // loose
  assert.equal(evaluateOperator("contains", "high-value order", "value", "string"), true);
  assert.equal(evaluateOperator("contains", 42, "4", "number"), false);
  assert.equal(evaluateOperator("not_contains", ["vip"], "retail", "array"), true);
  assert.equal(evaluateOperator("not_contains", "", "x", "string"), true); // 空串什么都不含
});

test("in / not_in：expected 必须是集合；actual 数组取任一元素", () => {
  assert.equal(evaluateOperator("in", "vip", ["vip", "gold"], "string"), true);
  assert.equal(evaluateOperator("in", "silver", ["vip", "gold"], "string"), false);
  assert.equal(evaluateOperator("in", ["a", "x"], ["vip", "a"], "array"), true);
  assert.equal(evaluateOperator("in", "vip", "vip", "string"), false); // 非集合 expected
  assert.equal(evaluateOperator("not_in", "silver", ["vip"], "string"), true);
  assert.equal(evaluateOperator("not_in", "vip", ["vip"], "string"), false);
});

test("not_equals 与 equals 严格互补（含数组整体比较）", () => {
  assert.equal(evaluateOperator("not_equals", ["a"], ["a", "b"], "array"), true);
  assert.equal(evaluateOperator("equals", ["a", "b"], ["a", "b"], "array"), true);
  assert.equal(evaluateOperator("equals", ["a", "b"], ["b", "a"], "array"), false); // 顺序敏感
});

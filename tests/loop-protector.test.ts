import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_TAG_PREFIX,
  DEFAULT_MAX_CASCADE_DEPTH,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_COUNT,
  checkLoopProtection,
  eventFingerprint,
  hasAutoSourceTag,
  parseLoopConfig,
  type LoopCheckInput,
} from "../app/lib/loop-protector.ts";

const base: LoopCheckInput = {
  automationId: "auto_1",
  entityType: "Order",
  entityId: "gid://shopify/Order/1",
  keyFields: { total_price: 500 },
  cascadeDepth: 0,
  duplicateCountInWindow: 0,
  executionsInWindow: 0,
};

test("指纹确定性：键序无关、同窗同指纹、跨窗新指纹", () => {
  const now = new Date("2026-11-05T10:00:30Z");
  const a = eventFingerprint({ ...base, now });
  const b = eventFingerprint({
    ...base,
    now: new Date("2026-11-05T10:00:50Z"), // 同属 10:00:00–10:00:59 窗格
    keyFields: { total_price: 500 }, // 键集相同
  });
  assert.equal(a, b);
  const c = eventFingerprint({
    ...base,
    now,
    keyFields: { currency: "USD", total_price: 500 },
  });
  const d = eventFingerprint({
    ...base,
    now,
    keyFields: { total_price: 500, currency: "USD" },
  });
  assert.equal(c, d); // stableStringify 排序保证键序无关
  const changed = eventFingerprint({ ...base, now, keyFields: { total_price: 501 } });
  assert.notEqual(a, changed);
  const nextWindow = eventFingerprint({ ...base, now: new Date("2026-11-05T10:02:00Z") });
  assert.notEqual(a, nextWindow); // 60s 窗外自动新指纹
});

test("干净事件放行", () => {
  assert.deepEqual(checkLoopProtection(base), { decision: "allow" });
});

test("级联深度超限 → block（默认 maxDepth=3，depth>3 掐断）", () => {
  assert.equal(DEFAULT_MAX_CASCADE_DEPTH, 3);
  const v = checkLoopProtection({ ...base, cascadeDepth: 4 });
  assert.equal(v.decision, "block");
  assert.match(v.reason ?? "", /cascade depth 4/);
  assert.equal(checkLoopProtection({ ...base, cascadeDepth: 3 }).decision, "allow");
});

test("同指纹窗内重复 → block", () => {
  const v = checkLoopProtection({ ...base, duplicateCountInWindow: 1 });
  assert.equal(v.decision, "block");
  assert.match(v.reason ?? "", /duplicate event fingerprint/);
});

test("计划 tag 已挂且带 auto: 来源 → block；仅 auto: 来源 → throttle", () => {
  const looped = checkLoopProtection({
    ...base,
    plannedTag: "auto:vip",
    eventTags: ["auto:vip", "other"],
  });
  assert.equal(looped.decision, "block");
  assert.match(looped.reason ?? "", /already present/);

  const suspected = checkLoopProtection({ ...base, eventTags: ["auto:high-value"] });
  assert.equal(suspected.decision, "throttle");
  assert.match(suspected.reason ?? "", /self-trigger/);

  // plannedTag 存在但不在事件上、也无 auto: 标记 → 不影响放行
  assert.equal(
    checkLoopProtection({ ...base, plannedTag: "auto:new", eventTags: ["vip"] }).decision,
    "allow",
  );
});

test("限次：同实体窗内执行数达上限 → throttle，窗内计数未达上限放行", () => {
  assert.equal(checkLoopProtection({ ...base, executionsInWindow: 4 }).decision, "allow");
  const v = checkLoopProtection({ ...base, executionsInWindow: 5 });
  assert.equal(v.decision, "throttle");
  assert.match(v.reason ?? "", /rate limit/);
  const tightened = checkLoopProtection({ ...base, executionsInWindow: 1, rateLimitCount: 1 });
  assert.equal(tightened.decision, "throttle");
});

test("auto: 前缀识别大小写无关（Shopify tag 存储可能变形）", () => {
  assert.equal(hasAutoSourceTag(["AUTO:vip"]), true);
  assert.equal(hasAutoSourceTag(["vip"]), false);
  assert.equal(hasAutoSourceTag(undefined), false);
  assert.ok(AUTO_TAG_PREFIX === "auto:");
});

test("裁决优先级：深度超限优先于限次（block 压过 throttle）", () => {
  const v = checkLoopProtection({ ...base, cascadeDepth: 9, executionsInWindow: 99 });
  assert.equal(v.decision, "block");
});

test("parseLoopConfig：缺省回退安全默认，非法值不产生 NaN", () => {
  assert.deepEqual(parseLoopConfig({}), {
    maxCascadeDepth: DEFAULT_MAX_CASCADE_DEPTH,
    dedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
    rateLimitWindowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    rateLimitCount: DEFAULT_RATE_LIMIT_COUNT,
  });
  // 非法 / 非正数一律回退默认
  assert.equal(parseLoopConfig({ LOOP_MAX_CASCADE_DEPTH: "abc" }).maxCascadeDepth, DEFAULT_MAX_CASCADE_DEPTH);
  assert.equal(parseLoopConfig({ LOOP_MAX_CASCADE_DEPTH: "0" }).maxCascadeDepth, DEFAULT_MAX_CASCADE_DEPTH);
  assert.equal(parseLoopConfig({ LOOP_MAX_CASCADE_DEPTH: "-2" }).maxCascadeDepth, DEFAULT_MAX_CASCADE_DEPTH);
});

test("parseLoopConfig：合法值生效且受上界护栏钳制", () => {
  assert.equal(parseLoopConfig({ LOOP_MAX_CASCADE_DEPTH: "6" }).maxCascadeDepth, 6);
  assert.equal(parseLoopConfig({ LOOP_DEDUP_WINDOW_MS: "120000" }).dedupWindowMs, 120_000);
  assert.equal(parseLoopConfig({ LOOP_RATE_LIMIT_COUNT: "10" }).rateLimitCount, 10);
  // 越界钳到上界：深度≤10、窗≤1h、次数≤100
  assert.equal(parseLoopConfig({ LOOP_MAX_CASCADE_DEPTH: "99" }).maxCascadeDepth, 10);
  assert.equal(parseLoopConfig({ LOOP_DEDUP_WINDOW_MS: "99999999" }).dedupWindowMs, 3_600_000);
  assert.equal(parseLoopConfig({ LOOP_RATE_LIMIT_COUNT: "1000" }).rateLimitCount, 100);
});

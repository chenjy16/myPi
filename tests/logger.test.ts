import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  formatLogEntry,
  newRequestId,
  isSensitiveKey,
  redactContext,
  REDACTED_PLACEHOLDER,
} from "../app/lib/logger.ts";

test("formatLogEntry emits stable ts/level/msg then context", () => {
  const line = formatLogEntry({
    level: "info",
    message: "hello",
    context: { shop: "a.myshopify.com", requestId: "r-1" },
    time: new Date("2026-11-03T00:00:00.000Z"),
  });
  const parsed = JSON.parse(line);
  assert.deepEqual(parsed, {
    ts: "2026-11-03T00:00:00.000Z",
    level: "info",
    msg: "hello",
    shop: "a.myshopify.com",
    requestId: "r-1",
  });
});

test("formatLogEntry folds an Error context value into name/message", () => {
  const line = formatLogEntry({
    level: "error",
    message: "boom",
    context: { error: new Error("kaboom") },
    time: new Date("2026-11-03T00:00:00.000Z"),
  });
  assert.deepEqual(JSON.parse(line).error, { name: "Error", message: "kaboom" });
});

test("formatLogEntry never lets context overwrite reserved keys", () => {
  const line = formatLogEntry({
    level: "warn",
    message: "m",
    context: { ts: "spoof", level: "spoof", msg: "spoof", keep: 1 },
    time: new Date("2026-11-03T01:02:03.000Z"),
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.ts, "2026-11-03T01:02:03.000Z");
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.msg, "m");
  assert.equal(parsed.keep, 1);
});

test("createLogger child merges base context and call context", () => {
  const captured: string[] = [];
  const original = console.log;
  console.log = (s: unknown) => captured.push(String(s));
  try {
    createLogger({ shop: "s" }).child({ requestId: "r" }).info("tick");
  } finally {
    console.log = original;
  }
  const parsed = JSON.parse(captured[0]);
  assert.equal(parsed.shop, "s");
  assert.equal(parsed.requestId, "r");
  assert.equal(parsed.msg, "tick");
});

test("newRequestId reuses a valid incoming id, otherwise generates a uuid", () => {
  assert.equal(newRequestId("  abc  "), "abc");
  assert.match(newRequestId(null), /[0-9a-f-]{36}/);
});

// —— P4-11：键名黑名单兜底脱敏 ——

test("isSensitiveKey：大小写/驼峰/下划线变体都命中，普通键不误伤", () => {
  for (const key of [
    "secret",
    "SHOPIFY_API_SECRET",
    "accessToken",
    "authorization",
    "api_key",
    "apiKey",
    "password",
    "client_credentials",
    "secretsEncrypted",
    "customerEmail",
    "phone_number",
  ])
    assert.ok(isSensitiveKey(key), `${key} 应命中黑名单`);
  for (const key of ["shop", "requestId", "topic", "count", "detail", "toneMatte"]) {
    assert.ok(!isSensitiveKey(key), `${key} 不应误伤`);
  }
});

test("redactContext：嵌套/数组里的敏感键连子树折成占位串，不改入参", () => {
  const input = {
    shop: "a.myshopify.com",
    integration: { name: "erp", secretsEncrypted: "iv.tag.cipher", url: "https://x" },
    rows: [{ email: "a@b.c", sku: "S-1" }, { phoneNumber: "13800000000", sku: "S-2" }],
  };
  const frozen = structuredClone(input);
  const out = redactContext(input);
  assert.deepEqual(out, {
    shop: "a.myshopify.com",
    integration: { name: "erp", secretsEncrypted: REDACTED_PLACEHOLDER, url: "https://x" },
    rows: [{ email: REDACTED_PLACEHOLDER, sku: "S-1" }, { phoneNumber: REDACTED_PLACEHOLDER, sku: "S-2" }],
  });
  assert.deepEqual(input, frozen, "纯函数：绝不原地改入参");
});

test("formatLogEntry：敏感上下文落盘前已折，Error 仍保持 name/message 形状", () => {
  const line = formatLogEntry({
    level: "error",
    message: "sync failed",
    context: {
      token: "shpat_supersecret",
      error: Object.assign(new Error("upstream 401"), { apiKey: "leak" }),
      attempt: 2,
    },
    time: new Date("2026-11-03T00:00:00.000Z"),
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.token, REDACTED_PLACEHOLDER);
  assert.equal(parsed.attempt, 2);
  assert.equal(parsed.error.message, "upstream 401", "Error 先 normalize 再折敏，形状不丢");
  assert.ok(!("apiKey" in parsed.error), "Error 附带字段本就不落盘，泄露面为零");
  assert.ok(!line.includes("supersecret") && !line.includes("leak"));
});

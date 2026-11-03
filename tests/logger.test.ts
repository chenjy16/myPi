import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  formatLogEntry,
  newRequestId,
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

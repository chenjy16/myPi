import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_ATTEMPTS,
  backoffCapMs,
  backoffDelayMs,
  decideRetry,
  isRetryableKind,
  maxAttempts,
} from "../app/lib/retry-policy.ts";

test("只有 shopify_api 可重试；validation/auth/unknown 直接死信", () => {
  assert.equal(isRetryableKind("shopify_api"), true);
  for (const kind of ["validation", "auth", "unknown"] as const) {
    assert.equal(isRetryableKind(kind), false, kind);
    assert.deepEqual(decideRetry(kind, 1), { action: "dead_letter", reason: "not_retryable" });
  }
});

test("指数退避序列：500/1000/2000…封顶 5s，抖动放大后仍不越帽", () => {
  assert.equal(backoffDelayMs(1), 500);
  assert.equal(backoffDelayMs(2), 1000);
  assert.equal(backoffDelayMs(3), 2000);
  assert.equal(backoffDelayMs(5), 5000); // 8000 → 封顶
  assert.equal(backoffDelayMs(10), 5000);
  assert.equal(backoffDelayMs(1, 1), 1000); // 满抖动 ×2
  assert.equal(backoffDelayMs(4, 1), 5000); // 4000×2=8000 仍被帽住
  assert.equal(backoffDelayMs(2, -5), 1000); // 抖动入参钳到 0..1
});

test("超限死信：attemptsDone 达 maxAttempts 后不再重投", () => {
  assert.equal(maxAttempts(), DEFAULT_MAX_ATTEMPTS);
  assert.deepEqual(decideRetry("shopify_api", 3), {
    action: "dead_letter",
    reason: "attempts_exhausted",
  });
  const d = decideRetry("shopify_api", 2, 0);
  assert.equal(d.action, "retry");
  if (d.action === "retry") {
    assert.equal(d.attempt, 3);
    assert.equal(d.delayMs, 1000); // 第 2 次失败后等 base×2^(2-1)=1000ms
  }
});

test("env 覆盖：非法值回落默认、上限钳制（10 次 / 30s）", () => {
  const original = { ...process.env };
  try {
    process.env.EXECUTION_MAX_ATTEMPTS = "0";
    assert.equal(maxAttempts(), DEFAULT_MAX_ATTEMPTS);
    process.env.EXECUTION_MAX_ATTEMPTS = "abc";
    assert.equal(maxAttempts(), DEFAULT_MAX_ATTEMPTS);
    process.env.EXECUTION_MAX_ATTEMPTS = "999";
    assert.equal(maxAttempts(), 10);
    process.env.EXECUTION_BACKOFF_CAP_MS = "-1";
    assert.equal(backoffCapMs(), 5000);
    process.env.EXECUTION_BACKOFF_CAP_MS = "60000";
    assert.equal(backoffCapMs(), 30000);
    assert.equal(backoffDelayMs(1), 500); // 帽提升不改变起始退避：base 500 照旧
    assert.equal(backoffDelayMs(8), 30000); // 12800 仍撞在 30s 新帽上
  } finally {
    process.env = original;
  }
});

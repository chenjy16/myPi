import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_THROTTLE_WAIT_MS,
  classifyThrownDetail,
  isAccessError,
  isThrottlingError,
  isUnitCostAccessError,
  resolveTries,
  throttleWaitMs,
} from "../app/lib/shopify-throttle.ts";

test("resolveTries falls back and clamps to what the client supports", () => {
  assert.equal(resolveTries(undefined), 3); // default
  assert.equal(resolveTries("abc"), 3); // non-numeric -> default
  assert.equal(resolveTries("0"), 1); // clamped up, never below 1 (client throws on retries<0)
  assert.equal(resolveTries(""), 1); // Number("") is 0 -> clamped up to the floor of 1
  assert.equal(resolveTries("2"), 2);
  assert.equal(resolveTries("9"), 4); // capped at library max
});

test("throttleWaitMs paces only genuinely throttled responses, bounded", () => {
  assert.equal(throttleWaitMs(null), 0);
  assert.equal(throttleWaitMs(undefined), 0);
  // A successful response can carry a predicted nextWaitEstimate; that is NOT a must-wait.
  assert.equal(throttleWaitMs({ throttled: false, nextWaitEstimate: 4000 }), 0);
  // Genuinely throttled -> respect Shopify's dynamic estimate.
  assert.equal(throttleWaitMs({ throttled: true, nextWaitEstimate: 1200 }), 1200);
  // Bound the wait so a huge estimate can never hang a worker loop.
  assert.equal(
    throttleWaitMs({ throttled: true, nextWaitEstimate: 999_999 }),
    MAX_THROTTLE_WAIT_MS,
  );
  // Missing/invalid estimate -> no fabricated wait.
  assert.equal(throttleWaitMs({ throttled: true }), 0);
  assert.equal(throttleWaitMs({ throttled: true, nextWaitEstimate: -5 }), 0);
});

test("throttling errors are recognized by code and message", () => {
  assert.equal(isThrottlingError({ message: "x", extensions: { code: "THROTTLED" } }), true);
  assert.equal(isThrottlingError({ message: "Exceeded rate limit of 429" }), true);
  assert.equal(isThrottlingError({ message: "query complexity bucket empty" }), true);
  assert.equal(isThrottlingError({ message: "Field 'foo' doesn't exist on type Bar" }), false);
});

test("access errors are separated from throttling", () => {
  assert.equal(isAccessError({ message: "Missing access, requires read_products scope" }), true);
  assert.equal(isAccessError({ message: "Shop is not authorized" }), true);
  assert.equal(isAccessError({ message: "THROTTLED" }), false);
});

test("unit cost access errors are downgradeable, not fatal", () => {
  assert.equal(isUnitCostAccessError({ message: "x", path: ["productVariants", "unitCost"] }), true);
  assert.equal(isUnitCostAccessError({ message: "Missing access to product costs" }), true);
  assert.equal(isUnitCostAccessError({ message: "some other failure" }), false);
});

test("classifyThrownDetail splits retry-exhaustion, auth and generic api", () => {
  assert.equal(classifyThrownDetail("Attempted maximum number of 3 network retries"), "retry_exhausted");
  assert.equal(classifyThrownDetail("HttpSessionNotFoundError: session expired"), "auth");
  assert.equal(classifyThrownDetail("fetch failed: connect ETIMEDOUT"), "api");
});

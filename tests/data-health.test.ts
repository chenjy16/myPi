import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateDataHealth,
  type DataHealthInput,
} from "../app/lib/data-health.ts";

const NOW = new Date("2026-11-01T12:00:00Z");

/** 一套全部通过的店铺事实，用例只改自己要验证的那一项。 */
function facts(overrides: Partial<DataHealthInput> = {}): DataHealthInput {
  return {
    hasOfflineSession: true,
    locationName: "Main Warehouse",
    snapshotCapturedAt: new Date("2026-11-01T10:00:00Z"),
    newestSnapshotDate: "2026-11-01",
    trackedVariantCount: 12,
    lastInventorySyncAt: new Date("2026-11-01T10:00:00Z"),
    lastSalesSyncAt: new Date("2026-11-01T10:00:00Z"),
    salesHistoryComplete: true,
    consecutiveFailures: 0,
    costCoverage: 1,
    today: "2026-11-01",
    now: NOW,
    ...overrides,
  };
}

function toneOf(state: ReturnType<typeof evaluateDataHealth>, key: string) {
  const check = state.checks.find((item) => item.key === key);
  assert.ok(check, `expected a ${key} check`);
  return check;
}

test("a fully readable store passes every check", () => {
  const result = evaluateDataHealth(facts());
  assert.equal(result.state, "healthy");
  assert.equal(result.paused, false);
  assert.deepEqual(result.pauseReasons, []);
  assert.equal(result.checks.length, 6);
  assert.ok(result.checks.every((check) => check.tone === "ok"));
});

test("a stale snapshot pauses decisions and reports its age", () => {
  const result = evaluateDataHealth(
    facts({
      snapshotCapturedAt: new Date("2026-10-30T01:00:00Z"),
      newestSnapshotDate: "2026-10-30",
    }),
  );
  const snapshot = toneOf(result, "inventory_snapshot");
  assert.equal(snapshot.tone, "critical");
  assert.equal(snapshot.blocksRecommendations, true);
  assert.equal(result.paused, true);
  assert.equal(result.state, "paused");
  assert.ok(result.snapshotAgeHours !== null && result.snapshotAgeHours > 48);
  assert.match(result.pauseReasons.join(" "), /Inventory snapshot/);
});

test("yesterday's snapshot inside the freshness window only warns", () => {
  const result = evaluateDataHealth(
    facts({
      snapshotCapturedAt: new Date("2026-10-31T16:00:00Z"),
      newestSnapshotDate: "2026-10-31",
    }),
  );
  assert.equal(toneOf(result, "inventory_snapshot").tone, "warn");
  assert.equal(result.paused, false);
  assert.equal(result.state, "degraded");
});

test("no snapshot and no location both block", () => {
  const noSnapshot = evaluateDataHealth(
    facts({
      snapshotCapturedAt: null,
      newestSnapshotDate: null,
      trackedVariantCount: 0,
    }),
  );
  assert.equal(toneOf(noSnapshot, "inventory_snapshot").tone, "critical");
  assert.equal(noSnapshot.paused, true);
  assert.equal(noSnapshot.snapshotAgeHours, null);

  const noLocation = evaluateDataHealth(facts({ locationName: null }));
  assert.equal(toneOf(noLocation, "primary_location").tone, "critical");
  assert.equal(noLocation.paused, true);
});

test("a lost background session blocks every read", () => {
  const result = evaluateDataHealth(facts({ hasOfflineSession: false }));
  assert.equal(toneOf(result, "authorization").tone, "critical");
  assert.equal(result.paused, true);
});

test("one failed sync warns and only a streak blocks", () => {
  const once = evaluateDataHealth(facts({ consecutiveFailures: 1 }));
  assert.equal(toneOf(once, "sync_failures").tone, "warn");
  assert.equal(once.paused, false);

  const twice = evaluateDataHealth(facts({ consecutiveFailures: 2 }));
  assert.equal(toneOf(twice, "sync_failures").tone, "critical");
  assert.equal(twice.paused, true);
});

test("60-day-only history lowers confidence but never pauses advice", () => {
  const result = evaluateDataHealth(facts({ salesHistoryComplete: false }));
  const sales = toneOf(result, "sales_history");
  assert.equal(sales.tone, "warn");
  assert.equal(sales.blocksRecommendations, false);
  assert.equal(result.paused, false);
});

test("unread sales history blocks because demand would be empty", () => {
  const result = evaluateDataHealth(facts({ lastSalesSyncAt: null }));
  assert.equal(toneOf(result, "sales_history").tone, "critical");
  assert.equal(result.paused, true);
});

test("partial product costs stay a disclosure, not a pause", () => {
  const partial = evaluateDataHealth(facts({ costCoverage: 0.5 }));
  const costs = toneOf(partial, "product_cost");
  assert.equal(costs.tone, "warn");
  assert.equal(costs.blocksRecommendations, false);
  assert.match(costs.detail, /50%/);
  assert.equal(partial.paused, false);

  const unknown = evaluateDataHealth(facts({ costCoverage: null }));
  assert.match(toneOf(unknown, "product_cost").detail, /haven't been read/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SNAPSHOT_STALE_HOURS,
  calculateReorderConfidence,
  isReorderConfidenceLevel,
} from "../app/lib/reorder-confidence.ts";
import type { ObservedDemand } from "../app/lib/inventory-calculations.ts";

/** 一条「数据都干净」的观测需求，各用例只改自己要验证的那一项。 */
function demand(overrides: Partial<ObservedDemand> = {}): ObservedDemand {
  return {
    windowDays: 30,
    sampleDaysAvailable: 30,
    quantity: 90,
    perDay: 3,
    daysWithSales: 20,
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return calculateReorderConfidence({
    snapshotAgeHours: 2,
    observedDemand: demand(),
    historyDaysAvailable: 90,
    unitCostMissing: false,
    dataPaused: false,
    ...overrides,
  });
}

test("complete data yields high confidence with nothing to disclose", () => {
  const result = review();
  assert.equal(result.level, "high");
  assert.deepEqual(result.reasons, []);
});

test("a hard data problem drops to low and is listed first", () => {
  const result = review({
    snapshotAgeHours: SNAPSHOT_STALE_HOURS + 6,
    historyDaysAvailable: 60,
  });
  assert.equal(result.level, "low");
  assert.equal(result.reasons[0].code, "snapshot_stale");
  assert.equal(result.reasons[0].tone, "hard");
  // hard 排在 soft 前面，商家第一眼看到的就是最致命的那条。
  assert.equal(result.reasons[1].tone, "soft");
});

test("no snapshot at all is a hard reason, not a soft one", () => {
  const result = review({ snapshotAgeHours: null });
  assert.equal(result.level, "low");
  assert.equal(result.reasons[0].code, "no_snapshot");
});

test("paused data is a hard reason", () => {
  const result = review({ dataPaused: true });
  assert.equal(result.level, "low");
  assert.equal(result.reasons[0].code, "data_paused");
});

test("an empty visible sample can't support a daily rate", () => {
  const result = review({
    observedDemand: demand({
      sampleDaysAvailable: 0,
      quantity: 0,
      perDay: 0,
      daysWithSales: 0,
    }),
  });
  assert.equal(result.level, "low");
  assert.ok(result.reasons.some((reason) => reason.code === "no_visible_days"));
});

test("one soft issue means medium, two mean low", () => {
  const oneSoft = review({ historyDaysAvailable: 60 });
  assert.equal(oneSoft.level, "medium");
  assert.deepEqual(
    oneSoft.reasons.map((reason) => reason.code),
    ["history_60d_only"],
  );

  const twoSoft = review({
    historyDaysAvailable: 60,
    observedDemand: demand({ sampleDaysAvailable: 20 }),
  });
  assert.equal(twoSoft.level, "low");
  assert.equal(
    twoSoft.reasons.filter((reason) => reason.tone === "soft").length,
    2,
  );
});

test("irregular sales are disclosed as a soft reason", () => {
  const result = review({ observedDemand: demand({ daysWithSales: 3 }) });
  assert.equal(result.level, "medium");
  assert.equal(result.reasons[0].code, "sparse_sales");
});

test("unreadable product cost is disclosed without lowering the level", () => {
  const result = review({ unitCostMissing: true });
  // 成本只影响库存价值估算，不该把补货量本身打成一档低的。
  assert.equal(result.level, "high");
  assert.deepEqual(
    result.reasons.map((reason) => [reason.code, reason.tone]),
    [["cost_unavailable", "info"]],
  );
});

test("only the three supported confidence levels are accepted", () => {
  assert.equal(isReorderConfidenceLevel("high"), true);
  assert.equal(isReorderConfidenceLevel("medium"), true);
  assert.equal(isReorderConfidenceLevel("low"), true);
  assert.equal(isReorderConfidenceLevel("strong"), false);
  assert.equal(isReorderConfidenceLevel("pending"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REPLENISHMENT_SETTINGS,
  REPLENISHMENT_LIMITS,
  hasReplenishmentChange,
  toReplenishmentSettingsError,
  validateReplenishmentSettings,
} from "../app/lib/settings-validation.ts";

const VALID = {
  leadTimeDays: "21",
  safetyStockDays: "5",
  reviewPeriodDays: "7",
};

test("valid whole-number days pass and come back as numbers", () => {
  const result = validateReplenishmentSettings(VALID);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    leadTimeDays: 21,
    safetyStockDays: 5,
    reviewPeriodDays: 7,
  });
  assert.deepEqual(result.errors, {});
});

test("defaults match the schema @default(14 / 7 / 14) the DB ships with", () => {
  assert.deepEqual(DEFAULT_REPLENISHMENT_SETTINGS, {
    leadTimeDays: 14,
    safetyStockDays: 7,
    reviewPeriodDays: 14,
  });
  // 默认值必须落在各自校验区间内，否则新装店铺会被自己的设置页判成非法。
  for (const [field, value] of Object.entries(DEFAULT_REPLENISHMENT_SETTINGS)) {
    const key = field as keyof typeof REPLENISHMENT_LIMITS;
    assert.ok(
      value >= REPLENISHMENT_LIMITS[key].min &&
        value <= REPLENISHMENT_LIMITS[key].max,
      field,
    );
  }
});

test("non-integer and non-numeric inputs are rejected per field", () => {
  for (const bad of ["14.5", "1e3", "abc", "", "  ", "-"]) {
    const result = validateReplenishmentSettings({
      ...VALID,
      leadTimeDays: bad,
    });
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.match(result.errors.leadTimeDays ?? "", /whole number/);
    assert.equal(result.errors.safetyStockDays, undefined);
  }
});

test("out-of-range values report the allowed bounds", () => {
  const tooLong = validateReplenishmentSettings({ ...VALID, leadTimeDays: "999" });
  assert.equal(tooLong.ok, false);
  assert.match(
    tooLong.errors.leadTimeDays ?? "",
    /between 0 and 180 days/,
  );

  // reviewPeriodDays 下界是 1：零周期会让建议永远停在同一天。
  const zeroReview = validateReplenishmentSettings({ ...VALID, reviewPeriodDays: "0" });
  assert.equal(zeroReview.ok, false);
  assert.match(
    zeroReview.errors.reviewPeriodDays ?? "",
    /between 1 and 90 days/,
  );

  // lead time / safety 允许 0（现货直发没有交期）。
  const zeroLead = validateReplenishmentSettings({
    ...VALID,
    leadTimeDays: "0",
    safetyStockDays: "0",
  });
  assert.equal(zeroLead.ok, true);
});

test("all three fields report together so the UI can place every message", () => {
  const result = validateReplenishmentSettings({
    leadTimeDays: "x",
    safetyStockDays: "-1",
    reviewPeriodDays: "999",
  });
  assert.equal(result.ok, false);
  assert.equal(Object.keys(result.errors).length, 3);
});

test("thrown form folds into an actionable validation AppError", () => {
  const result = validateReplenishmentSettings({ ...VALID, leadTimeDays: "999" });
  assert.equal(result.ok, false);
  if (result.ok) return assert.fail("expected invalid");
  const error = toReplenishmentSettingsError(result);
  assert.equal(error.kind, "validation");
  assert.match(error.message, /Lead time must be between 0 and 180 days\./);
});

test("change detection ignores string-vs-number typing but catches real edits", () => {
  const current = { leadTimeDays: 14, safetyStockDays: 7, reviewPeriodDays: 14 };
  const saved = validateReplenishmentSettings({
    leadTimeDays: "14",
    safetyStockDays: "7",
    reviewPeriodDays: "14",
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(hasReplenishmentChange(current, saved.value), false);
  }
  assert.equal(
    hasReplenishmentChange(current, { ...current, safetyStockDays: 8 }),
    true,
  );
});

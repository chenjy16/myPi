import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateSupplierProfile,
  validateVariantBinding,
} from "../app/lib/supplier-validation.ts";

const VALID_PROFILE = {
  name: "Guangzhou Textiles Co.",
  contactName: "Wei Chen",
  contactEmail: "wei@example.com",
  contactPhone: "+86 20 1234 5678",
  leadTimeDays: "21",
  notes: "Silk only; Chinese New Year shutdown in February.",
};

test("a well-formed supplier profile passes and trims whitespace", () => {
  const result = validateSupplierProfile({
    ...VALID_PROFILE,
    name: "  Acme Supplies  ",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value?.name, "Acme Supplies");
  assert.equal(result.value?.leadTimeDays, 21);
});

test("optional fields collapse to null instead of empty strings", () => {
  const result = validateSupplierProfile({
    name: "Acme",
    contactName: "  ",
    contactEmail: "",
    contactPhone: undefined,
    leadTimeDays: "",
    notes: undefined,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    name: "Acme",
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    // 留空的交期是「跟随店铺设置」，不是 0 天到货。
    leadTimeDays: null,
    notes: null,
  });
});

test("missing or oversized names are rejected", () => {
  const missing = validateSupplierProfile({ name: "   " });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.name ?? "", /required/);

  const tooLong = validateSupplierProfile({ name: "x".repeat(121) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.name ?? "", /120 characters/);
});

test("emails get a loose format check, not a full RFC validation", () => {
  const bad = validateSupplierProfile({ name: "Acme", contactEmail: "not-an-email" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.contactEmail ?? "", /email address/);

  const good = validateSupplierProfile({ name: "Acme", contactEmail: "a@b.co" });
  assert.equal(good.ok, true);
});

test("supplier lead time honors the store-wide bounds", () => {
  const outOfRange = validateSupplierProfile({ name: "Acme", leadTimeDays: "999" });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.errors.leadTimeDays ?? "", /between 0 and 180/);

  const fractional = validateSupplierProfile({ name: "Acme", leadTimeDays: "7.5" });
  assert.equal(fractional.ok, false);
  assert.match(fractional.errors.leadTimeDays ?? "", /whole number/);
});

test("binding terms default to no thresholds and accept decimal costs", () => {
  const defaults = validateVariantBinding({});
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.value, {
    minOrderQuantity: 0,
    casePack: 0,
    unitCost: null,
  });

  const filled = validateVariantBinding({
    minOrderQuantity: "40",
    casePack: "12",
    unitCost: "4.50",
  });
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.value, {
    minOrderQuantity: 40,
    casePack: 12,
    unitCost: 4.5,
  });
});

test("binding rejects junk quantities and malformed costs", () => {
  const junk = validateVariantBinding({ minOrderQuantity: "-5" });
  assert.equal(junk.ok, false);
  assert.match(junk.errors.minOrderQuantity ?? "", /between 0 and 100000/);

  const weird = validateVariantBinding({ casePack: "1e3" });
  assert.equal(weird.ok, false);
  assert.match(weird.errors.casePack ?? "", /whole number/);

  const cost = validateVariantBinding({ unitCost: "4.555" });
  assert.equal(cost.ok, false);
  assert.match(cost.errors.unitCost ?? "", /2 decimals/);

  const negativeCost = validateVariantBinding({ unitCost: "-1" });
  assert.equal(negativeCost.ok, false);
  assert.match(negativeCost.errors.unitCost ?? "", /decimals/);
});

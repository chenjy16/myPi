import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSING,
  formatMoney,
  formatQuantity,
  formatPercent,
  formatRate,
  formatDecimal,
  formatDate,
  formatDateTime,
} from "../app/lib/format.ts";

test("money uses the shop currency with fixed two-decimal precision", () => {
  assert.equal(formatMoney(1234.5, "USD"), "$1,234.50");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(12.345, "EUR"), "€12.35");
});

test("money without a currency degrades to grouped number, never USD guess", () => {
  assert.equal(formatMoney(9876.5), "9,877");
});

test("quantities are grouped integers", () => {
  assert.equal(formatQuantity(1234567), "1,234,567");
  assert.equal(formatQuantity(42), "42");
});

test("percent keeps one decimal by default", () => {
  assert.equal(formatPercent(66.666), "66.7%");
  assert.equal(formatPercent(0), "0.0%");
});

test("rates read as whole percent labels off the 0–1 fraction the API gives", () => {
  assert.equal(formatRate(0.6234), "62%");
  assert.equal(formatRate(1), "100%");
  assert.equal(formatRate(0), "0%");
  assert.equal(formatRate(0.6234, 1), "62.3%");
});

test("decimals keep at most the requested digits without zero padding", () => {
  assert.equal(formatDecimal(2.5), "2.5");
  assert.equal(formatDecimal(2), "2");
  assert.equal(formatDecimal(2.456), "2.5");
  assert.equal(formatDecimal(1234.56, 2), "1,234.56");
});

test("missing or non-finite values always render the em dash", () => {
  for (const value of [null, undefined, NaN, Infinity]) {
    assert.equal(formatQuantity(value as number | null | undefined), MISSING);
    assert.equal(formatMoney(value as number | null | undefined, "USD"), MISSING);
    assert.equal(formatPercent(value as number | null | undefined), MISSING);
    assert.equal(formatRate(value as number | null | undefined), MISSING);
    assert.equal(formatDecimal(value as number | null | undefined), MISSING);
  }
  assert.equal(formatDate(null), MISSING);
  assert.equal(formatDate("not-a-date"), MISSING);
});

test("dates honor the shop timezone", () => {
  const at = new Date("2026-11-03T01:30:00Z");
  const utc = formatDate(at, "UTC");
  const tokyo = formatDate(at, "Asia/Tokyo");
  assert.equal(utc, "Nov 3, 2026");
  assert.equal(tokyo, "Nov 3, 2026");
  assert.match(formatDateTime(at, "UTC"), /Nov 3, 2026,\s1:30\s(AM|PM)/);
});

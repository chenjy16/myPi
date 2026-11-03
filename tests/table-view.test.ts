import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_QUERY,
  buildTableView,
  compareRows,
  matchesSearch,
  normalizeSearch,
  paginate,
  resetPage,
  searchAndSort,
  toReplenishmentRow,
  type ReplenishmentRow,
} from "../app/lib/table-view.ts";

/** 造一行：只关心视图逻辑，其余字段填可辨识的默认值。 */
function row(overrides: Partial<ReplenishmentRow> = {}): ReplenishmentRow {
  return {
    id: overrides.id ?? "row-1",
    productTitle: overrides.productTitle ?? "Test Product",
    variantTitle: overrides.variantTitle ?? "M / Blue",
    sku: "sku" in overrides ? overrides.sku! : "SKU-001",
    available: overrides.available ?? 10,
    incoming: overrides.incoming ?? 0,
    averageDailySales: overrides.averageDailySales ?? 2,
    daysOfInventory:
      overrides.daysOfInventory === undefined ? 5 : overrides.daysOfInventory,
    suggestedReorderQuantity: overrides.suggestedReorderQuantity ?? 20,
    confidenceLevel: overrides.confidenceLevel ?? "high",
    status: overrides.status ?? "low_stock",
    actionState: "actionState" in overrides ? overrides.actionState! : "pending",
  };
}

/** DashboardVariant 的字段形状只要结构上满足即可折算，不需要任何 cast。 */
const source = {
  id: "v-1",
  productTitle: "Ceramic Mug",
  variantTitle: "12oz",
  sku: "MUG-12",
  available: 4,
  incoming: 2,
  observedDemand: { perDay: 1.5 },
  daysOfInventory: 2.6667,
  suggestedReorderQuantity: 30,
  confidence: { level: "medium" as const },
  status: "stockout_risk" as const,
  actionState: "pending" as const,
};

describe("replenishment table view", () => {
  test("folds a dashboard row into the presentation fields it needs", () => {
    const view = toReplenishmentRow(source);
    assert.equal(view.id, "v-1");
    assert.equal(view.averageDailySales, 1.5);
    assert.equal(view.confidenceLevel, "medium");
    assert.equal(view.daysOfInventory, 2.6667);
  });

  test("search is case-insensitive, trims and requires every term to hit", () => {
    assert.equal(normalizeSearch("  CeRaMic   MUG  "), "ceramic mug");
    assert.equal(matchesSearch(row({ productTitle: "Ceramic Mug" }), "CeRaMiC"), true);
    assert.equal(matchesSearch(row({ sku: "SKU-001" }), "sku-001"), true);
    assert.equal(matchesSearch(row({ variantTitle: "12oz" }), "12oz"), true);
    assert.equal(matchesSearch(row({ productTitle: "Ceramic Mug" }), "ceramic glass"), false);
    assert.equal(matchesSearch(row(), ""), true);
    assert.equal(matchesSearch(row(), "   "), true);
  });

  test("priority puts the thinnest coverage first and never a null", () => {
    const rows = [
      row({ id: "no-sales", daysOfInventory: null }),
      row({ id: "tight", daysOfInventory: 1, suggestedReorderQuantity: 5 }),
      row({ id: "roomy", daysOfInventory: 40 }),
    ];
    const sorted = searchAndSort(rows, {
      search: "",
      sort: "priority",
      direction: "asc",
    });
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["tight", "roomy", "no-sales"],
    );
  });

  test("equal coverage breaks ties toward the bigger suggestion", () => {
    const sorted = searchAndSort(
      [
        row({ id: "small", daysOfInventory: 3, suggestedReorderQuantity: 10 }),
        row({ id: "big", daysOfInventory: 3, suggestedReorderQuantity: 200 }),
      ],
      { search: "", sort: "priority", direction: "asc" },
    );
    assert.deepEqual(
      sorted.map((item) => item.id),
      ["big", "small"],
    );
  });

  test("descending flips values but keeps nulls at the bottom", () => {
    const rows = [
      row({ id: "a", available: 1 }),
      row({ id: "b", available: 9 }),
      row({ id: "c", available: 5 }),
    ];
    const desc = searchAndSort(rows, {
      search: "",
      sort: "available",
      direction: "desc",
    });
    assert.deepEqual(
      desc.map((item) => item.id),
      ["b", "c", "a"],
    );
    const nulls = searchAndSort(
      [row({ id: "null", daysOfInventory: null }), row({ id: "ten", daysOfInventory: 10 })],
      { search: "", sort: "coverage", direction: "desc" },
    );
    assert.deepEqual(
      nulls.map((item) => item.id),
      ["ten", "null"],
    );
  });

  test("missing SKU sinks regardless of direction", () => {
    const rows = [row({ id: "none", sku: null }), row({ id: "set", sku: "AAA" })];
    for (const direction of ["asc", "desc"] as const) {
      const sorted = searchAndSort(rows, { search: "", sort: "sku", direction });
      assert.equal(sorted[0]?.id, "set", `direction ${direction}`);
    }
  });

  test("status orders by stockout risk and confidence by weakness", () => {
    const byStatus = searchAndSort(
      [
        row({ id: "healthy", status: "healthy" }),
        row({ id: "out", status: "stockout" }),
        row({ id: "dead", status: "dead_stock" }),
      ],
      { search: "", sort: "status", direction: "asc" },
    );
    assert.deepEqual(
      byStatus.map((item) => item.id),
      ["out", "healthy", "dead"],
    );

    const byConfidence = searchAndSort(
      [
        row({ id: "high", confidenceLevel: "high" }),
        row({ id: "low", confidenceLevel: "low" }),
        row({ id: "mid", confidenceLevel: "medium" }),
      ],
      { search: "", sort: "confidence", direction: "asc" },
    );
    assert.deepEqual(
      byConfidence.map((item) => item.id),
      ["low", "mid", "high"],
    );
  });

  test("pagination slices, labels the range and clamps the page", () => {
    const rows = Array.from({ length: 60 }, (_unused, index) =>
      row({ id: `r${index}`, available: index }),
    );
    const first = paginate(rows, 1, 25);
    assert.equal(first.totalRows, 60);
    assert.equal(first.totalPages, 3);
    assert.equal(first.rows.length, 25);
    assert.equal(first.firstIndex, 1);
    assert.equal(first.lastIndex, 25);

    const last = paginate(rows, 3, 25);
    assert.equal(last.rows.length, 10);
    assert.equal(last.firstIndex, 51);
    assert.equal(last.lastIndex, 60);

    // 结果集缩小后不能停在空白页。
    const overflow = paginate(rows, 99, 25);
    assert.equal(overflow.page, 3);
    assert.equal(overflow.rows.length, 10);

    const empty = paginate([], 4, 25);
    assert.equal(empty.page, 1);
    assert.equal(empty.totalRows, 0);
    assert.equal(empty.firstIndex, 0);
    assert.equal(empty.lastIndex, 0);
  });

  test("buildTableView composes search, sort and page in one pass", () => {
    const rows = [
      row({ id: "mug", productTitle: "Ceramic Mug", sku: "MUG-1", daysOfInventory: 2 }),
      row({ id: "plate", productTitle: "Ceramic Plate", sku: "PLT-1", daysOfInventory: 8 }),
      row({ id: "glass", productTitle: "Glass Tumbler", sku: "GLS-1", daysOfInventory: 1 }),
    ];
    const view = buildTableView(rows, {
      ...DEFAULT_QUERY,
      search: "ceramic",
      sort: "priority",
    });
    assert.equal(view.totalRows, 2);
    assert.deepEqual(
      view.rows.map((item) => item.id),
      ["mug", "plate"],
    );
  });

  test("a new search or filter resets to page one", () => {
    const next = resetPage({ ...DEFAULT_QUERY, search: "mug", page: 7 });
    assert.equal(next.page, 1);
    assert.equal(next.search, "mug");
  });

  test("comparing a row with itself is neutral", () => {
    const a = row();
    assert.equal(compareRows(a, a, "product", "asc"), 0);
    assert.equal(compareRows(a, a, "available", "desc"), 0);
  });
});

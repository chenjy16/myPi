# mypi Design System (Sprint 1 Foundation)

Layering contract for every UI change in this repo. Read this before writing
any component or style. Rationale and evidence: `docs/ui-audit-report.md`.

## 1. Two layers, one product — never competing

| Layer | Owner | Use for |
|---|---|---|
| **Polaris Web Components** (`s-*`) | Shopify | Page skeleton (`s-page`), sections, banners, buttons, forms, tables with listSlots, tooltips — any surface Shopify already provides. |
| **`ds*` business primitives** | mypi | Metric cards, status pills, dense data tables, freshness indicators — things Polaris WC does not ship yet. Rendered INSIDE the Polaris layout, never instead of it. |

Rules:

- If Polaris WC has the component, use it. Do not re-skin it in CSS.
- A `ds*` primitive must consume tokens only (see §2). No page-local colors.
- Do NOT add Polaris React, Tailwind, or any second UI kit (spec §20-8).

## 2. Tokens — single source `app/styles/tokens.css`

- Every color, spacing, radius, shadow, z-index, font size/weight/line-height
  used by the custom layer comes from a `--app-*` / `--sp-*` / `--fs-*` /
  `--radius-*` / `--shadow-*` / `--z-*` token.
- Pages must not define new tokens. New visual values require a PR that adds
  the token here first, with a usage note.
- Palette: Shopify-admin neutral base (text `#202b35`, secondary `#616f7c`,
  background `#f6f7f8`, border `#e1e3e5`) + mypi violet (`#6546e8`) reserved
  for primary CTA and brand texture.
- Status colors: success `#008060`, warning `#b98900`, critical `#d72c0d`,
  info `#2c6ecb` — each with a `-soft` background partner. Never color-only:
  a status is always color + text label.
- Spacing: 4px grid (`--sp-1..--sp-12`). Typography scale `--fs-xs..--fs-kpi`.
- Breakpoints (contract): sm 560 · md 680 · lg 900 · xl 1180.
  Verification viewports: 390 / 768 / 1280 / 1440.

## 3. Shared primitives (app/components/ui/)

| Component | Contract |
|---|---|
| `StatusBadge` / `ActionStateBadge` / `HealthBadge` / `ConfidenceBadge` / `SyncStatusBadge` / `InventoryStatusBadge` | The ONLY way to render any state-like value (`lib/status.ts` owns tone + label + class; labels for Action Board / CSV / audit come from the existing domain maps). Pages must not hand-roll pills, raw `s-badge` or plain-text statuses. |
| `EmptyState` | heading + why + next action. "No data" alone is not an empty state. |
| `LoadingState` | Page-level: while `useNavigation().state !== "idle"`. Row-level: only the control whose `intent` + `variantId` matches `fetcher.formData`. Also disable the trigger to prevent double submit. |
| `TableSearchField` / `TableSortControl` / `TablePageSizeControl` / `TablePagination` / `TableNoResultsHint` | The list-page toolbar family (spec §8.2). Values are controlled by the page; the components read the Polaris host element's `.value` directly because React 18 does not reliably proxy custom-element events. |

Pure logic lives in `app/lib/status.ts` (state semantics), `app/lib/format.ts`
(money/quantity/percent/rate/date/missing `—`) and `app/lib/table-view.ts`
(search · sort · page slice). All three are unit-tested with node:test.

## 3b. List-page contract (reference: Replenishment, Sprint 2)

`app/routes/app.inventory.tsx` is the pattern every other list page copies:

1. Loader computes once; **search / sort / paginate run on the client**
   (`lib/table-view.ts` + `useMemo`). Re-running the loader per keystroke would
   re-hit the Admin API and double-count the `recommendation_viewed` event.
2. Query state is one object (`{ search, sort, direction, page, pageSize }`,
   `DEFAULT_QUERY`). Any change to search / sort column / page size goes through
   `resetPage()`; the state-tab switch keeps the keyword but returns to page 1.
3. Null always sorts to the bottom and does not flip with the direction; ties on
   coverage break toward the larger suggested quantity.
4. Three distinct empty states, never one generic string: no data at the
   location · nothing in this Action Board state (offer "Show all variants") ·
   no match for the keyword (offer "Clear search").
5. `Showing 1–25 of 132 variants · page 1 of 6` is `aria-live="polite"` so the
   count is announced after a filter change.
6. Sort defaults to *Most urgent first*, not to product name — the page is a work
   queue, not a catalogue.

## 4. Data formatting (spec §10)

| Type | Rule |
|---|---|
| Currency | `formatMoney(value, shopCurrency)` — never hardcode USD |
| Quantity | `formatQuantity` — grouped integers, unit stays in the column header |
| Percentage | `formatPercent` — one decimal, value passed as 0–100 |
| Rate | `formatRate` — value passed as the 0–1 fraction the API gives, rendered as a whole percent (`62%`) |
| Measured quantity | `formatDecimal` — daily sales, coverage days (one decimal by default, no zero padding) |
| Date/time | `formatDate/DateTime(value, shopTimeZone)` — always `settings.timezone`, never browser-local |
| Missing | `—` (em dash). Not 0, not "-", not "N/A" |
| Not enabled | "Not enabled" |
| Stale | explicit freshness banner; never present old data as new |

## 5. Interaction rules (spec §8)

- One primary action per page; destructive = danger styling + confirm dialog
  (native `window.confirm` is being replaced by a shared dialog in Sprint 5).
- Every mutation: pending feedback (`LoadingState`) + success/failure result
  (`s-banner`); errors state the user action, never "Something went wrong".
- Disabled controls explain why.
- Keyboard: focus ring is global (`tokens.css :focus-visible`); do not remove
  outlines without a replacement.

## 6. Migration order

Sprint 2 Replenishment (reference) → Sprint 3 Home/DataHealth/Settings →
Sprint 4 PurchasePlans/Suppliers/SupplyChain → Sprint 5 Docs/shell/details →
Sprint 6 responsive+a11y+regression+CSS drain (184 shell hex + 55 gradient
shades tracked in the audit report).

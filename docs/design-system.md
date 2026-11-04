# mypi Design System

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
| `StatusBadge` / `ActionStateBadge` / `HealthBadge` / `ConfidenceBadge` / `SyncStatusBadge` / `InventoryStatusBadge` / `DataHealthStateBadge` / `ReadinessBadge` / `SupplierActivityBadge` / `PlanStatusBadge` | The ONLY way to render any state-like value (`lib/status.ts` owns tone + label + class; labels for Action Board / CSV / audit come from the existing domain maps). Pages must not hand-roll pills, raw `s-badge` or plain-text statuses. `ReadinessBadge` carries the six Settings readiness states (`configured · needsSetup · available · storeSettings · systemEstimate · notEnabled`). `SupplierActivityBadge` renders a relationship as Active/**neutral-paused** — pausing a supplier is a deliberate choice, so it must not borrow the warning/critical red that `ActionStateBadge` uses for a *paused decision* (see §3d). `PlanStatusBadge` reuses the shared `STATUS_LABEL`/`STATUS_TONE` vocabulary so the UI never invents a second name for a server plan state, and prints an unrecognised legacy status verbatim instead of swallowing it. |
| `FactGrid` | Read-only label/value fact cards (Polaris `s-grid` + `s-box` only, no CSS of its own). Replaces per-page `<dl>` / hand-built key-value markup. Never use it for editable data. |
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

## 3c. Page-skeleton contract (Home · Data Health · Settings, Sprint 3)

Every non-list app page is exactly `<s-page heading>` + a sequence of
`s-section heading`. Copying the reference page is not optional:

1. **One heading source.** The page never renders its own `h1` / hero / `pageIntro`
   band — `s-page heading` already owns it. A second title inside the body is the
   duplicate-header defect the audit flagged on Home and Settings. *Settled:* the
   Home hero block (display headline + 4 decorative cards) is gone for good —
   confirmed in-browser that `At a glance` reads as the first section and nothing
   competes with the page title. The value proposition survives as one
   `s-paragraph` inside that section. No page gets a hero exception.
2. **`s-page` slots are unavailable in React.** `@shopify/polaris-types` declares
   `s-page` as `Omit<…, "aside" | "primaryAction" | "secondaryActions" |
   "breadcrumbActions">` for JSX (only the preact declaration keeps them), and
   `s-section` only accepts `heading | padding | accessibilityLabel`. So the page's
   primary CTA goes in an inline `s-stack` inside the first section, and anything
   that would have been an `aside` becomes its own `s-section`. Do not "fix" this
   by casting the attribute through — it type-errors and silently no-ops.
3. **No page-level shells.** No `className="ds"` wrapper, no raw `<table>`, no
   local pill/tone/label maps: tables are `s-table variant="auto"` with
   `listSlot`s, and every state value goes through `lib/status.ts` badges. The
   `ds*` layer is only allowed to survive where Polaris has no equivalent (§1
   row 2 — currently metric cards, consumed by Home and Metrics).
4. **Result feedback is scoped to the submitted section.** Derive
   `saveSectionBusy` / `testSectionBusy` from `fetcher.formData.get("intent")`, so a
   validation error appears under the form that produced it, not on an unrelated
   section.
5. **Navigation out of the page is one `s-link`** ("Back to workspace" /
   "Details →"), not a hand-built link row.
6. **Unknown enum values stay literal.** Audit and ledger rows pass through
   `isBusinessState()` — an unrecognised historical status is printed as-is rather
   than swallowed by a badge (audit vocabulary is read-only for the UI).
7. **Never lead an `s-paragraph` with bare text followed by an inline `s-*`
   element.** Verified in the browser: Polaris takes the default slot from the
   element child and the leading text disappears (Data Health rendered
   `. Last sync attempt: …` with the `Current status:` label gone). Put the label
   and the badge in an inline `s-stack` of `s-text` + badge, and keep the prose in
   its own `s-paragraph`.

## 3d. Mutation-page contract (Purchase Plans · Suppliers, Sprint 4)

These pages hold many independent forms in one screen (per-plan line edits, per-supplier
edits, SKU bindings). The action / state machine / idempotency (`requestKey`) / audit
vocabulary / Shopify read-only boundary are **not** part of the refactor — only the view
layer changed. The view rules:

1. **Feedback buckets by `intent`, then by row key.** §3c point 4 says scope a result to
   its section; when one section renders N cards, a global `intent` match lights all N.
   So bucket a second time on `fetcher.formData.get("planId")` / `get("formKey")` — a
   "Saved" or error banner appears only beside the card that was just submitted.
2. **An unrecognised `intent` surfaces once at the top, not in every bucket.** Route
   unknown/failed intent to a single `unattributedError` above the sections rather than
   letting the same sentence render in each bucket.
3. **Field-level errors attribute via a hidden `formKey`.** The edit drawer / bind form
   posts an extra `<input type="hidden" name="formKey" …>`; `fieldErrorFor(formKey, field)`
   maps a server error back onto the exact input without touching the action.
4. **Placeholder pages still use `s-page`.** `app.supply-chain.tsx` is a "coming soon"
   segment but renders the same `<s-page>` + `s-section` + `ReadinessBadge
   kind="notEnabled"` skeleton — an unbuilt feature must not become a rogue `h1` page.
5. **Pause semantics stay distinct.** A *paused supplier relationship* is `neutral`
   (`SupplierActivityBadge` — a normal merchant choice); a *paused decision* stays
   `warning`/`critical` (`ActionStateBadge` — data is unsafe to order against). Never
   collapse them into one pill.
6. **Currency/timezone come from Settings, per request.** Loaders read
   `db.inventorySettings.findFirst` for `currencyCode` + `timezone` and pass them to
   `formatMoney` / `formatDate`; no page hardcodes USD or a machine-local zone.

## 4. Data formatting (spec §10)

| Type | Rule |
|---|---|
| Currency | `formatMoney(value, shopCurrency)` — never hardcode USD |
| Quantity | `formatQuantity` — grouped integers, unit stays in the column header |
| Percentage | `formatPercent` — one decimal, value passed as 0–100 |
| Rate | `formatRate` — value passed as the 0–1 fraction the API gives, rendered as a whole percent (`62%`) |
| Measured quantity | `formatDecimal` — daily sales, coverage days (one decimal by default, no zero padding) |
| Date/time | `formatDate/DateTime(value, shopTimeZone)` — always `settings.timezone`, never browser-local; with no zone passed both fall back to UTC, not the machine's zone |
| Calendar-only date (`YYYY-MM-DD`) | `formatDate` reads it as UTC. A bare date string is `new Date()`-parsed to UTC midnight, so rendering it in `America/New_York` would show the day **before** — snapshot dates and window starts must not shift. Timestamps keep the shop-timezone rule. |
| Missing | `—` (em dash). Not 0, not "-", not "N/A" |
| Not enabled | "Not enabled" |
| Stale | explicit freshness banner; never present old data as new |

## 5. Interaction rules (spec §8)

- One primary action per page; destructive actions confirm before submitting —
  shared `ConfirmFetchForm` (`app/components/ui/confirm-fetch-form.tsx`), no
  `window.confirm` left in app routes.
- Every mutation: pending feedback (`LoadingState`) + success/failure result
  (`s-banner`); errors state the user action, never "Something went wrong".
- Disabled controls explain why.
- Keyboard: focus ring is global (`tokens.css :focus-visible`); do not remove
  outlines without a replacement.

### 5a. Confirm dialog contract (Sprint 5)

- `ConfirmFetchForm` wraps a `fetcher.Form`: submit is intercepted, a `<dialog>`
  opens, and only Confirm re-submits via `requestSubmit()` with a one-shot
  bypass. Pages keep their intent / planId / formKey bucketed-banner feedback
  untouched; the action never knows a dialog existed.
- Native `<dialog>` + `showModal()` instead of Polaris `s-modal`: React 18's
  event delegation over custom elements is unreliable here (see the table
  primitives' `.value` comments); `showModal` gives deterministic focus
  trapping and Esc. Styles come only from tokens (`.confirmDialog*`).
- Confirm button: `s-button tone="critical"` when `danger: true` (irreversible:
  delete supplier, cancel plan, unbind SKU), `tone="auto"` otherwise (mark-ordered
  moves data but is not destructive). Note: the Polaris *React* type narrows
  `s-button` tone to `auto | neutral | critical` — there is no `variant="danger"`
  and no `accent` tone on the React button; tone is the only axis for this.
- Copy contract: heading says exactly what will happen (`Mark PP-12 as
  ordered`), body states consequences and reversibility, confirm label starts
  with a verb. Cancel/Esc/click-outside must never submit.

### 5b. Result feedback — no toast

Sprint 5 decision: outcomes stay in-page `s-banner`s bucketed per fetcher
intent, not a transient toast. The merchant acts inside one page; a banner
survives re-render and keeps the reference copy readable, while a toast
disappears before slower DB round-trips finish. Do not add a toast library.

### 5c. Navigation contract

- The sidebar in `app.tsx` is one flat list (`NAV_ITEMS`) — every visible
  primary route appears exactly once, each with a distinct glyph; no footer
  link blocks duplicating nav entries. Feature-hidden routes (product copy)
  stay out of the list while their flag is off.
- Heading source stays single (`s-page heading` per §3c-1); nav labels are
  sentence case matching each page's heading.

## 6. Migration order

Sprint 2 Replenishment (reference) → Sprint 3 Home/DataHealth/Settings →
Sprint 4 PurchasePlans/Suppliers/SupplyChain → Sprint 5 Docs/shell/details →
Sprint 6 responsive+a11y+regression+CSS drain (184 shell hex + 55 gradient
shades tracked in the audit report).

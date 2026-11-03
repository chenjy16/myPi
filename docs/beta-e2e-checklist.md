# Beta Manual E2E Checklist (P1-6 / P1-10)

Automated coverage (unit / mock / DB integration) proves the data layer, the sync
ledger, and the error channels. It cannot exercise the **embedded Shopify runtime**
(OAuth, the admin iframe, real Admin API throttling, browser viewports), which needs
a human in the Shopify admin. Run this list against the dev store
(`stepchic.myshopify.com`) before every Beta cut. A step passes only when the *observed*
result matches; never mark a step green from the code path alone.

Legend: **P0** = blocking for Beta · **P1** = expected polish · record device/viewport.

---

## 0. Preconditions

- [ ] Worker + web run from the current commit; `prisma migrate deploy` applied.
- [ ] The dev store has at least one ACTIVE product with a tracked variant and a location selected.
- [ ] Open DevTools (Console + Network) and keep it open the whole pass. **Bar: no uncaught
      errors, no 5xx, no mixed-content warnings.** Capture screenshots into `docs/reports/`.

## 1. Install / auth / embed — P0

- [ ] Fresh (or re-authorized) install lands on `/app` inside the Shopify admin iframe.
- [ ] Session survives a hard refresh and a deep link to `/app/inventory` (no re-login loop).
- [ ] Offline token is used (Settings/actions work without an online merchant click).
- [ ] Uninstall webhook fires later (see §9).

## 2. Onboarding & Home — P0

- [ ] Home shows onboarding steps; completing them (location → settings → first sync) flips steps done.
- [ ] `onboarding_completed` is recorded once (verify in `/app/metrics` event count / Data Health).
- [ ] Hero metrics render with **real** numbers (no `0`/`—` where data exists, no fabricated values).

## 3. Replenishment sync — P0

- [ ] **Sync** button starts a snapshot: loading state is honest (does not claim "latest" while running).
- [ ] Click Sync twice fast / from two tabs → the second is told *"already running"*, **not** an error.
- [ ] After success, freshness banner shows the new timestamp; Data Health lists a `succeeded` job.
- [ ] Force a failure (revoke a scope / bad location) → job records `failed`, UI shows the readable reason, and the **last successful data is still displayed with a stale notice** (never blank, never silently "fresh").
- [ ] Kill the worker mid-sync (SIGTERM) → process exits cleanly; the orphaned `running` row is reaped to `failed` after the lease and the store is **not** locked permanently.
- [ ] `inventory_sync_started` and `sync_completed{outcome}` both appear in the event stream.

## 4. Advice decisions (Action Board) — P0

- [ ] With live suggestions, `recommendation_viewed` is recorded (≤ once per UTC day).
- [ ] **Accept / Edit / Ignore / Order** each update the board state and append one audit row.
- [ ] Double-click / re-submit the same action is idempotent (one audit row, no double count).
- [ ] Re-running Sync does **not** overwrite a merchant's decided quantity/status (only refreshes calculation).
- [ ] `advice_accepted` sets the TTFV anchor visible in `/app/metrics`.

## 5. Purchase plans & export — P0

- [ ] Create a plan from accepted/edited advice; plan reference is store-scoped (`PP-0001` increments per store).
- [ ] Export CSV downloads with the rows shown on screen (numbers match the page).
- [ ] Both `csv_exported` and `purchase_plan_exported` fire.
- [ ] Mark plan `ordered` → status + `orderedAt` persist; cancel behaves correctly.

## 6. Suppliers — P1

- [ ] Create/edit/deactivate a supplier; `supplier_saved` fires.
- [ ] Deactivating a supplier silently drops its variants back to store defaults (no crash).
- [ ] Deleting a supplier unbinds its SKUs; existing plans still render (supplier-name snapshot).

## 7. Settings — P0

- [ ] Save replenishment params (lead / safety / review days); `settings_saved` fires; UI labels them "Merchant set".
- [ ] Only a real change triggers recalculation; saving identical values does not churn advice.
- [ ] Validation rejects out-of-range input with an inline, actionable message.

## 8. Data Health & Beta Metrics — P1

- [ ] Data Health lists recent jobs (type/status/records/reason) consistent with actions taken.
- [ ] `/app/metrics` shows only this store's numbers; empty store shows `—`, not fake `0%`.

## 9. Read-only boundary — P0 (red line)

- [ ] Throughout the whole pass, **no inventory/price/product write reaches Shopify**
      (Admin GraphQL is queries only; Storefront/checkout untouched).
- [ ] `app/uninstalled` and `shop/redact` webhooks purge this store's business data.

## 10. Design language & mobile — P1

- [ ] Colors come from the shared tokens (`--app-*`): brand violet, ink, and status
      success/danger/warning render identically on Home (`ds*`) and on Polaris pages (`s-*`).
- [ ] No stray hardcoded theme color appears that diverges from a sibling page.
- [ ] At **360×640 (iPhone SE)**: Home metric tiles are single-column, quick actions 2-up,
      hero stacks vertically, wide tables scroll horizontally without clipping the shell.
- [ ] At **390×844 (iPhone 14)** and **768×1024 (tablet)**: sidebar collapses to a
      horizontally scrollable nav; primary buttons/actions stay reachable and non-overlapping.
- [ ] Text never overflows its card; tap targets ≥ ~40px; no horizontal scroll on the page body itself.

## 11. Error surface — P1

- [ ] Trigger a server error; the ErrorBoundary shows a readable message + reference kind,
      **never** a stack trace or server path in the DOM.

---

### Sign-off

| Area | Result (pass/fail/blocked) | Device/viewport | Notes / ticket |
| --- | --- | --- | --- |
| Sync & ledger (§3) | | | |
| Advice & export (§4–5) | | | |
| Shopify embed (§1, §9) | | | |
| Design & mobile (§10) | | | |

Record failures as issues with the exact reproduction step, device, and console/network
evidence. Beta is not cut until every **P0** row is pass.

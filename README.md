# mypi — Inventory Decision Intelligence for Shopify

mypi is an embedded Shopify admin app that turns a store's own sales and inventory
data into **deterministic replenishment advice**, then carries that advice through a
full decision loop: review → decide → supplier terms → purchase plan → CSV handoff.
Every number on screen is computed by plain, testable TypeScript — **AI is never used
to decide stock levels or order quantities**.

The app is **read-only against Shopify**: it reads products, inventory, orders and
locations, and never writes them back. It does not create Shopify purchase orders or
modify inventory counts; "Mark ordered" only updates in-app state and its audit trail.

> The server-side AI product-copy feature still exists in the codebase but is hidden
> behind a feature flag (`PRODUCT_COPY_ENABLED = false`) and the app no longer requests
> the `write_products` scope, so copy generation and write-back are currently inactive.
> Existing routes and draft data are preserved for a possible future re-enable.

## Tech stack

| Layer | Current technology |
| --- | --- |
| Runtime | Node.js `>=22.19`, TypeScript, npm |
| Web app | React 18, React Router 7 (server `loader`/`action`), Vite 7 |
| Shopify integration | Official `@shopify/shopify-app-react-router`, OAuth/session storage, App Bridge, Admin GraphQL API |
| Admin UI | Embedded Shopify admin + Shopify Web Components (`s-*`) |
| Data | Prisma 6 + PostgreSQL (local dev points at Supabase). Stores sessions, multi-location daily inventory snapshots, inventory-change events, daily sales, reorder decisions, per-decision audit trail, suppliers & terms, purchase plans, analytics/feedback events and a sync-job ledger |
| Background jobs | Separate Node worker (`worker/index.ts`) + node-cron, decoupled from the web process |
| Inventory analysis | Shopify Admin GraphQL + deterministic TypeScript calculations |
| Dev / deploy | Shopify CLI; ephemeral HTTPS tunnel for local dev |

Full architecture, data flow, deployment topology and production gaps:
[architecture & deployment](./docs/architecture-and-deployment.md) ·
[detailed design](./docs/detailed-design.md) ·
[beta plan](./docs/beta-plan.md) ·
[release runbook](./docs/release-runbook.md) ·
[stage reports](./docs/reports).

## Key entry points

- [`app/shopify.server.ts`](../app/shopify.server.ts) — app config, Admin auth and Prisma session storage. Uses **offline** access tokens (`useOnlineTokens: false`) so the worker, crons and webhooks can call the Admin API when the merchant is absent.
- [`app/routes/app.tsx`](./app/routes/app.tsx) — in-app shell: navigation, current-store identity, and the top-level `ErrorBoundary`.
- [`app/routes/app._index.tsx`](./app/routes/app._index.tsx) — home dashboard built from real data (metrics, most urgent advice, Data Health summary, recent decisions).
- [`app/routes/app.inventory.tsx`](./app/routes/app.inventory.tsx) + [`app/inventory.server.ts`](./app/inventory.server.ts) — location selection, manual sync, the six-state Action Board, daily snapshot & sales rebuild, inventory diagnosis, reorder decisions and dashboard data.
- [`app/routes/app.suppliers.tsx`](./app/routes/app.suppliers.tsx) + [`app/suppliers.server.ts`](./app/suppliers.server.ts) — supplier profiles and per-variant supply terms (MOQ, lead time, unit cost).
- [`app/routes/app.purchase-plans.tsx`](./app/routes/app.purchase-plans.tsx) + [`app/purchase-plans.server.ts`](./app/purchase-plans.server.ts) — merge accepted advice into plans, edit quantities/dates, run the plan status machine, export a plan CSV.
- [`app/routes/app.data-health.tsx`](./app/routes/app.data-health.tsx) — actionable checklist of data gaps that gate trust in the advice.
- [`app/routes/app.settings.tsx`](./app/routes/app.settings.tsx) — replenishment parameters (lead time, safety stock, review period) with validated, source-tracked writes.
- [`app/routes/app.docs.tsx`](./app/routes/app.docs.tsx) — guide & feedback entry.
- [`app/routes/health.tsx`](./app/routes/health.tsx) — `/health` liveness endpoint; returns `503` when the database ping fails.
- [`app/features.ts`](./app/features.ts) — product feature flags.
- [`app/lib/`](./app/lib) — pure, I/O-free, unit-tested logic: `inventory-calculations.ts` (Observed Demand + reorder formula), `reorder-confidence.ts` (confidence & downgrade reasons), `data-health.ts` (checks & pause rule), `reorder-action-board.ts` (six-state classification + adoption rate), `reorder-recommendations.ts` (decision status & audit mapping), `reorder-export.ts` / `purchase-plan-export.ts` (CSV), `supplier-validation.ts`, `settings-validation.ts`, `analytics.ts`, `onboarding.ts`, `sync-job-policy.ts`, `app-error.ts` / `route-error.ts` (safe error channel). **New pure logic belongs here: a module at `app/` root would occupy the `/app/<name>` URL and shadow an SSR route.**
- [`app/db.server.ts`](./app/db.server.ts) + [`prisma/schema.prisma`](../prisma/schema.prisma) — DB client and data models.
- [`worker/index.ts`](../worker/index.ts) — background worker: cron-driven all-location daily snapshots and sales-window rebuild.
- [`app/webhook-sync.server.ts`](./app/webhook-sync.server.ts) + [`app/routes/webhooks.*.tsx`](./app/routes) — uninstall / scopes-update / privacy-compliance webhooks, plus incremental `inventory_levels/update`, `orders/create` and `orders/cancelled` recompute.
- [`shopify.app.toml`](../shopify.app.toml) — the single Shopify app configuration.

## Replenishment & decision loop

The merchant picks an active inventory location on `/app/inventory` and syncs. The app
reads active variants, sellable/incoming stock at that location, and paid orders across
the store. After sync, each variant shows 30/60/90-day sales, coverage days, projected
stockout date, risk status and reorder advice — with the calculation basis visible.

Every variant with advice greater than `0` automatically enters `pending`. The merchant
works the six-state **Action Board** (`All` / `Pending` / `Accepted` / `Edited` /
`Ignored` / `Ordered`, plus `Paused` when data is unhealthy): accept, adjust quantity,
ignore, or mark ordered. Decisions persist per shop + location + variant, and **every
change appends a `RecommendationAudit` row in the same transaction** (from/to status,
suggested vs. confirmed quantity, confidence snapshot, operator). Because sessions are
offline, the audit distinguishes only `system` (sync-registered) from `merchant`
(in-app actions) — it never claims to identify a specific employee.

Two safeguards shipped in the beta:

- **Decision reason** — adjust/ignore capture a short merchant rationale, stored with
  the current decision and its audit row.
- **Request-level idempotency** — each row carries a hidden `requestKey` (UUID) backed
  by a unique index on `RecommendationAudit.requestKey`. A double-submit replays the
  same key and hits the unique constraint (`P2002`), which is detected and returned
  without writing a duplicate audit entry; a fresh key is issued after each success.
  Deliberate consecutive decisions are each recorded — that is intended, not a bug.

Each suggestion carries a **Reorder Confidence** badge (high / medium / low) with
expandable downgrade reasons (incomplete sales history, stale snapshot, no sales
sample, missing cost). Confidence answers "how much to trust this number"; it never
changes the quantity. The board exports a 27-column reorder CSV (with a UTF-8 BOM so
Excel opens CJK fields correctly) for offline supplier communication.

**The math is deterministic:** Observed Demand = sales in window ÷ visible sample days
(**not** ÷ window days, so a permission or data gap is never read as "demand dropped");
reorder point = daily rate × (lead time + safety days); target stock = daily rate ×
(lead time + review period + safety days); suggested quantity = max(0, target − sellable
− incoming). Defaults are lead time 14, safety stock 7, review period 14 days — all
system estimates. Sales are counted by Shopify `processedAt` date for orders that are
not cancelled and are financially paid, partially refunded or refunded; refunds/returns
are not subtracted. Inventory is per selected location; sales are store-wide. Shopify
grants only the last 60 days of orders unless `read_all_orders` is approved and
authorized, in which case 90-day history and long-dormant detection become available;
otherwise the UI marks history as incomplete. Product cost also depends on the Shopify
user's "view product costs" permission, so missing cost yields an incomplete value estimate.

## Suppliers & purchase plans (now implemented)

- **Suppliers** (`/app/suppliers`): supplier profiles and per-variant supply terms — MOQ,
  lead time and unit cost. Supplier lead time takes precedence over store-wide defaults,
  and suggested quantities round up to MOQ.
- **Purchase Plans** (`/app/purchase-plans`): accepted advice is merged into a plan,
  quantities and dates are editable, and the plan runs a status machine
  (`open → ordered / cancelled`). Marking a plan ordered writes the audit using the
  **real plan-line quantity** and tags the operator as `system` (a system-driven flow,
  not a merchant row action), and the plan exports its own CSV.

**Supply Chain** (`/app/supply-chain`) is a placeholder — segmented lead times and
supplier shutdown calendars are coming soon and are not yet implemented.

## Data health & guardrails

`/app/data-health` turns the gaps above into an actionable checklist (authorization,
primary location, snapshot freshness, sales history, sync failures, product costs).
Only **critical** items that block advice (missing primary location, no snapshot or a
snapshot older than 48 hours, two consecutive sync failures) put the board into
`paused`: the page stays readable, but the **server recomputes and rejects any
accept/adjust/ignore/mark-ordered action** so stale data can't drive an order. Disabled
buttons are just UX; the server-side rejection is the actual guardrail.

Sync is **non-destructive**: it rebuilds only the window it actually re-reads and
preserves prior demand when orders come back empty or limited, so a single unreadable
sync can no longer wipe a merchant's demand evidence.

## Analytics, feedback & onboarding

Product telemetry, first-run onboarding state and both row-level and store-level
feedback are captured as events and surfaced on the home dashboard and Docs page —
using real recorded data only, never fabricated sample numbers.

## Error handling across SSR/hydration

Read loaders are wrapped by `safeLoader`, which folds a thrown error into a
serializable, classified `Response` (validation / auth / database / shopify_api /
unknown; retryable kinds map to `503`, others to `500`). The top-level `ErrorBoundary`
reads that payload so the server error kind survives hydration without masking the
cause or producing hydration mismatches.

## Data isolation & compliance

App uninstall and shop redact share `purgeShopBusinessData()`, which deletes every
business-data row for that shop (including the `RecommendationAudit` trail) keyed by
`shop`, and logs per-table counts. Scopes-update refreshes the session scope. Customer
data-request / redact webhooks currently only log, because the app stores no customer
data.

## Local development

Prerequisites: Node.js, npm, Shopify CLI, a Dev Dashboard app, a development store, and
a PostgreSQL database.

```sh
npm install
cp .env.example .env
```

- Set `DATABASE_URL` in `.env` to your PostgreSQL connection string. Local dev uses the
  Supabase **session pooler** URI with `?sslmode=require`; the direct `db.<ref>.supabase.co`
  endpoint is IPv6-only and fails with `P1001` from an IPv4-only network. A local
  transparent/HTTPS proxy can hijack the pooler DNS to a fake IP and break connects —
  disable it, or route around it, if `P1001` appears.
- The app is bound to `mypi` in `shopify.app.toml`. To re-link, run `npm run config:link`.

```sh
npm run dev
```

Shopify CLI runs Prisma generate/migrate, starts the dev tunnel and prints the admin
preview link. Current requested scopes are `read_products`, `read_inventory`,
`read_orders`, `read_locations`. After any scope change the test store must re-authorize.
`read_all_orders` is **not** requested, so sales are limited to the last 60 days.

Background worker (pull env first with `shopify app env pull` to get
`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` / `SCOPES`):

```sh
npm run worker
```

On start the worker runs one catch-up snapshot + sales rebuild, then schedules by
`WORKER_SNAPSHOT_CRON` (default: minute 15 every hour) and `WORKER_SALES_CRON`
(default: 03:00 daily); both are overridable in `.env`. Webhook and cron paths require an
offline session: after switching to `useOnlineTokens: false` the test store must
re-authorize once, otherwise the session table has no offline record and both the worker
and webhooks get an empty session.

### Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
shopify app config validate --json
```

## Current boundaries & next phase

- Product selection surfaces the first 50 active variants; pagination/search/filter are
  still to come.
- The board reads the latest snapshot day for the selected location only; store-wide
  multi-location demand analysis is not implemented. Sales are store-wide and not
  attributed per location; refunds/returns are not subtracted.
- Suppliers, purchase plans and CSV export are live; Shopify-native purchase-order
  creation, plan approval workflows, sync-queue/retry panels and segmented supply-chain
  lead times are not.
- Unit tests cover configuration, secret non-leakage, output validation, error
  classification, and every pure module in `app/lib/` (118 tests). Real model calls and
  product write-back for the dormant copy feature still need end-to-end verification
  before that feature is re-enabled.
- Data runs on PostgreSQL (Supabase locally), but production HTTPS domain, platform
  secrets and worker orchestration are not finalized: the current `Dockerfile` runs only
  the web service. Secret management, monitoring, privacy policy, billing and App Store
  review prep remain before a production launch.

mypi is currently a development/beta build; the ephemeral dev tunnel must not be used
for multi-replica production deployments.

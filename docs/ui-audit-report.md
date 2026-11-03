# mypi UI Audit Report (Sprint 0)

Evidence-based audit of every app surface before any Design System work.
Every claim below was verified by reading the actual route/component/style
source in this repo at commit `18e3592`; nothing is inferred from file names.

Status legend (from the refactoring spec §3.3):
NOT IMPLEMENTED · PARTIALLY IMPLEMENTED · IMPLEMENTED BUT INCONSISTENT ·
IMPLEMENTED BUT NOT VERIFIED · VERIFIED

---

## 1. Stack facts (verified)

| Item | Finding |
|---|---|
| Framework | React Router 7.18.2 (framework mode, fs-routes) |
| App Bridge | `@shopify/app-bridge-react` ^4.2.4, wrapped in `app.tsx` `AppProvider` |
| Shopify app SDK | `@shopify/shopify-app-react-router` ^3.0.1 (embedded, offline tokens) |
| Polaris surface | **Polaris Web Components** (`s-*` tags, 23 distinct elements, ~250 usages) typed via `@shopify/polaris-types` 1.0.1. Polaris React is NOT installed. |
| Custom layer | `ds*` class primitives in `dashboard.css` (cards/metrics/tables/pills) + custom app shell in `app-shell.css` |
| Shell | Hand-rolled sidebar nav + topbar + `appOutlet` in `app.tsx`; NOT `s-page`-based |
| Component dir | `app/components/` contains only `feature-disabled.tsx` — no shared component library exists |
| Tokens | `:root` in `app-shell.css` holds 20 color tokens (P1-10). No spacing / typography / radius / shadow / z-index / breakpoint tokens exist anywhere. |
| Feature flags | `PRODUCT_COPY_ENABLED = false` hides Copy & History behind `FeatureDisabledPage` (honest, no fake data) |

## 2. Page audit table

| Page (route) | Current design system | Main UI problems | Functional issues | Priority |
|---|---|---|---|---|
| Home (`app._index`, 596L) | 100% custom `ds*` (84 usages, 0 `s-*`) | Hero/onboarding/metrics panels speak a different visual language from every other page; own button styles (`dsBtnPrimary/dsBtnGhost`); own pills | Content matches spec §7.1 (real metrics, sync freshness, activity, quick actions) — VERIFIED data wiring; no loading feedback | P1 |
| Replenishment (`app.inventory`, 1248L) | Polaris WC (134 `s-*`, `s-table` with listSlots, 10 `s-banner`) | No loading/pending state at all; confidence & stock-status badges only partially on `s-badge`; action buttons mix `s-button` + plain | **Search / sort / pagination missing** (only actionState tab filter + location select). Suggested vs Recorded IS distinguished (spec §7.2 satisfied there) | P0 |
| Purchase Plans (`app.purchase-plans`, 539L) | Mostly Polaris WC (21 `s-*`) | `window.confirm()` for destructive ops (not a standard dialog); status shown as plain text, no badge primitive; **no empty state** | Full lifecycle wired to real DB (create/edit/ordered/cancel/CSV) — VERIFIED | P1 |
| Suppliers (`app.suppliers`, 657L) | Mixed: 7 `s-*` + 2 `ds*` | Two UI systems on one page; `window.confirm()`; form labels use `<label>` without `htmlFor` (implicit association only) | CRUD + deactivate wired; empty state exists | P1 |
| Supply Chain (`app.supply-chain`, 30L) | Custom `ds*` placeholder | Placeholder uses yet another layout idiom | Honest "coming soon", zero fake data — VERIFIED per spec §7.5 | P2 |
| Data Health (`app.data-health`, 267L) | Mixed: 7 `s-*` + 18 `ds*`, raw `<table>` + `dsPill` | Check-status pills rendered by a page-local `dsPill` map — same semantic statuses as inventory but different atoms; raw table instead of shared table primitive | All checks real (auth/locations/freshness/cost/jobs), stale-data banner per spec §7.6 — VERIFIED | P1 |
| Settings (`app.settings`, 433L) | Mostly plain HTML + 3 `s-*` | Page header hierarchy differs from `s-page` pages; save feedback is inline text, not the shared feedback pattern | Validation + real persistence — VERIFIED | P2 |
| Guide & Docs (`app.docs`) | Polaris WC | Heading levels not normalized | Real in-app docs + working feedback form; no fake links | P2 |
| Copy / History (gated) | Polaris WC / raw table | N/A while flag is off; `FeatureDisabledPage` mixes `s-page` + `dsEmptyRow` | Hidden from nav; access refused — VERIFIED | P2 |
| Metrics (`app.metrics`, internal) | Custom `ds*` + raw table | Another bespoke table instance | Real per-shop data only | P2 |
| App shell (`app.tsx`) | Custom `app-shell.css` | 184 hardcoded hex OUTSIDE `:root` in app-shell.css itself; ErrorBoundary card uses 9 inline hex in JS constants; no `:focus` styling anywhere | `aria-current` on nav ✓; error boundary readable & safe — VERIFIED | P1 |

## 3. Cross-cutting findings

### 3.1 Duplicate / competing implementations
- **Three table implementations**: `s-table` (inventory, copy), raw `<table>`+`dsTable` (home, data-health, history, metrics), card-lists inside panels.
- **Three status atoms**: `s-badge` (inventory), `dsPill` + local tone maps (home, data-health), plain text (purchase-plans, suppliers). Same business states (`pending/accepted/edited/ignored/ordered/open/cancelled/running/succeeded/failed`) do NOT render identically everywhere — spec §8.6 violation.
- **Two button idioms**: `s-button` vs `dsBtnPrimary/dsBtnGhost` (home).
- **Two confirm mechanisms**: native `window.confirm` (purchase-plans, suppliers) vs none elsewhere.
- **Page headers**: `s-page heading=` (Polaris pages) vs custom `dsHeroTitle` h1 (home) vs plain h1/h2 (settings, supply-chain).

### 3.2 Tokens & CSS hygiene
- Color: 20 `:root` tokens exist; dashboard.css converged to 83 `var()` usages in P1-10. Still hardcoded: **184 hex in app-shell.css rules**, 55 gradient-shade hex in dashboard.css (deliberately parked for visual review), 9 inline hex in `app.tsx` JS style constants.
- **No spacing scale** (73 ad-hoc px margin/padding/gap decls in dashboard.css alone), **no type scale** (54 px font-size decls), no radius/shadow/z-index tokens.
- Breakpoints disagree: shell 900/680 · dashboard 1180/820/680/560 · spec references 1440/1280/768/390.

### 3.3 Missing UI states (spec §9)
- **Loading: NOT IMPLEMENTED anywhere** — zero `useNavigation`, zero spinner/skeleton. Mutations give no in-flight feedback; double-submit is possible.
- Empty: PARTIALLY IMPLEMENTED (home, suppliers, data-health yes; purchase-plans no).
- Error: route-level VERIFIED (safeLoader channel + ErrorBoundary + banners), but presentation atoms differ per page.
- Stale/partial: VERIFIED (P0-2 freshness banners; partial-sync notes).
- Disabled-with-reason, Permission-denied: NOT IMPLEMENTED as a pattern.

### 3.4 Accessibility (spec §12)
- **No `:focus`/`:focus-visible` styling in any stylesheet** — WCAG 2.2 AA fails on focus indicator for the custom `ds*` layer (Polaris WC handles its own internals).
- No `prefers-reduced-motion` handling in custom CSS.
- Labels: implicit wrapping only; no `htmlFor` anywhere.
- Positives: `aria-current` nav, `aria-hidden` decorative glyphs, Polaris WC native a11y on `s-*` pages.

### 3.5 Data formatting (spec §10)
- `toLocale*`/`toFixed` scattered across 6 files with no shared formatter utility; currency/quantity/date/missing-value formats are per-page decisions — IMPLEMENTED BUT INCONSISTENT.

## 4. Recommended design direction (for confirmation)

Per spec §2.2 ("don't replace the tech stack for visual unity", "don't maintain two competing systems") and the evidence above, the lowest-risk unification is **layered, not a rewrite**:

1. **Polaris Web Components stay the layout & interaction substrate** (`s-page`, `s-section`, `s-box`, `s-table`, `s-banner`, `s-button`, forms). Home migrates onto the same page skeleton.
2. **`ds*` is formalized as the mypi business-primitive layer** (MetricCard, StatusBadge, DataTable fallback) — rebuilt on tokens, consumed inside Polaris layout, never competing with it.
3. **`tokens.css` becomes the single source**: complete the existing 20 color tokens with spacing/typography/radius/shadow/breakpoint/z-index scales; then drain the 184+55+9 remaining hardcoded values.
4. New shared atoms close the state gaps: one StatusBadge (all 12 states), one feedback pattern (loading via `useNavigation` + spinner, empty, error, disabled), one confirm dialog, one formatting utility.
5. No dependency additions (Playwright for tests is the only candidate new tool, spec §16).

Sprints then follow the spec's §15 plan (Sprint 1 foundation → Sprint 2 Replenishment reference → pages → QA).

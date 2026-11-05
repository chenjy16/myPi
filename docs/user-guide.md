# mypi — User Guide

mypi turns your store's own sales and inventory data into **replenishment advice you
can trust and trace**: it tells you what to reorder, how much, and why, then carries
that decision through suppliers and a purchase plan to a CSV you can send off.

Everything is **read-only against Shopify**. mypi never changes your stock levels and
never creates Shopify purchase orders. Order quantities come from **deterministic
math**, not AI — the same inputs always produce the same advice.

> This guide is task-based. Work through it top to bottom the first time, then jump to
> the section you need.

---

## Before you start

- **Open the app from Shopify Admin.** mypi runs embedded in your admin; the left
  navigation has **Home, Replenishment, Purchase Plans, Suppliers, Supply Chain,
  Data Health, Settings**, plus a **Guide & docs** link.
- **Pick an inventory location.** Advice is calculated for one location at a time.
- **Product costs (optional but recommended).** If your Shopify user can't view product
  costs, inventory value is shown as an incomplete estimate and confidence is lowered.
- **Sales history is 60 days for now.** The app doesn't request the restricted
  `read_all_orders` permission, so 90-day history and long-dormant detection are marked
  as unavailable. Demand is still computed correctly from the days you can actually see.
- **After any permission change, re-authorize the app** so it has a valid session.

---

## The workflow at a glance

```
Choose location → Sync → Read advice → Decide (Accept / Edit / Ignore)
   → (optional) set supplier terms → Build a Purchase Plan → Mark ordered → Export CSV
```

Data Health and the background sync keep the numbers fresh and tell you when they can't
be trusted.

---

## 1. Home dashboard

Home shows the real state of your store, not sample numbers:

- **Metric cards** — variants needing attention, adoption of past advice, data freshness.
- **Most urgent suggestions** — the reorder items with the highest risk first.
- **Data Health summary** — whether anything is currently blocking trustworthy advice.
- **Recent decisions** — the last few accept / edit / ignore / ordered actions.

Anything not yet built shows as **"Not enabled yet"** rather than a fake figure.

---

## 2. Replenishment: choose a location and sync

1. Go to **Replenishment**.
2. Select the **active inventory location** you want to plan for.
3. Select **Sync**. mypi reads active variants, sellable and incoming stock at that
   location, and paid orders across the store, then rebuilds daily snapshots and sales.
4. When it finishes, a banner reports **how many variants and orders were synced, how
   many days of history are covered, and how many new suggestions were registered** as
   pending. If nothing new was registered, it says so plainly.

Every variant whose suggested quantity is greater than 0 automatically enters **Pending**.

---

## 3. Reading a suggestion

Each line shows the inputs and the result, with the basis visible:

| Field | Meaning |
| --- | --- |
| **Sales (30/60/90d)** | Units sold in the window, store-wide |
| **Observed demand/day** | Window sales ÷ **visible sample days** (not the window length), so a data gap never looks like "demand dropped" |
| **Available / Incoming** | Sellable and on-the-way stock at the selected location |
| **Coverage days** | How long current stock lasts at the observed rate |
| **Projected stockout** | The date you're expected to run out |
| **Suggested quantity** | `max(0, target stock − available − incoming)`, then rounded up to supplier MOQ / case pack |

**Reorder point** = daily rate × (lead time + safety days).
**Target stock** = daily rate × (lead time + review period + safety days).

### Confidence badge

Each suggestion carries a **Reorder Confidence** badge:

- **high / medium / low**, with expandable downgrade reasons — incomplete sales history,
  snapshot not from today, no sales sample, missing cost, and so on.
- Confidence answers *"how much should I trust this number"*. It **never changes the
  quantity**; it only tells you how solid the inputs are.

---

## 4. Working the Action Board

The board has six states — **All / Pending / Accepted / Edited / Ignored / Ordered** —
plus **Paused** when data is unhealthy. Handle each suggestion:

- **Accept** — keep the suggested quantity.
- **Edit** — set your own quantity (optionally with a reason).
- **Ignore** — dismiss it (optionally with a reason).
- **Mark ordered** — after accepting, record that you actually placed the order. This
  only updates mypi's status and audit trail; it does **not** create anything in Shopify.

Two safeguards:

- **Decision reason** — when you edit or ignore, you can note *why*. It's stored with the
  decision and its audit entry.
- **Double-submit protection** — each action carries a unique request key. Clicking twice
  or a retry is detected and won't create a duplicate entry. Deliberate consecutive
  decisions are each recorded, which is intended.

**Every change is logged.** Each action appends a row to the decision history (previous
and new state, suggested vs. confirmed quantity, confidence snapshot, and who acted).
Because the app uses an offline session, it can only distinguish **system** (registered
by a sync) from **merchant** (an action you took in the app) — it never claims to name a
specific staff member.

---

## 5. When advice is Paused

If a **blocking** data check fails — missing primary location, no snapshot or a snapshot
older than 48 hours, or two consecutive sync failures — the board moves to **Paused**.

- The page stays readable, but mypi **refuses any accept / edit / ignore / mark-ordered
  on the server** so you can't order against stale data.
- Greyed-out buttons are just a hint; the server-side refusal is the real guardrail.
- Fix the failing check on **Data Health**, re-sync, and decisions resume.

---

## 6. Suppliers

Go to **Suppliers** to record who supplies what and on what terms. This is your own data
inside mypi; nothing is written to Shopify.

- **Supplier profile** — name, contact, and an optional **supplier lead time**. When set,
  it overrides the store-wide lead time for that supplier's items.
- **Per-variant terms** — bind a variant to a supplier with:
  - **MOQ (minimum order quantity)** — suggested quantities round up to this.
  - **Case pack** — round up to whole cases when set.
  - **Unit cost** — used for display and purchase plans; it does **not** overwrite your
    Shopify cost record.

Deactivating a supplier removes it from calculations; deleting one unbinds its variants.

---

## 7. Purchase Plans

Accepted and edited advice collects in **Purchase Plans**, where lines are merged per
supplier into a plan.

1. Select **Create plan** from the accepted pool — lines merge by supplier.
2. Review the plan (reference like **PP-0001**). Edit **quantities** and the
   **purchase date** as needed.
3. Move the plan through its states: **open → ordered** (the purchase happened) or
   **open → cancelled**. Ordered and cancelled plans are final — create a new plan if
   something changes.
4. **Export CSV** to send the plan to your supplier.

Plans are **snapshots**: quantities, supplier names and unit costs are stored when the
plan is created, so a plan stays readable even if a supplier is later deleted. When you
mark a plan ordered, the audit records the **real line quantities** and tags the action
as **system** (a system-driven flow, not a per-row merchant click).

> **Supply Chain** (segmented lead times across production, freight, customs, plus
> supplier shutdown calendars) is a placeholder marked *coming soon* — not yet available.

---

## 8. Exporting the reorder CSV

From Replenishment you can export a **27-column reorder CSV** — location, variant, sales,
available/incoming, suggested quantity, confidence and downgrade reasons — for offline
supplier conversations. The file includes a UTF-8 BOM so Excel opens product titles and
other non-ASCII text correctly. Formula-looking cells (`=`, `+`, `-`, `@`) are neutralized
to avoid spreadsheet injection.

---

## 9. Settings

**Settings** holds the store-wide defaults used by the formula:

- **Lead time** (default 14 days), **Safety stock days** (default 7), **Review period**
  (default 14).
- A smaller review period trims suggested quantities; more safety stock raises them.
- Supplier-level lead times and per-variant terms **take precedence** over these defaults.
- Changes apply to advice computed **after you save**; history keeps the values in effect
  at decision time. Until you set them, the app labels these as system estimates.

---

## 10. Data Health

**Data Health** turns every data gap into an actionable checklist:

| Check | Blocks decisions? |
| --- | --- |
| Authorization / order-history access | lowers confidence |
| Primary location selected | **yes** |
| Snapshot freshness (≤ 48h) | **yes** |
| Sales history completeness | lowers confidence |
| Consecutive sync failures (2) | **yes** |
| Product cost readability | lowers confidence |

It also lists the **sync job ledger** (recent jobs, status, last successful run) so you
can see what refreshed and when.

---

## 11. Guide & feedback

The **Guide & docs** page explains how advice is calculated and where your data goes, and
has a **feedback** box for the beta team. For a specific suggestion, the per-line advice
feedback on Replenishment (useful / not useful + a reason) is faster and more useful.

---

## 12. Keeping data fresh automatically

Beyond manual sync, mypi keeps data current on its own:

- A **background worker** refreshes all-location daily snapshots (default: minute 15 each
  hour) and rebuilds the sales window (default: 03:00 in your store timezone).
- **Webhooks** for `inventory_levels/update`, `orders/create` and `orders/cancelled`
  recompute the affected day as things change.
- Sync is **non-destructive**: it rebuilds only the window it actually re-reads and keeps
  prior demand when orders come back empty or limited, so one unreadable sync can't wipe
  your demand history.

---

## Data, privacy & permissions

- **Read-only scopes**: products, inventory, orders, locations. Nothing is written back
  to your store.
- **What mypi stores**: inventory snapshots, sales counts, your settings, supplier
  records, accepted decisions, purchase plans, decision audit history, and per-shop usage
  events that power activation and advice-quality metrics during the beta. Feedback notes
  are stored with your shop domain so the team can follow up.
- **No customer data** is stored; customer data-request/redact webhooks only acknowledge.
- **Tenant isolation**: everything is keyed by shop. **Uninstalling the app deletes every
  record tied to your shop**, including the audit trail.

---

## Tips, limits & FAQ

- **Everything lands in "stockout"?** If your test store has no available stock (mypi
  can't write inventory to fake it), advice will all point to reorder. You need real
  on-hand stock to see healthy coverage.
- **Only 60 days of sales?** Expected — `read_all_orders` isn't requested. 90-day views
  are marked unavailable rather than guessed.
- **Refunds aren't subtracted.** Sales count paid / partially refunded / refunded order
  lines by processed date; returns don't reduce the figure.
- **Inventory is per location, sales are store-wide.** A location's advice uses its own
  stock but demand from the whole store.
- **"Who did this?"** The audit can only say *system* or *merchant*, never a named
  employee, because sessions are offline.
- **Product copy / history** pages are currently disabled and hidden; the app no longer
  requests product write access.

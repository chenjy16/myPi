import assert from "node:assert/strict";
import test from "node:test";

import {
  STATUS_TONE,
  STATUS_LABEL,
  HEALTH_TONE,
  HEALTH_LABEL,
  TONE_CLASS,
  POLARIS_BADGE_TONE,
  statusView,
  healthView,
  actionStateView,
  confidenceView,
  syncStatusView,
  inventoryStatusView,
  isBusinessState,
  type BusinessState,
  type HealthTone,
  type StatusTone,
} from "../app/lib/status.ts";
import { INVENTORY_STATUS_LABELS } from "../app/lib/inventory-calculations.ts";
import type { InventoryHealthStatus } from "../app/lib/inventory-calculations.ts";
import type { ActionBoardState } from "../app/lib/reorder-action-board.ts";
import type { ReorderConfidenceLevel } from "../app/lib/reorder-confidence.ts";
import type { SyncStatusName } from "../app/lib/sync-job-policy.ts";

const ALL_STATES: BusinessState[] = [
  "pending",
  "accepted",
  "edited",
  "ignored",
  "ordered",
  "open",
  "cancelled",
  "running",
  "succeeded",
  "partial",
  "failed",
  "paused",
];

const ALL_HEALTH: HealthTone[] = ["ok", "warn", "critical"];

test("every business state resolves to a tone, a label and a pill class", () => {
  for (const state of ALL_STATES) {
    const view = statusView(state);
    assert.ok(STATUS_TONE[state], `${state} has a tone`);
    assert.equal(view.label, STATUS_LABEL[state]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
});

test("failure semantics are critical, success semantics are success", () => {
  assert.equal(statusView("failed").tone, "critical");
  assert.equal(statusView("succeeded").tone, "success");
  assert.equal(statusView("ordered").tone, "success");
  assert.equal(statusView("partial").tone, "warning");
  assert.equal(statusView("running").tone, "info");
  assert.equal(statusView("pending").tone, "neutral");
});

test("health tones anchor the existing DataHealthTone vocabulary", () => {
  for (const tone of ALL_HEALTH) {
    const view = healthView(tone);
    assert.equal(view.label, HEALTH_LABEL[tone]);
    assert.equal(view.className, TONE_CLASS[HEALTH_TONE[tone]]);
  }
  assert.equal(healthView("ok").tone, "success");
  assert.equal(healthView("critical").tone, "critical");
});

test("labels never rely on color alone (every state has visible text)", () => {
  for (const state of ALL_STATES) {
    const view = statusView(state);
    assert.ok(view.label.length > 0, `${state} renders a non-empty label`);
    assert.notEqual(view.label, state, `${state} is humanized`);
  }
});

const ACTION_BOARD: ActionBoardState[] = [
  "paused",
  "pending",
  "accepted",
  "edited",
  "ignored",
  "ordered",
];

test("action board badges speak the same words as the tabs, CSV and audit", () => {
  for (const state of ACTION_BOARD) {
    const view = actionStateView(state);
    assert.equal(view.label, STATUS_LABEL[state]);
    assert.equal(view.className, TONE_CLASS[STATUS_TONE[state]]);
  }
});

test("every semantic tone has a legal Polaris badge tone (warning becomes caution)", () => {
  const allowed = ["neutral", "info", "success", "caution", "critical"];
  for (const tone of Object.keys(TONE_CLASS) as StatusTone[]) {
    assert.ok(allowed.includes(POLARIS_BADGE_TONE[tone]), `${tone} maps legally`);
  }
  assert.equal(POLARIS_BADGE_TONE.warning, "caution");
});

const CONFIDENCE_LEVELS: ReorderConfidenceLevel[] = ["high", "medium", "low"];

test("confidence always pairs a label with a directional tone", () => {
  for (const level of CONFIDENCE_LEVELS) {
    const view = confidenceView(level);
    assert.match(view.label, /confidence$/);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
  assert.equal(confidenceView("high").tone, "success");
  assert.equal(confidenceView("low").tone, "critical");
});

const SYNC_STATES: SyncStatusName[] = ["never", "running", "succeeded", "failed"];

test("sync status keeps the four documented merchant-facing labels", () => {
  assert.equal(syncStatusView("never").label, "Never synced");
  assert.equal(syncStatusView("succeeded").label, "Up to date");
  assert.equal(syncStatusView("failed").label, "Last sync failed");
  for (const state of SYNC_STATES) {
    assert.equal(syncStatusView(state).className, TONE_CLASS[syncStatusView(state).tone]);
  }
});

const INVENTORY_STATUSES: InventoryHealthStatus[] = [
  "stockout",
  "critical",
  "stockout_risk",
  "low_stock",
  "healthy",
  "overstock",
  "dead_stock",
  "no_sales",
];

test("inventory status reuses the calculation module wording, only adds tone", () => {
  for (const status of INVENTORY_STATUSES) {
    const view = inventoryStatusView(status);
    assert.equal(view.label, INVENTORY_STATUS_LABELS[status]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
  assert.equal(inventoryStatusView("stockout").tone, "critical");
  assert.equal(inventoryStatusView("low_stock").tone, "warning");
  assert.equal(inventoryStatusView("healthy").tone, "success");
  assert.equal(inventoryStatusView("dead_stock").tone, "neutral");
});

test("unknown audit status stays plain text instead of being swallowed by a badge", () => {
  assert.ok(isBusinessState("pending"));
  assert.ok(isBusinessState("paused"));
  assert.ok(!isBusinessState("suggestion_created"));
  assert.ok(!isBusinessState(null));
  assert.ok(!isBusinessState(undefined));
});

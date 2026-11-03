import assert from "node:assert/strict";
import test from "node:test";

import {
  STATUS_TONE,
  STATUS_LABEL,
  HEALTH_TONE,
  HEALTH_LABEL,
  TONE_CLASS,
  POLARIS_BADGE_TONE,
  DATA_HEALTH_STATE_LABEL,
  READINESS_LABEL,
  statusView,
  healthView,
  actionStateView,
  confidenceView,
  syncStatusView,
  inventoryStatusView,
  dataHealthStateView,
  readinessView,
  freshnessBannerTone,
  isBusinessState,
  SUPPLIER_ACTIVITY_LABEL,
  supplierActivityView,
  planStatusView,
  type BusinessState,
  type HealthTone,
  type StatusTone,
  type SettingReadiness,
  type SupplierActivity,
} from "../app/lib/status.ts";
import {
  PURCHASE_PLAN_STATUS_LABELS,
  type PurchasePlanStatus,
} from "../app/lib/purchase-plans.ts";
import { INVENTORY_STATUS_LABELS } from "../app/lib/inventory-calculations.ts";
import type { InventoryHealthStatus } from "../app/lib/inventory-calculations.ts";
import type { ActionBoardState } from "../app/lib/reorder-action-board.ts";
import type { DataHealthState } from "../app/lib/data-health.ts";
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

const DATA_HEALTH_STATES: DataHealthState[] = ["healthy", "degraded", "paused"];

test("data health state keeps the three merchant-facing sentences and their severity", () => {
  for (const state of DATA_HEALTH_STATES) {
    const view = dataHealthStateView(state);
    assert.equal(view.label, DATA_HEALTH_STATE_LABEL[state]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
  assert.equal(dataHealthStateView("healthy").tone, "success");
  assert.equal(dataHealthStateView("degraded").tone, "warning");
  // paused 是「别照着建议下单」的阻断态，不能只显示成黄色提醒
  assert.equal(dataHealthStateView("paused").tone, "critical");
});

const READINESS_KINDS: SettingReadiness[] = [
  "configured",
  "needsSetup",
  "available",
  "storeSettings",
  "systemEstimate",
  "notEnabled",
];

test("readiness badges cover every Settings state with legal Polaris tones", () => {
  const allowed = ["neutral", "info", "success", "caution", "critical"];
  for (const kind of READINESS_KINDS) {
    const view = readinessView(kind);
    assert.equal(view.label, READINESS_LABEL[kind]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
    assert.ok(
      allowed.includes(POLARIS_BADGE_TONE[view.tone]),
      `${kind} renders a legal badge tone`,
    );
    assert.ok(view.label.length > 0);
  }
  // 「系统估算」不是错误，不能染成警告色让商家以为参数坏了
  assert.equal(readinessView("systemEstimate").tone, "neutral");
  assert.equal(readinessView("needsSetup").tone, "warning");
});

test("sync freshness only raises a banner when there is something to say", () => {
  assert.equal(freshnessBannerTone("ok"), null);
  assert.equal(freshnessBannerTone("warn"), "warning");
  assert.equal(freshnessBannerTone("critical"), "critical");
  // muted（从未同步这类中性事实）用 info，不给商家一个假告警
  assert.equal(freshnessBannerTone("muted"), "info");
});

const SUPPLIER_ACTIVITY_KINDS: SupplierActivity[] = ["active", "paused"];

test("supplier pause is neutral, not the warning/critical used by decision pauses", () => {
  for (const kind of SUPPLIER_ACTIVITY_KINDS) {
    const view = supplierActivityView(kind);
    assert.equal(view.label, SUPPLIER_ACTIVITY_LABEL[kind]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
  assert.equal(supplierActivityView("active").tone, "success");
  // 停用供应商是商家的正常选择，不是数据出问题，不能染成 warning/critical
  assert.equal(supplierActivityView("paused").tone, "neutral");
});

const PURCHASE_PLAN_STATUSES: PurchasePlanStatus[] = [
  "open",
  "ordered",
  "cancelled",
];

test("purchase plan status reuses the shared vocabulary and tone, not a page map", () => {
  for (const status of PURCHASE_PLAN_STATUSES) {
    const view = planStatusView(status);
    // 文案与状态机那份完全一致，避免 UI 与服务端各说一套
    assert.equal(view.label, PURCHASE_PLAN_STATUS_LABELS[status]);
    assert.equal(view.label, STATUS_LABEL[status]);
    assert.equal(view.tone, STATUS_TONE[status]);
    assert.equal(view.className, TONE_CLASS[view.tone]);
  }
});

test("an unrecognised plan status is shown verbatim instead of swallowed", () => {
  const view = planStatusView("archived-by-a-migration");
  assert.equal(view.label, "archived-by-a-migration");
  assert.equal(view.tone, "neutral");
  assert.equal(view.className, TONE_CLASS.neutral);
});

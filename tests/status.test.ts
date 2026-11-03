import assert from "node:assert/strict";
import test from "node:test";

import {
  STATUS_TONE,
  STATUS_LABEL,
  HEALTH_TONE,
  HEALTH_LABEL,
  TONE_CLASS,
  statusView,
  healthView,
  type BusinessState,
  type HealthTone,
} from "../app/lib/status.ts";

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

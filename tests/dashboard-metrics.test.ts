import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDashboardMetrics,
  windowStart,
  MAX_ACTIVE_ROWS,
  MAX_RECENT_ROWS,
  type BuildInput,
} from "../app/lib/dashboard-metrics.ts";
import type { AutomationListItem } from "../app/lib/automations-core.ts";
import type { ExecutionSummary } from "../app/lib/activity.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");

function auto(
  over: Partial<AutomationListItem> & { id: string; name: string },
): AutomationListItem {
  return {
    status: "active",
    triggerType: "inventory.low",
    currentVersion: 1,
    templateId: null,
    actionIds: ["tags.add"],
    updatedAt: NOW,
    ...over,
  } as AutomationListItem;
}

function mkExecution(over: Partial<ExecutionSummary> & { id: string; automationId: string }): ExecutionSummary {
  return {
    automationVersion: 1,
    triggerType: "inventory.low",
    entityRef: null,
    status: "SUCCESS",
    cascadeDepth: 0,
    createdAt: new Date(NOW.getTime() - 60_000),
    parentExecutionId: null,
    ...over,
  } as ExecutionSummary;
}

function base(over: Partial<BuildInput> = {}): BuildInput {
  return {
    automations: [],
    recentExecutions: [],
    totalExecutions: 0,
    statusCounts24h: {},
    triggerLabel: (t) => (t ? `when:${t}` : "—"),
    automationNameById: new Map(),
    now: NOW,
    ...over,
  };
}

test("空店铺装配出诚实 KPI：全零 + successRate=null（不谎报 100%）", () => {
  const out = buildDashboardMetrics(base());
  assert.equal(out.hasAutomations, false);
  assert.equal(out.kpis.activeAutomations, 0);
  assert.equal(out.kpis.totalExecutions, 0);
  assert.equal(out.kpis.successRate.rate, null);
  assert.equal(out.kpis.failedExecutions24h, 0);
  assert.deepEqual(out.activeAutomations, []);
  assert.deepEqual(out.recentActivity, []);
});

test("SKIPPED / RUNNING / RETRYING 不进成功率分母（与 P4-17 health 同口径）", () => {
  const out = buildDashboardMetrics(
    base({
      statusCounts24h: {
        SUCCESS: 3,
        FAILED: 1,
        PARTIAL_SUCCESS: 0,
        SKIPPED: 100,
        RUNNING: 5,
        RETRYING: 2,
      },
    }),
  );
  // 分母 = SUCCESS + FAILED + PARTIAL = 4；rate = 3/4 = 0.75
  assert.equal(out.kpis.successRate.terminalTotal, 4);
  assert.equal(out.kpis.successRate.rate, 0.75);
  assert.equal(out.kpis.failedExecutions24h, 1);
});

test("Active Automations 只保留 status=active 的规则；paused/draft/deleted 被过滤", () => {
  const out = buildDashboardMetrics(
    base({
      automations: [
        auto({ id: "a1", name: "A1", status: "active" }),
        auto({ id: "a2", name: "A2", status: "paused" }),
        auto({ id: "a3", name: "A3", status: "draft" }),
        auto({ id: "a4", name: "A4", status: "active" }),
      ],
    }),
  );
  assert.equal(out.kpis.activeAutomations, 2);
  assert.deepEqual(
    out.activeAutomations.map((r) => r.id).sort(),
    ["a1", "a4"],
  );
});

test("每自动化 executions/successRate/lastRun 从 recentExecutions 聚合而来，无终态样本 rate=null", () => {
  const a1Runs = [
    mkExecution({ id: "e1", automationId: "a1", status: "SUCCESS", createdAt: new Date(NOW.getTime() - 1000) }),
    mkExecution({ id: "e2", automationId: "a1", status: "FAILED", createdAt: new Date(NOW.getTime() - 2000) }),
    mkExecution({ id: "e3", automationId: "a1", status: "SUCCESS", createdAt: new Date(NOW.getTime() - 3000) }),
  ];
  const a2Runs = [
    // 只 SKIPPED，无终态样本
    mkExecution({ id: "e4", automationId: "a2", status: "SKIPPED" }),
  ];
  const out = buildDashboardMetrics(
    base({
      automations: [
        auto({ id: "a1", name: "A1" }),
        auto({ id: "a2", name: "A2" }),
      ],
      recentExecutions: [...a1Runs, ...a2Runs],
      automationNameById: new Map([
        ["a1", "A1"],
        ["a2", "A2"],
      ]),
    }),
  );
  const a1 = out.activeAutomations.find((r) => r.id === "a1")!;
  assert.equal(a1.executions, 3);
  assert.equal(a1.successRate, 2 / 3);
  assert.equal(a1.lastRun?.status, "SUCCESS");

  const a2 = out.activeAutomations.find((r) => r.id === "a2")!;
  assert.equal(a2.executions, 1);
  assert.equal(a2.successRate, null);
});

test("Active 列表按 lastRun createdAt desc 排序；未跑过的落到末尾", () => {
  const recent = [
    mkExecution({ id: "e1", automationId: "a1", createdAt: new Date(NOW.getTime() - 5000) }),
    mkExecution({ id: "e2", automationId: "a2", createdAt: new Date(NOW.getTime() - 1000) }),
  ];
  const out = buildDashboardMetrics(
    base({
      automations: [
        auto({ id: "a1", name: "A1" }),
        auto({ id: "a2", name: "A2" }),
        auto({ id: "a3", name: "A3" }), // 从未跑
      ],
      recentExecutions: recent.sort((l, r) => r.createdAt.getTime() - l.createdAt.getTime()),
    }),
  );
  assert.deepEqual(
    out.activeAutomations.map((r) => r.id),
    ["a2", "a1", "a3"],
  );
});

test("Active 首屏最多 5 条（MAX_ACTIVE_ROWS），Recent 最多 10 条（MAX_RECENT_ROWS）", () => {
  const autos = Array.from({ length: 10 }, (_, i) =>
    auto({ id: `a${i}`, name: `A${i}` }),
  );
  const runs = Array.from({ length: 30 }, (_, i) =>
    mkExecution({ id: `e${i}`, automationId: `a${i % 10}`, createdAt: new Date(NOW.getTime() - i * 1000) }),
  );
  const out = buildDashboardMetrics(
    base({ automations: autos, recentExecutions: runs }),
  );
  assert.equal(out.activeAutomations.length, MAX_ACTIVE_ROWS);
  assert.equal(out.recentActivity.length, MAX_RECENT_ROWS);
});

test("Recent 行取自动化名；找不到（已删自动化）时诚实标 Removed 而非空白", () => {
  const out = buildDashboardMetrics(
    base({
      recentExecutions: [mkExecution({ id: "e1", automationId: "gone" })],
      automationNameById: new Map(),
    }),
  );
  assert.equal(out.recentActivity[0].automationName, "Removed automation");
});

test("windowStart 计算 = now - windowMs（server 用来生成 since 参数）", () => {
  const since = windowStart(NOW, 24 * 60 * 60 * 1000);
  assert.equal(NOW.getTime() - since.getTime(), 24 * 60 * 60 * 1000);
});

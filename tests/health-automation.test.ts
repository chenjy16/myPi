import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAutomationHealth,
  computeSuccessRate,
  heartbeatAgeMs,
  interpretHeartbeat,
  parseAutomationQueryTimeoutMs,
  parseHeartbeatStaleMs,
  parseMetricWindowMs,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_METRIC_WINDOW_MS,
  type AutomationHealthInput,
} from "../app/lib/health-automation.ts";
import {
  collectAutomationHealth,
  type AutomationHealthClient,
} from "../app/health-automation.server.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");

test("computeSuccessRate：只数终态执行，SKIPPED/在途不计入分母", () => {
  const r = computeSuccessRate({
    SUCCESS: 8,
    FAILED: 1,
    PARTIAL_SUCCESS: 1,
    SKIPPED: 50,
    RUNNING: 3,
    RETRYING: 2,
  });
  assert.equal(r.terminalTotal, 10);
  assert.equal(r.succeeded, 8);
  assert.ok(Math.abs((r.rate ?? 0) - 0.8) < 1e-9);
});

test("computeSuccessRate：无终态样本 rate 为 null（不谎报 100%）", () => {
  const r = computeSuccessRate({ SKIPPED: 5, RUNNING: 1 });
  assert.equal(r.rate, null);
  assert.equal(r.terminalTotal, 0);
});

test("heartbeatAgeMs：无时间戳 null；时钟回拨钳 0；正常给差值", () => {
  assert.equal(heartbeatAgeMs(NOW, null), null);
  assert.equal(heartbeatAgeMs(NOW, undefined), null);
  assert.equal(heartbeatAgeMs(NOW, new Date(NOW.getTime() + 5000)), 0);
  assert.equal(heartbeatAgeMs(NOW, new Date(NOW.getTime() - 60_000)), 60_000);
});

test("interpretHeartbeat：null→unknown，阈值内→fresh，超阈→stale", () => {
  assert.equal(interpretHeartbeat(null), "unknown");
  assert.equal(interpretHeartbeat(5000), "fresh");
  assert.equal(interpretHeartbeat(DEFAULT_HEARTBEAT_STALE_MS), "fresh");
  assert.equal(interpretHeartbeat(DEFAULT_HEARTBEAT_STALE_MS + 1), "stale");
});

test("buildAutomationHealth：查询降级（null）映射为 unknown 快照，绝不抛", () => {
  const h = buildAutomationHealth({
    windowMs: DEFAULT_METRIC_WINDOW_MS,
    heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
    now: NOW,
    queueDepth: null,
    statusCounts: null,
    awaitingConfirmation: null,
    lastHeartbeatAt: null,
  } satisfies AutomationHealthInput);
  assert.equal(h.windowSeconds, 86400);
  assert.equal(h.queueDepth, null);
  assert.equal(h.executionSuccess, null);
  assert.equal(h.awaitingConfirmation, null);
  assert.equal(h.heartbeat.status, "unknown");
  assert.equal(h.heartbeat.lastRunAt, null);
});

test("buildAutomationHealth：全量数据折成可读快照", () => {
  const lastRun = new Date(NOW.getTime() - 3 * 60_000);
  const h = buildAutomationHealth({
    windowMs: DEFAULT_METRIC_WINDOW_MS,
    heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
    now: NOW,
    queueDepth: 7,
    statusCounts: { SUCCESS: 9, FAILED: 1 },
    awaitingConfirmation: 2,
    lastHeartbeatAt: lastRun,
  });
  assert.equal(h.queueDepth, 7);
  assert.equal(h.awaitingConfirmation, 2);
  assert.equal(h.executionSuccess?.terminalTotal, 10);
  assert.equal(h.heartbeat.status, "fresh");
  assert.equal(h.heartbeat.lastRunAt, lastRun.toISOString());
  assert.equal(h.heartbeat.ageMs, 180_000);
});

test("parse*：缺省回退安全默认，非法回退，越界钳上界", () => {
  assert.equal(parseMetricWindowMs({}), DEFAULT_METRIC_WINDOW_MS);
  assert.equal(parseMetricWindowMs({ HEALTH_AUTOMATION_WINDOW_MS: "abc" }), DEFAULT_METRIC_WINDOW_MS);
  assert.equal(parseMetricWindowMs({ HEALTH_AUTOMATION_WINDOW_MS: "60000" }), 60_000);
  assert.equal(parseMetricWindowMs({ HEALTH_AUTOMATION_WINDOW_MS: "999999999999" }), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseHeartbeatStaleMs({}), DEFAULT_HEARTBEAT_STALE_MS);
  assert.equal(parseHeartbeatStaleMs({ HEALTH_WORKER_HEARTBEAT_STALE_MS: "1000" }), 1000);
  assert.equal(parseAutomationQueryTimeoutMs({ HEALTH_AUTOMATION_QUERY_TIMEOUT_MS: "-5" }), 2000);
  assert.equal(parseAutomationQueryTimeoutMs({ HEALTH_AUTOMATION_QUERY_TIMEOUT_MS: "99999" }), 8000);
});

// —— 绑库编排面 collectAutomationHealth：假 client 实证降级与聚合 ——

test("collectAutomationHealth：真实计数聚合为可读快照", async () => {
  const lastRun = new Date(NOW.getTime() - 60_000);
  const client = {
    dataSyncJob: { count: async () => 3 },
    executionLog: {
      groupBy: async () => [
        { status: "SUCCESS", _count: { _all: 9 } },
        { status: "FAILED", _count: { _all: 1 } },
        { status: "SKIPPED", _count: { _all: 5 } },
      ],
    },
    executionStep: { count: async () => 2 },
    scheduledJob: { aggregate: async () => ({ _max: { lastRunAt: lastRun } }) },
  } as unknown as AutomationHealthClient;

  const h = await collectAutomationHealth(client, {
    now: NOW,
    windowMs: DEFAULT_METRIC_WINDOW_MS,
    heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
    queryTimeoutMs: 1000,
  });
  assert.equal(h.queueDepth, 3);
  assert.equal(h.awaitingConfirmation, 2);
  assert.equal(h.executionSuccess?.succeeded, 9);
  assert.equal(h.executionSuccess?.terminalTotal, 10, "SKIPPED 不入分母");
  assert.equal(h.heartbeat.status, "fresh");
  assert.equal(h.heartbeat.lastRunAt, lastRun.toISOString());
});

test("collectAutomationHealth：单查询抛错只降级该字段，其余照常", async () => {
  const client = {
    dataSyncJob: { count: async () => 1 },
    // groupBy 抛错 → statusCounts 应为 null，但不拖垮整体
    executionLog: { groupBy: async () => { throw new Error("boom"); } },
    executionStep: { count: async () => 0 },
    scheduledJob: { aggregate: async () => ({ _max: { lastRunAt: null } }) },
  } as unknown as AutomationHealthClient;

  const h = await collectAutomationHealth(client, {
    now: NOW,
    windowMs: DEFAULT_METRIC_WINDOW_MS,
    heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
    queryTimeoutMs: 1000,
  });
  assert.equal(h.queueDepth, 1);
  assert.equal(h.executionSuccess, null, "抛错的维度降级为 null");
  assert.equal(h.heartbeat.status, "unknown");
});

test("collectAutomationHealth：查询超时→对应字段降级 unknown", async () => {
  const client = {
    // 永不 resolve → 命中超时护栏
    dataSyncJob: { count: () => new Promise<number>(() => {}) },
    executionLog: { groupBy: async () => [] },
    executionStep: { count: async () => 0 },
    scheduledJob: { aggregate: async () => ({ _max: { lastRunAt: null } }) },
  } as unknown as AutomationHealthClient;

  const h = await collectAutomationHealth(client, {
    now: NOW,
    windowMs: DEFAULT_METRIC_WINDOW_MS,
    heartbeatStaleMs: DEFAULT_HEARTBEAT_STALE_MS,
    queryTimeoutMs: 20,
  });
  assert.equal(h.queueDepth, null, "超时降级");
});

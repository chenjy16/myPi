import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANALYTICS_EVENT_TYPES,
  collectActiveUtcDays,
  computeBetaMetrics,
  decisionEventType,
  earliestInstallAt,
  formatRate,
  humanizeDurationMs,
  isAnalyticsEventType,
  isRetainedOnDay,
  isWeeklyActiveShop,
  resolveFeedbackChoice,
  shouldTrackToday,
  validateFeedbackComment,
  type AnalyticsEventRow,
} from "../app/lib/analytics.ts";

function event(
  type: AnalyticsEventRow["type"],
  createdAt: Date,
  props: Record<string, unknown> | null = null,
): AnalyticsEventRow {
  return { type, createdAt, props };
}

const DAY = 24 * 60 * 60 * 1000;

test("事件清单恰好 13 类且无重复；清单外一律非法", () => {
  assert.equal(ANALYTICS_EVENT_TYPES.length, 13);
  assert.equal(
    new Set(ANALYTICS_EVENT_TYPES).size,
    ANALYTICS_EVENT_TYPES.length,
    "event types must be unique",
  );
  assert.equal(isAnalyticsEventType("sync_completed"), true);
  assert.equal(isAnalyticsEventType("page_loaded"), false);
});

test("决策映射：四个人工动作各有事件，pending 不记", () => {
  assert.equal(decisionEventType("accepted"), "advice_accepted");
  assert.equal(decisionEventType("edited"), "advice_edited");
  assert.equal(decisionEventType("ignored"), "advice_ignored");
  assert.equal(decisionEventType("ordered"), "advice_ordered");
  assert.equal(decisionEventType("pending"), null);
});

test("按天去重：同一 UTC 天不重复记，跨天要记", () => {
  const morning = new Date("2026-11-02T01:00:00Z");
  const evening = new Date("2026-11-02T23:30:00Z");
  const nextDay = new Date("2026-11-03T00:10:00Z");
  assert.equal(shouldTrackToday(null, morning), true);
  assert.equal(shouldTrackToday(morning, evening), false);
  assert.equal(shouldTrackToday(evening, nextDay), true);
});

test("Beta 指标：activation、TTFV、adoption、sync 成功率一起从事件行推出", () => {
  const installedAt = new Date("2026-11-01T09:00:00Z");
  const events = [
    event("app_installed", installedAt),
    event("sync_completed", new Date("2026-11-01T09:30:00Z"), {
      outcome: "failed",
    }),
    event("sync_completed", new Date("2026-11-01T10:00:00Z"), {
      outcome: "success",
    }),
    event("advice_accepted", new Date("2026-11-02T08:00:00Z")),
    event("advice_edited", new Date("2026-11-02T08:05:00Z")),
    event("advice_ignored", new Date("2026-11-02T08:06:00Z")),
  ];
  const metrics = computeBetaMetrics(events, installedAt);
  assert.equal(metrics.activated, true);
  assert.equal(metrics.timeToFirstValueMs, DAY - 60 * 60 * 1000);
  assert.equal(metrics.decisionCount, 3);
  assert.equal(metrics.adoptionRate, 2 / 3);
  assert.equal(metrics.syncSuccessRate, 1 / 2);
});

test("指标缺数据时给 null 而不是 0：没决策、没同步、没安装锚点", () => {
  const metrics = computeBetaMetrics([], null);
  assert.equal(metrics.activated, false);
  assert.equal(metrics.timeToFirstValueMs, null);
  assert.equal(metrics.adoptionRate, null);
  assert.equal(metrics.decisionCount, 0);
  assert.equal(metrics.syncSuccessRate, null);
});

test("安装之前的 accept 不算 TTFV，负数时长不出现", () => {
  const installedAt = new Date("2026-11-05T00:00:00Z");
  const metrics = computeBetaMetrics(
    [event("advice_accepted", new Date("2026-11-01T00:00:00Z"))],
    installedAt,
  );
  assert.equal(metrics.timeToFirstValueMs, null);
});

test("周活：窗口内看过看板才算，窗口外的活跃不算", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  assert.equal(
    isWeeklyActiveShop(
      [event("dashboard_viewed", new Date(now.getTime() - 3 * DAY))],
      now,
    ),
    true,
  );
  assert.equal(
    isWeeklyActiveShop(
      [event("dashboard_viewed", new Date(now.getTime() - 9 * DAY))],
      now,
    ),
    false,
  );
});

test("留存：安装日为第 0 天，锚点缺失返回 null 不判流失", () => {
  const installedAt = new Date("2026-11-01T15:00:00Z");
  const day7 = new Date("2026-11-08T02:00:00Z");
  assert.equal(isRetainedOnDay(installedAt, [day7], 7), true);
  assert.equal(
    isRetainedOnDay(installedAt, [new Date("2026-11-09T02:00:00Z")], 7),
    false,
  );
  assert.equal(isRetainedOnDay(null, [day7], 7), null);
});

test("反馈下拉值推导 verdict/reason；清单外拒绝", () => {
  assert.deepEqual(resolveFeedbackChoice("useful" as FormDataEntryValue), {
    verdict: "useful",
    reason: null,
  });
  assert.deepEqual(
    resolveFeedbackChoice("too_high" as FormDataEntryValue),
    { verdict: "not_useful", reason: "too_high" },
  );
  assert.equal(resolveFeedbackChoice("maybe" as FormDataEntryValue), null);
  assert.equal(resolveFeedbackChoice(null), null);
});

test("反馈备注：空为 null、500 字内通过、超长给 undefined", () => {
  assert.equal(validateFeedbackComment(null), null);
  assert.equal(validateFeedbackComment("   " as FormDataEntryValue), null);
  assert.equal(
    validateFeedbackComment(" costs look stale " as FormDataEntryValue),
    "costs look stale",
  );
  const long = "x".repeat(501) as FormDataEntryValue;
  assert.equal(validateFeedbackComment(long), undefined);
});

test("earliestInstallAt 取最早一条安装；没有安装事件返回 null 不猜锚点", () => {
  assert.equal(earliestInstallAt([]), null);
  assert.equal(
    earliestInstallAt([event("dashboard_viewed", new Date("2026-01-05T00:00:00Z"))]),
    null,
  );
  const events = [
    event("app_installed", new Date("2026-01-10T09:00:00Z")),
    event("app_installed", new Date("2026-01-03T01:00:00Z")),
  ];
  assert.equal(earliestInstallAt(events)?.toISOString(), "2026-01-03T01:00:00.000Z");
});

test("collectActiveUtcDays 按 UTC 天去重，且只认 dashboard_viewed 心跳", () => {
  const events = [
    event("dashboard_viewed", new Date("2026-02-01T03:00:00Z")),
    event("dashboard_viewed", new Date("2026-02-01T22:00:00Z")), // 同一天，应被去掉
    event("dashboard_viewed", new Date("2026-02-02T05:00:00Z")),
    event("sync_completed", new Date("2026-02-03T05:00:00Z")), // 非心跳，不计
  ];
  const days = collectActiveUtcDays(events);
  assert.equal(days.length, 2);
  assert.deepEqual(
    days.map((d) => d.toISOString().slice(0, 10)),
    ["2026-02-01", "2026-02-02"],
  );
});

test("humanizeDurationMs 最多两个单位；null/负数一律破折号不编造", () => {
  assert.equal(humanizeDurationMs(null), "—");
  assert.equal(humanizeDurationMs(-5), "—");
  assert.equal(humanizeDurationMs(45_000), "45s");
  assert.equal(humanizeDurationMs(90_000), "1m 30s");
  assert.equal(humanizeDurationMs(3_600_000), "1h");
  assert.equal(humanizeDurationMs(2 * 86_400_000 + 3 * 3_600_000), "2d 3h");
});

test("formatRate 折百分比；null 分母给破折号而非 0%", () => {
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(0), "0%");
  assert.equal(formatRate(0.5), "50%");
  assert.equal(formatRate(0.333), "33%");
});

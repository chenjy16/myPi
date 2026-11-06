/**
 * 产品埋点的单一事实源：事件清单、反馈取值、以及从事件行推导 Beta 指标的纯函数。
 * 一切写库与查询在 analytics.server.ts；这里只定义「什么算合法事件」和「指标怎么算」，
 * 保证 stage 7 出报告时用的公式和现在收集数据的口径是同一份。
 * 以 .ts 扩展名被 server 层与 node --test 共用。
 */

/** Beta 需要的 17 类事件；新增要先想清楚对应哪个指标，不加「顺手记录」。 */
export const ANALYTICS_EVENT_TYPES = [
  "app_installed",
  "dashboard_viewed",
  "inventory_sync_started",
  "sync_completed",
  "onboarding_completed",
  "settings_saved",
  "supplier_saved",
  "recommendation_viewed",
  "advice_accepted",
  "advice_edited",
  "advice_ignored",
  "advice_ordered",
  "csv_exported",
  "purchase_plan_created",
  "purchase_plan_ordered",
  "purchase_plan_exported",
  "feedback_submitted",
  // 自动化（Phase 3）：关键商家动作埋点，与 UI 反馈同源。
  "automation_created_from_template",
  "automation_updated",
  "automation_status_changed",
  "automation_step_confirmed",
  "automation_retried",
  "integration_saved",
  "integration_tested",
  // 自动化引擎执行维度（Phase 4 · P4-20）：shop 级、无 PII 的运行态势，供 health/告警取数。
  // 与商家动作埋点分开——这些是引擎收尾处旁路记录，口径见 docs/server-operations-guide.md 指标字典。
  "execution_succeeded",
  "execution_failed",
  "execution_partial",
  "execution_skipped",
  "execution_awaiting_confirmation",
  "execution_loop_blocked",
  "execution_retried",
  "webhook_dedup_hit",
  "reconcile_requeued",
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/** 判断事件名是否在清单内，防止拼错的类型悄悄写进库。 */
export function isAnalyticsEventType(
  value: string,
): value is AnalyticsEventType {
  return (ANALYTICS_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * 决策状态到事件的映射：pending 是系统登记、不是商家动作，返回 null 不记事件。
 * Adoption / Decision Completion 的分母口径全押在这四个值上，改一处就会反映到指标。
 */
export function decisionEventType(
  status: "pending" | "accepted" | "edited" | "ignored" | "ordered",
): AnalyticsEventType | null {
  switch (status) {
    case "accepted":
      return "advice_accepted";
    case "edited":
      return "advice_edited";
    case "ignored":
      return "advice_ignored";
    case "ordered":
      return "advice_ordered";
    default:
      return null;
  }
}

/** 事件行（从库里取出来的最小形状），指标计算只依赖这三个字段。 */
export type AnalyticsEventRow = {
  type: AnalyticsEventType;
  props: Record<string, unknown> | null;
  createdAt: Date;
};

/** UTC 天粒度是否同一天；dashboard_viewed 每店每天最多一条用的就是这个判定。 */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** 从事件时间戳推出「今天之前是否已记录过」，服务端拿最近一条事件时间来调。 */
export function shouldTrackToday(
  lastTrackedAt: Date | null,
  now: Date,
): boolean {
  return lastTrackedAt === null || !isSameUtcDay(lastTrackedAt, now);
}

/** sync_completed 的结果只认这两种，其他值视作脏数据不计入分母。 */
export type SyncOutcome = "success" | "failed";

function syncOutcome(event: AnalyticsEventRow): SyncOutcome | null {
  const outcome = event.props?.outcome;
  return outcome === "success" || outcome === "failed" ? outcome : null;
}

export type BetaMetrics = {
  /** Activation：是否完成过至少一次成功同步。 */
  activated: boolean;
  /** Time to First Value：安装到第一条建议被接受的毫秒数；没走到为 null。 */
  timeToFirstValueMs: number | null;
  /** Adoption：接受+调整 占全部决策动作的比例；没决策过为 null。 */
  adoptionRate: number | null;
  /** Decision Completion：已表态（接受/调整/忽略/下单）次数；给报告当绝对量。 */
  decisionCount: number;
  /** Sync Success：成功同步 / 全部有结果的同步；没有同步事件为 null。 */
  syncSuccessRate: number | null;
};

const DECISION_TYPES: AnalyticsEventType[] = [
  "advice_accepted",
  "advice_edited",
  "advice_ignored",
  "advice_ordered",
];

/**
 * 从一家店的事件行推导指标。installedAt 用最早一条 app_installed；
 * 老店没有该事件（埋点上线前装的）时传 null，TTFV 相应为 null，不猜。
 */
export function computeBetaMetrics(
  events: AnalyticsEventRow[],
  installedAt: Date | null,
): BetaMetrics {
  const activated = events.some(
    (event) =>
      event.type === "sync_completed" && syncOutcome(event) === "success",
  );

  let timeToFirstValueMs: number | null = null;
  if (installedAt) {
    const firstAccept = events
      .filter((event) => event.type === "advice_accepted")
      .map((event) => event.createdAt.getTime())
      .sort((a, b) => a - b)[0];
    if (firstAccept !== undefined && firstAccept >= installedAt.getTime()) {
      timeToFirstValueMs = firstAccept - installedAt.getTime();
    }
  }

  const decisionCount = events.filter((event) =>
    DECISION_TYPES.includes(event.type),
  ).length;
  const adoptedCount = events.filter(
    (event) => event.type === "advice_accepted" || event.type === "advice_edited",
  ).length;

  const syncs = events
    .map((event) =>
      event.type === "sync_completed" ? syncOutcome(event) : null,
    )
    .filter((outcome): outcome is SyncOutcome => outcome !== null);

  return {
    activated,
    timeToFirstValueMs,
    adoptionRate: decisionCount === 0 ? null : adoptedCount / decisionCount,
    decisionCount,
    syncSuccessRate:
      syncs.length === 0
        ? null
        : syncs.filter((outcome) => outcome === "success").length / syncs.length,
  };
}

/** 周活店：这家店在 [now-windowDays, now] 内有过 dashboard_viewed 即算活跃。 */
export function isWeeklyActiveShop(
  events: AnalyticsEventRow[],
  now: Date,
  windowDays = 7,
): boolean {
  const since = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return events.some(
    (event) =>
      event.type === "dashboard_viewed" && event.createdAt.getTime() >= since,
  );
}

/**
 * 留存（7 / 30 日）：安装日算第 0 天（UTC），该天 + offset 天是否活跃过。
 * 安装事件缺失时无法定义锚点，返回 null 而不是当作流失。
 */
export function isRetainedOnDay(
  installedAt: Date | null,
  activeDays: Date[],
  offsetDays: number,
): boolean | null {
  if (!installedAt) return null;
  const target = new Date(installedAt);
  target.setUTCDate(target.getUTCDate() + offsetDays);
  return activeDays.some((day) => isSameUtcDay(day, target));
}

/** 从事件行里取每个 UTC 天的首次活跃快照（以 dashboard_viewed 为心跳），去重到天粒度。 */
export function collectActiveUtcDays(events: AnalyticsEventRow[]): Date[] {
  const seen = new Set<string>();
  const days: Date[] = [];
  for (const event of events) {
    if (event.type !== "dashboard_viewed") continue;
    const key = event.createdAt.toISOString().slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    days.push(event.createdAt);
  }
  return days;
}

/** 最早一条 app_installed 的 UTC 时刻；老店埋点上线前装的返回 null，指标不猜锚点。 */
export function earliestInstallAt(events: AnalyticsEventRow[]): Date | null {
  let earliest: Date | null = null;
  for (const event of events) {
    if (event.type !== "app_installed") continue;
    if (!earliest || event.createdAt.getTime() < earliest.getTime()) {
      earliest = event.createdAt;
    }
  }
  return earliest;
}

/**
 * 把毫秒数折成商家看得懂的时长（最多两个单位，如 "2d 3h" / "12m 5s"）。
 * null / 负数（异常锚点）统一给 "—"，绝不显示假数字。
 */
export function humanizeDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const units: [number, string][] = [
    [Math.floor(totalSeconds / 86400), "d"],
    [Math.floor((totalSeconds % 86400) / 3600), "h"],
    [Math.floor((totalSeconds % 3600) / 60), "m"],
    [totalSeconds % 60, "s"],
  ];
  const present = units.filter(([value]) => value > 0);
  return present
    .slice(0, 2)
    .map(([value, label]) => `${value}${label}`)
    .join(" ");
}

/** 比例折成百分比字符串；null（无分母）给 "—"，不显示 0% 冒充"算出来是零"。 */
export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/* ---------------- 反馈取值 ---------------- */

export type AdviceFeedbackVerdict = "useful" | "not_useful";
export type AdviceFeedbackReason =
  | "too_high"
  | "too_low"
  | "not_needed_now"
  | "bad_data"
  | "other";

/**
 * 行内反馈下拉的唯一取值表：商家选一个，verdict 与 reason 由这张表推导，
 * 前端不再各写一套「有用/没用」的判断。
 */
export const FEEDBACK_CHOICES = {
  useful: { verdict: "useful", reason: null },
  too_high: { verdict: "not_useful", reason: "too_high" },
  too_low: { verdict: "not_useful", reason: "too_low" },
  not_needed_now: { verdict: "not_useful", reason: "not_needed_now" },
  bad_data: { verdict: "not_useful", reason: "bad_data" },
  other: { verdict: "not_useful", reason: "other" },
} as const satisfies Record<
  string,
  { verdict: AdviceFeedbackVerdict; reason: AdviceFeedbackReason | null }
>;

export type FeedbackChoice = keyof typeof FEEDBACK_CHOICES;

/** 下拉的商家可见文案：verdict 由选项推导，标签里不再出现内部术语。 */
export const FEEDBACK_CHOICE_LABELS: Record<FeedbackChoice, string> = {
  useful: "Useful — the suggested quantity looks right",
  too_high: "Not useful — suggests too much",
  too_low: "Not useful — suggests too little",
  not_needed_now: "Not useful — I don't need to reorder now",
  bad_data: "Not useful — the numbers or data are wrong",
  other: "Not useful — another reason",
};

/** 解析下拉值；非法返回 null。 */
export function resolveFeedbackChoice(
  raw: FormDataEntryValue | null,
): { verdict: AdviceFeedbackVerdict; reason: AdviceFeedbackReason | null } | null {
  if (typeof raw !== "string" || !(raw in FEEDBACK_CHOICES)) return null;
  return { ...FEEDBACK_CHOICES[raw as FeedbackChoice] };
}

export const FEEDBACK_COMMENT_MAX_LENGTH = 500;

/** 备注收口：空为 null；超长或类型不对返回 undefined 让调用方给文案。 */
export function validateFeedbackComment(
  raw: FormDataEntryValue | null,
): string | null | undefined {
  if (raw === null || typeof raw !== "string") return raw === null ? null : undefined;
  const text = raw.trim();
  if (text === "") return null;
  if (text.length > FEEDBACK_COMMENT_MAX_LENGTH) return undefined;
  return text;
}

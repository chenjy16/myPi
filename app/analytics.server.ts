/**
 * 埋点与反馈的写读入口。埋点是「副作用旁路」：trackEvent 不 await、不抛错，
 * 采集失败绝不影响商家的操作，也不让 UI 等待。
 * 反馈是商家主动提交，走正常的事务与校验错误路径。
 */
import type { Prisma } from "@prisma/client";
import db from "./db.server";
import { AppError } from "./lib/app-error";
import { createLogger } from "./lib/logger";
import {
  collectActiveUtcDays,
  computeBetaMetrics,
  earliestInstallAt,
  isRetainedOnDay,
  isWeeklyActiveShop,
  resolveFeedbackChoice,
  shouldTrackToday,
  validateFeedbackComment,
  type AdviceFeedbackReason,
  type AdviceFeedbackVerdict,
  type AnalyticsEventType,
  type AnalyticsEventRow,
  type BetaMetrics,
} from "./lib/analytics";

/** 记一条事件。fire-and-forget：失败只进日志。 */
export function trackEvent(
  shop: string,
  type: AnalyticsEventType,
  props?: Record<string, unknown>,
): void {
  db.analyticsEvent
    .create({
      data: {
        shop,
        type,
        props: (props ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
    .catch((error: unknown) => {
      // 原始错误只进服务端日志，不下发浏览器。
      createLogger({ shop }).error("analytics track failed", { type, error });
    });
}

/** 每店只补记一次 app_installed；调用方 fire-and-forget，不阻塞页面。 */
export async function ensureInstallTracked(shop: string): Promise<void> {
  try {
    const existing = await db.analyticsEvent.findFirst({
      where: { shop, type: "app_installed" },
      select: { id: true },
    });
    if (existing) return;
    trackEvent(shop, "app_installed");
  } catch (error) {
    createLogger({ shop }).error("install tracking failed", { error });
  }
}

/** 每店每（UTC）天最多一条 dashboard_viewed；周活与留存都以它为心跳。 */
export async function trackDailyVisit(shop: string): Promise<void> {
  try {
    const now = new Date();
    const last = await db.analyticsEvent.findFirst({
      where: { shop, type: "dashboard_viewed" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!shouldTrackToday(last?.createdAt ?? null, now)) return;
    trackEvent(shop, "dashboard_viewed");
  } catch (error) {
    createLogger({ shop }).error("visit tracking failed", { error });
  }
}

/**
 * 每店每（UTC）天最多一条 recommendation_viewed：标记商家「看到过有可执行建议」这一漏斗节点。
 * 与 dashboard_viewed 同样按天去重，避免每次翻页都把计数刷爆；count 记当天首次的建议条数。
 */
export async function trackRecommendationViewed(
  shop: string,
  count: number,
): Promise<void> {
  try {
    const now = new Date();
    const last = await db.analyticsEvent.findFirst({
      where: { shop, type: "recommendation_viewed" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!shouldTrackToday(last?.createdAt ?? null, now)) return;
    trackEvent(shop, "recommendation_viewed", { count });
  } catch (error) {
    createLogger({ shop }).error("recommendation view tracking failed", { error });
  }
}

/**
 * 引导完成时补记一次 onboarding_completed（每店只记一次，语义同 ensureInstallTracked）。
 * `complete` 由调用方按当前看板推导；未完成时直接返回，不写库。
 */
export async function ensureOnboardingCompletedTracked(
  shop: string,
  complete: boolean,
): Promise<void> {
  if (!complete) return;
  try {
    const existing = await db.analyticsEvent.findFirst({
      where: { shop, type: "onboarding_completed" },
      select: { id: true },
    });
    if (existing) return;
    trackEvent(shop, "onboarding_completed");
  } catch (error) {
    createLogger({ shop }).error("onboarding tracking failed", { error });
  }
}

export type AdviceFeedbackRecord = {
  verdict: AdviceFeedbackVerdict;
  reason: AdviceFeedbackReason | null;
  comment: string | null;
};

/**
 * 保存一条行级反馈：下拉值推导出 verdict/reason，可选备注，
 * 并关联该 variant 最近一次审计流水（没有就留 null，不硬造关联）。
 */
export async function saveAdviceFeedback(input: {
  shop: string;
  locationId: string;
  variantId: string;
  choice: FormDataEntryValue | null;
  comment: FormDataEntryValue | null;
}): Promise<AdviceFeedbackRecord> {
  const resolved = resolveFeedbackChoice(input.choice);
  if (!resolved) {
    throw new AppError(
      "validation",
      "Please choose one of the listed feedback options.",
    );
  }
  const comment = validateFeedbackComment(input.comment);
  if (comment === undefined) {
    throw new AppError(
      "validation",
      "Feedback notes are limited to 500 characters.",
    );
  }

  const latestAudit = await db.recommendationAudit.findFirst({
    where: {
      shop: input.shop,
      locationId: input.locationId,
      variantId: input.variantId,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  await db.adviceFeedback.create({
    data: {
      shop: input.shop,
      locationId: input.locationId,
      variantId: input.variantId,
      verdict: resolved.verdict,
      reason: resolved.reason,
      comment,
      auditId: latestAudit?.id ?? null,
    },
  });
  trackEvent(input.shop, "feedback_submitted", {
    verdict: resolved.verdict,
    reason: resolved.reason,
    variantId: input.variantId,
  });
  return { verdict: resolved.verdict, reason: resolved.reason, comment };
}

/** 批量取每个 variant 最近一条反馈，供行内展示「已记录」。 */
export async function getLatestFeedbackByVariant(
  shop: string,
  variantIds: string[],
): Promise<Map<string, AdviceFeedbackRecord & { createdAt: Date }>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db.adviceFeedback.findMany({
    where: { shop, variantId: { in: variantIds } },
    orderBy: { createdAt: "desc" },
  });
  const latest = new Map<
    string,
    AdviceFeedbackRecord & { createdAt: Date }
  >();
  for (const row of rows) {
    if (latest.has(row.variantId)) continue;
    latest.set(row.variantId, {
      verdict: row.verdict as AdviceFeedbackVerdict,
      reason: row.reason as AdviceFeedbackReason | null,
      comment: row.comment,
      createdAt: row.createdAt,
    });
  }
  return latest;
}

export type ShopBetaMetrics = {
  metrics: BetaMetrics;
  installedAt: Date | null;
  weeklyActive: boolean;
  /** 安装日算第 0 天；未安装事件时为 null（不冒充流失）。 */
  retainedDay7: boolean | null;
  retainedDay30: boolean | null;
  /** 参与计算的事件总数，供页面标注「样本量」，小样本时不夸大。 */
  eventCount: number;
};

/**
 * 只读聚合**当前这家店**的 Beta 指标——绝不跨店，商家永远看不到别家数据。
 * 全部走 lib/analytics 的纯函数，公式与采集口径同源；没有的事件一律回落 null，不编造。
 */
export async function getShopBetaMetrics(
  shop: string,
  now: Date = new Date(),
): Promise<ShopBetaMetrics> {
  const rows = await db.analyticsEvent.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
    select: { type: true, props: true, createdAt: true },
  });
  const events: AnalyticsEventRow[] = rows.map((row) => ({
    type: row.type as AnalyticsEventType,
    props: (row.props as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  }));

  const installedAt = earliestInstallAt(events);
  const activeDays = collectActiveUtcDays(events);

  return {
    metrics: computeBetaMetrics(events, installedAt),
    installedAt,
    weeklyActive: isWeeklyActiveShop(events, now),
    retainedDay7: isRetainedOnDay(installedAt, activeDays, 7),
    retainedDay30: isRetainedOnDay(installedAt, activeDays, 30),
    eventCount: events.length,
  };
}

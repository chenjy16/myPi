/**
 * 埋点与反馈的写读入口。埋点是「副作用旁路」：trackEvent 不 await、不抛错，
 * 采集失败绝不影响商家的操作，也不让 UI 等待。
 * 反馈是商家主动提交，走正常的事务与校验错误路径。
 */
import type { Prisma } from "@prisma/client";
import db from "./db.server";
import { AppError } from "./lib/app-error";
import {
  resolveFeedbackChoice,
  shouldTrackToday,
  validateFeedbackComment,
  type AdviceFeedbackReason,
  type AdviceFeedbackVerdict,
  type AnalyticsEventType,
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
      console.error("[mypi] analytics track failed", { shop, type, error });
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
    console.error("[mypi] install tracking failed", { shop, error });
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
    console.error("[mypi] visit tracking failed", { shop, error });
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

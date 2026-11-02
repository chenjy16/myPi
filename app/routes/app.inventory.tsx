import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  buildReorderExport,
  fetchInventoryLocations,
  getInventoryDashboard,
  getRecentRecommendationAudit,
  saveInventoryLocation,
  saveReorderRecommendation,
  syncInventoryAndSales,
  type DashboardVariant,
} from "../inventory.server";
import { INVENTORY_STATUS_LABELS } from "../lib/inventory-calculations";
import { toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import { SyncAlreadyRunningError, hasRunningJob } from "../sync-jobs.server";
import {
  getLatestFeedbackByVariant,
  saveAdviceFeedback,
  trackEvent,
} from "../analytics.server";
import {
  FEEDBACK_CHOICE_LABELS,
  FEEDBACK_COMMENT_MAX_LENGTH,
  decisionEventType,
} from "../lib/analytics";
import {
  ACTION_BOARD_HINTS,
  ACTION_BOARD_LABELS,
  ACTION_BOARD_STATES,
  type ActionBoardState,
} from "../lib/reorder-action-board";
import {
  AUDIT_OPERATOR_MERCHANT,
  DECISION_REASON_MAX_LENGTH,
  canMarkReorderRecommendationOrdered,
  isReorderDecisionIntent,
  isValidRequestKey,
  parseDecisionReason,
  parsePositiveQuantity,
  type ReorderDecisionStatus,
} from "../lib/reorder-recommendations";
import type { ReorderConfidenceLevel } from "../lib/reorder-confidence";

/** 数据异常时的拦截文案：页面上禁用按钮，服务端同样拒绝写入。 */
const PAUSED_ERROR =
  "Reorder decisions are paused because store data is currently unreliable. Resolve the issues on the Data Health page, then sync again.";

/** 已有同步在跑：这是并发保护，不是故障，所以用信息横幅而不是错误横幅。 */
const SYNC_ALREADY_RUNNING_NOTICE =
  "A sync for this store is already running — usually a scheduled one or the click you just made. Its results appear here automatically once it finishes.";

const CONFIDENCE_TONES: Record<
  ReorderConfidenceLevel,
  "success" | "caution" | "critical"
> = {
  high: "success",
  medium: "caution",
  low: "critical",
};

const CONFIDENCE_LABELS: Record<ReorderConfidenceLevel, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/** 校验表单里的 Shopify Location GID。 */
function isValidLocationId(value: FormDataEntryValue | null): value is string {
  return (
    typeof value === "string" && /^gid:\/\/shopify\/Location\/\d+$/.test(value)
  );
}

/** 校验表单里的 ProductVariant GID。 */
function isValidVariantId(value: FormDataEntryValue | null): value is string {
  return (
    typeof value === "string" &&
    /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value)
  );
}

/** 当前授权是否能读全部历史订单。 */
function hasAllOrdersScope(scope: string | undefined): boolean {
  return (
    scope
      ?.split(",")
      .map((item) => item.trim())
      .includes("read_all_orders") ?? false
  );
}

/** 打开库存页：鉴权后拉地点列表、看板计算结果、最近的决策审计与行级反馈。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const canReadAllOrders = hasAllOrdersScope(session.scope);
  const locations = await fetchInventoryLocations(admin);
  const [dashboard, auditTrail] = await Promise.all([
    getInventoryDashboard(session.shop, locations, canReadAllOrders),
    getRecentRecommendationAudit(session.shop, 12),
  ]);
  const feedbackByVariant = await getLatestFeedbackByVariant(
    session.shop,
    dashboard.variants.map((variant) => variant.variantId),
  );

  return {
    ...dashboard,
    canReadAllOrders,
    auditTrail,
    // Map 过不了 loader 序列化，收成普通对象；值里没有 Date 之外的不可序列化字段。
    feedbackByVariant: Object.fromEntries(feedbackByVariant),
    // 请求级幂等键：每行一个，双击/重试共用同一个 key，服务端撞唯一索引去重。
    // 提交成功后由 action 换发新 key，商家再次表态走新一轮幂等。
    decisionRequestKeys: Object.fromEntries(
      dashboard.variants.map((variant) => [
        variant.variantId,
        crypto.randomUUID(),
      ]),
    ),
  };
});

/** 是否撞上了 RecommendationAudit.requestKey 唯一索引（同一幂等键的重复提交）。 */
function isRequestKeyConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * 处理库存页提交：选地点、手动同步、导出 CSV、或接受/调整/忽略/标记已采购。
 * 决策类写入一律先重新计算并检查数据健康；sync 只读 Shopify。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const canReadAllOrders = hasAllOrdersScope(session.scope);

  try {
    if (isReorderDecisionIntent(intent)) {
      const locationId = formData.get("locationId");
      const variantId = formData.get("variantId");
      if (!isValidLocationId(locationId) || !isValidVariantId(variantId)) {
        return {
          error:
            "The reorder recommendation is invalid. Please refresh and try again.",
        };
      }
      // 幂等键来自表单 hidden 值，不可信：非标准 UUID 直接拒，防注入假键。
      if (!isValidRequestKey(formData.get("requestKey"))) {
        return {
          error:
            "This decision form is out of date. Refresh the page, then decide again.",
        };
      }

      const dashboard = await getInventoryDashboard(
        session.shop,
        [],
        canReadAllOrders,
      );
      if (dashboard.settings?.locationId !== locationId) {
        return {
          error:
            "The inventory location has changed. Please refresh and try again.",
        };
      }
      // 暂停判定在服务端重算一次，页面上的按钮禁用只是体验，不是约束。
      if (dashboard.dataHealth.paused) {
        return { error: PAUSED_ERROR };
      }
      const variant = dashboard.variants.find(
        (item) => item.variantId === variantId,
      );
      if (!variant || variant.suggestedReorderQuantity <= 0) {
        return {
          error:
            "This product currently has no valid reorder recommendation. Please refresh and try again.",
        };
      }

      let status: ReorderDecisionStatus;
      let quantity: number;
      let reason: string | null = null;
      if (intent === "accept-recommendation") {
        status = "accepted";
        quantity = variant.suggestedReorderQuantity;
      } else if (intent === "edit-recommendation") {
        const parsedQuantity = parsePositiveQuantity(formData.get("quantity"));
        if (parsedQuantity === null) {
          return {
            error: "Purchase quantity must be an integer greater than 0.",
          };
        }
        const parsedReason = parseDecisionReason(formData.get("reason"));
        if (parsedReason === undefined) {
          return {
            error: `The decision reason must be ${DECISION_REASON_MAX_LENGTH} characters or shorter.`,
          };
        }
        status = "edited";
        quantity = parsedQuantity;
        reason = parsedReason;
      } else if (intent === "ignore-recommendation") {
        const parsedReason = parseDecisionReason(formData.get("reason"));
        if (parsedReason === undefined) {
          return {
            error: `The decision reason must be ${DECISION_REASON_MAX_LENGTH} characters or shorter.`,
          };
        }
        status = "ignored";
        quantity = 0;
        reason = parsedReason;
      } else {
        const savedRecommendation = variant.recommendation;
        if (
          !savedRecommendation ||
          !canMarkReorderRecommendationOrdered(savedRecommendation)
        ) {
          return {
            error:
              "Please accept or adjust the current recommendation before marking it as ordered.",
          };
        }
        status = "ordered";
        quantity = savedRecommendation.quantity;
      }

      const requestKey = formData.get("requestKey") as string;
      try {
        await saveReorderRecommendation({
          shop: session.shop,
          locationId,
          variantId,
          suggestedQuantity: variant.suggestedReorderQuantity,
          quantity,
          status,
          confidence: variant.confidence.level,
          demandWindowDays: variant.observedDemand.windowDays,
          demandPerDay: variant.observedDemand.perDay,
          demandSampleDays: variant.observedDemand.sampleDaysAvailable,
          operator: AUDIT_OPERATOR_MERCHANT,
          reason,
          requestKey,
        });
      } catch (error) {
        // 同一幂等键撞唯一索引 = 双击/重试的第二次提交。第一次已完整落账，
        // 这里按「已记录」返回并换发新 key，不重复记埋点，也不把冲突当故障吓商家。
        if (isRequestKeyConflict(error)) {
          return {
            recommendationResult: {
              status,
              productTitle: variant.productTitle,
            },
            decisionKey: { variantId, requestKey: crypto.randomUUID() },
          };
        }
        throw error;
      }

      // 决策事件在落库成功后才记，指标里的「决策完成数」因此都是真实写入。
      const eventType = decisionEventType(status);
      if (eventType) {
        trackEvent(session.shop, eventType, { variantId, quantity });
      }

      return {
        recommendationResult: {
          status,
          productTitle: variant.productTitle,
        },
        // 本轮 key 已消费，换发新的：商家之后有意的再次表态属于新一轮请求。
        decisionKey: { variantId, requestKey: crypto.randomUUID() },
      };
    }

    if (intent === "select-location") {
      const locationId = formData.get("locationId");
      if (!isValidLocationId(locationId)) {
        return { error: "Please select a valid Shopify inventory location." };
      }

      const locations = await fetchInventoryLocations(admin);
      const selectedLocation = locations.find(({ id }) => id === locationId);
      if (!selectedLocation) {
        return {
          error:
            "The inventory location doesn't exist or has been disabled. Please refresh and try again.",
        };
      }
      await saveInventoryLocation(session.shop, selectedLocation);
      trackEvent(session.shop, "settings_saved", { section: "location" });
      return { selectedLocationId: selectedLocation.id };
    }

    if (intent === "sync") {
      const locationId = formData.get("locationId");
      if (!isValidLocationId(locationId)) {
        return { error: "Please select an inventory location first." };
      }

      // 双击、多标签页、cron 与 webhook 都可能同时撞到 Sync。
      // 先给一次便宜的检查，让商家看到「已在跑」而不是白等一轮；真正的互斥由任务锁保证。
      if (await hasRunningJob(session.shop, "inventory-snapshot")) {
        return { notice: SYNC_ALREADY_RUNNING_NOTICE };
      }

      try {
        const result = await syncInventoryAndSales(
          admin,
          session.shop,
          locationId,
          canReadAllOrders,
        );
        trackEvent(session.shop, "sync_completed", { outcome: "success" });
        return { syncResult: result };
      } catch (error) {
        // 撞锁不是失败结果，不记 failed；真正的同步失败才计入 Sync Success 分母。
        if (!(error instanceof SyncAlreadyRunningError)) {
          trackEvent(session.shop, "sync_completed", { outcome: "failed" });
        }
        throw error;
      }
    }

    if (intent === "advice-feedback") {
      const locationId = formData.get("locationId");
      const variantId = formData.get("variantId");
      if (!isValidLocationId(locationId) || !isValidVariantId(variantId)) {
        return {
          error:
            "The feedback target is invalid. Please refresh and try again.",
        };
      }
      const saved = await saveAdviceFeedback({
        shop: session.shop,
        locationId,
        variantId,
        choice: formData.get("choice"),
        comment: formData.get("comment"),
      });
      const reasonNote = saved.reason ? ` (reason: ${saved.reason})` : "";
      return {
        notice: `Feedback recorded: ${saved.verdict}${reasonNote}. Thanks — this feeds back into how we explain advice.`,
      };
    }

    if (intent === "export-csv") {
      const exportResult = await buildReorderExport(
        session.shop,
        canReadAllOrders,
      );
      trackEvent(session.shop, "csv_exported", {
        kind: "reorder",
        rows: exportResult.rowCount,
      });
      return { exportResult };
    }

    return { error: "Unsupported operation." };
  } catch (error) {
    // 撞锁不是失败：按信息呈现，避免商家以为同步出了问题。
    if (error instanceof SyncAlreadyRunningError) {
      return { notice: SYNC_ALREADY_RUNNING_NOTICE };
    }
    const safe = toSafeError(error);
    // 原始细节（含 Prisma 错误码、Shopify 报错）只进服务端日志，不下发浏览器。
    console.error("[mypi] inventory action failed", {
      shop: session.shop,
      intent: typeof intent === "string" ? intent : "unknown",
      kind: safe.kind,
      detail: safe.detail,
    });
    return { error: safe.message, errorKind: safe.kind };
  }
};

function formatNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

function formatMoney(value: number, currencyCode: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: Date | string | null): string {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not synced yet";
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/** 六态筛选：all 看全部诊断行，其余按 Action Board 归类。 */
function filterVariants(
  variants: DashboardVariant[],
  filter: ActionBoardState | "all",
): DashboardVariant[] {
  if (filter === "all") return variants;
  return variants.filter((variant) => variant.actionState === filter);
}

/** mypi 页面：同步与数据健康、六态 Action Board、诊断表与决策审计。 */
export default function InventoryPage() {
  const {
    locations,
    settings,
    metrics,
    variants,
    dataHealth,
    board,
    snapshotDate,
    auditTrail,
    canReadAllOrders,
    feedbackByVariant,
    decisionRequestKeys,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";
  const [filter, setFilter] = useState<ActionBoardState | "all">("all");
  const downloadedExport = useRef<string | null>(null);

  const selectedLocationId =
    fetcher.data &&
    "selectedLocationId" in fetcher.data &&
    typeof fetcher.data.selectedLocationId === "string"
      ? fetcher.data.selectedLocationId
      : (settings?.locationId ?? "");
  const hasSyncData = Boolean(settings?.lastInventorySyncAt);
  const currentIntent = fetcher.formData?.get("intent");
  const errorMessage =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  const noticeMessage =
    fetcher.data && "notice" in fetcher.data ? fetcher.data.notice : undefined;
  const exportResult =
    fetcher.data && "exportResult" in fetcher.data
      ? fetcher.data.exportResult
      : undefined;
  // 决策幂等键：action 成功（或识别为重复提交）后为该行换发新 key；
  // 其余行继续沿用 loader 发的初始 key。同一行本轮内多次点击共用同一个 key。
  const consumedKey =
    fetcher.data && "decisionKey" in fetcher.data
      ? fetcher.data.decisionKey
      : undefined;
  const requestKeyFor = (variantId: string) =>
    consumedKey && consumedKey.variantId === variantId
      ? consumedKey.requestKey
      : (decisionRequestKeys[variantId] ?? "");
  const visibleVariants = filterVariants(variants, filter);
  const namesByVariant = new Map(
    variants.map((variant) => [
      variant.variantId,
      `${variant.productTitle} — ${variant.variantTitle}`,
    ]),
  );

  // 导出走 action 拿 CSV 文本，再在浏览器里落盘：嵌入式 iframe 里做整页跳转会丢会话。
  useEffect(() => {
    if (!exportResult) return;
    const fingerprint = `${exportResult.fileName}:${exportResult.rowCount}:${exportResult.csv.length}`;
    if (downloadedExport.current === fingerprint) return;
    downloadedExport.current = fingerprint;

    const url = URL.createObjectURL(
      // 前置 UTF-8 BOM，Excel 双击打开才不会把中文商品名/备注识别成乱码。
      new Blob(["\uFEFF" + exportResult.csv], { type: "text/csv;charset=utf-8;" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportResult.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [exportResult]);

  return (
    <s-page heading="mypi Replenishment">
      <s-section heading="Inventory sync">
        <s-paragraph>
          Select a Shopify inventory location. Stock coverage applies to that
          location; sales are aggregated across all paid orders in the store.
          Syncing only reads data and never modifies products or inventory.
        </s-paragraph>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="select-location" />
          <s-stack direction="block" gap="base">
            <s-select
              label="Primary inventory location"
              name="locationId"
              value={selectedLocationId}
              required
            >
              {locations.map((location) => (
                <s-option key={location.id} value={location.id}>
                  {location.name}
                </s-option>
              ))}
            </s-select>
            <s-button
              type="submit"
              variant="secondary"
              disabled={isBusy || locations.length === 0}
              {...(currentIntent === "select-location" && isBusy
                ? { loading: true }
                : {})}
            >
              Save inventory location
            </s-button>
          </s-stack>
        </fetcher.Form>
        {locations.length === 0 && (
          <s-banner tone="warning" heading="No available inventory locations">
            This store currently has no active location available to sync.
          </s-banner>
        )}
        {selectedLocationId && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <input type="hidden" name="locationId" value={selectedLocationId} />
            <s-button
              type="submit"
              variant="primary"
              disabled={isBusy}
              {...(currentIntent === "sync" && isBusy ? { loading: true } : {})}
            >
              Sync products, inventory and sales
            </s-button>
          </fetcher.Form>
        )}
        {settings && (
          <s-paragraph>
            Last sync: {formatDate(settings.lastInventorySyncAt)}; snapshot date{" "}
            {snapshotDate ?? "none"}; default lead time {settings.leadTimeDays}{" "}
            days, safety stock {settings.safetyStockDays} days, purchase review
            cycle {settings.reviewPeriodDays} days. These are system estimates.
          </s-paragraph>
        )}
        {!canReadAllOrders && (
          <s-banner
            tone="warning"
            heading="90-day sales history not available yet"
          >
            The current Shopify authorization only allows reading orders from
            the last 60 days, so 90-day sales and long-term dead-stock detection
            remain unavailable. Re-authorize the app once Shopify grants the
            read_all_orders historical order access.
          </s-banner>
        )}
        {noticeMessage && (
          <s-banner tone="info" heading="Sync already in progress">
            {noticeMessage}
          </s-banner>
        )}
        {errorMessage && (
          <s-banner tone="critical" heading="Operation not completed">
            {errorMessage}
          </s-banner>
        )}
        {fetcher.data &&
          "recommendationResult" in fetcher.data &&
          fetcher.data.recommendationResult && (
            <s-banner tone="success" heading="Reorder decision recorded">
              {fetcher.data.recommendationResult.productTitle}:{" "}
              {ACTION_BOARD_LABELS[fetcher.data.recommendationResult.status]}.
              This only updates the in-app decision and its audit entry; it
              won’t create a purchase order or change Shopify inventory.
            </s-banner>
          )}
        {fetcher.data &&
          "syncResult" in fetcher.data &&
          fetcher.data.syncResult && (
            <s-banner tone="success" heading="Sync complete">
              Synced {fetcher.data.syncResult.variantCount} trackable variants
              and {fetcher.data.syncResult.orderCount} paid orders, covering the
              last {fetcher.data.syncResult.historyDaysAvailable} days.
              {fetcher.data.syncResult.costCoverage < 1
                ? " Some product costs aren't readable, so inventory value is an incomplete estimate."
                : ""}{" "}
              {fetcher.data.syncResult.pendingSuggestionsRegistered > 0
                ? `${fetcher.data.syncResult.pendingSuggestionsRegistered} new suggestion${
                    fetcher.data.syncResult.pendingSuggestionsRegistered === 1
                      ? ""
                      : "s"
                  } registered as pending review.`
                : "No new reorder suggestions were registered this time."}
            </s-banner>
          )}
        {exportResult && (
          <s-banner tone="success" heading="Export ready">
            Downloaded {exportResult.rowCount} variants that carry reorder
            advice or a recorded decision to {exportResult.fileName}. Variants
            with no advice are not part of a reorder plan, so they stay out of
            the file. If your browser blocked the download, allow automatic
            downloads for this app.
          </s-banner>
        )}
      </s-section>

      <s-section heading="Data health">
        {dataHealth.paused ? (
          <s-banner tone="critical" heading="Reorder decisions are paused">
            <s-stack direction="block" gap="small">
              <s-paragraph>
                The numbers below stay visible for reference, but they shouldn’t
                drive a purchase until the data issues below are resolved.
              </s-paragraph>
              {dataHealth.pauseReasons.map((reason) => (
                <s-paragraph key={reason}>• {reason}</s-paragraph>
              ))}
              <s-link href="/app/data-health">
                Review data health details →
              </s-link>
            </s-stack>
          </s-banner>
        ) : (
          <s-paragraph>
            {dataHealth.state === "healthy"
              ? "Store data passes every check, so recommendations are safe to act on."
              : "Recommendations are active, but some data checks need attention."}{" "}
            <s-link href="/app/data-health">See details →</s-link>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Action board">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
          gap="base"
        >
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text type="strong">
              {formatRate(board.adoption.adoptionRate)}
            </s-text>
            <s-paragraph>Adoption of reviewed advice</s-paragraph>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text type="strong">
              {formatRate(board.adoption.reviewedRate)}
            </s-text>
            <s-paragraph>
              Reviewed (
              {board.adoption.actionableCount > 0
                ? `${
                    board.counts.accepted +
                    board.counts.edited +
                    board.counts.ignored +
                    board.counts.ordered
                  } of ${board.adoption.actionableCount}`
                : "none yet"}
              )
            </s-paragraph>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text type="strong">{board.counts.pending}</s-text>
            <s-paragraph>Awaiting your decision</s-paragraph>
          </s-box>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text type="strong">{board.counts.ordered}</s-text>
            <s-paragraph>Marked ordered</s-paragraph>
          </s-box>
        </s-grid>
        <s-paragraph>
          Adoption counts advice you accepted, adjusted or ordered out of every
          recommendation you took a stance on. Ignored advice lowers it; advice
          you haven’t reviewed yet doesn’t count either way.
        </s-paragraph>
      </s-section>

      <s-section heading="Inventory overview">
        {!hasSyncData ? (
          <s-banner tone="info" heading="No inventory snapshot yet">
            Select a location and sync, and the system will calculate coverage,
            stockout risk and reorder recommendations.
          </s-banner>
        ) : (
          <>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
              gap="base"
            >
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{metrics.totalSkus}</s-text>
                <s-paragraph>Trackable SKUs / variants</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">
                  {formatNumber(metrics.availableStock, 0)}
                </s-text>
                <s-paragraph>Available stock</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{metrics.atRisk}</s-text>
                <s-paragraph>Stockout risk</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{metrics.lowStock}</s-text>
                <s-paragraph>Low stock</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{metrics.overstock}</s-text>
                <s-paragraph>Overstock</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{metrics.deadStock}</s-text>
                <s-paragraph>No sales in 90 days</s-paragraph>
              </s-box>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">
                  {formatMoney(
                    metrics.inventoryValue,
                    settings?.currencyCode ?? "USD",
                  )}
                </s-text>
                <s-paragraph>Estimated inventory value</s-paragraph>
              </s-box>
            </s-grid>
            {metrics.variantsMissingCost > 0 && (
              <s-paragraph>
                {metrics.variantsMissingCost} variants have no readable product
                cost, so inventory value only counts variants with cost data.
                Confirm the current user has the Shopify “view product costs”
                permission.
              </s-paragraph>
            )}
          </>
        )}
      </s-section>

      {hasSyncData && (
        <s-section
          heading={`Replenishment worklist (${variants.length} variants)`}
        >
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small">
              <s-button
                variant={filter === "all" ? "primary" : "secondary"}
                onClick={() => setFilter("all")}
              >
                All ({variants.length})
              </s-button>
              {ACTION_BOARD_STATES.map((state) => (
                <s-button
                  key={state}
                  variant={filter === state ? "primary" : "secondary"}
                  onClick={() => setFilter(state)}
                >
                  {ACTION_BOARD_LABELS[state]} ({board.counts[state]})
                </s-button>
              ))}
            </s-stack>
            <s-paragraph>
              {filter === "all"
                ? "Every variant synced for this location, with or without reorder advice."
                : ACTION_BOARD_HINTS[filter]}
            </s-paragraph>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="export-csv" />
              <s-button type="submit" variant="secondary" disabled={isBusy}>
                Export the reorder plan as CSV
              </s-button>
            </fetcher.Form>
          </s-stack>

          {/*
           * 工作列表固定用 `list` 而不是 `auto`：本表有 8 列，其中「Observed demand」
           * 「How this was calculated」是整段解释文字。用表格模式时，嵌入 iframe 的宽度
           * 不够会把最后一列「Your decision」连里面的 accept / adjust / ignore 按钮一起
           * 裁到可视区外，商家根本点不到。list 模式按表头已经声明的 listSlot 把每行渲染成
           * 「主标题 + 带标签的字段」，任意宽度下决策操作都留在视野内。下面的
           * 「Recent decisions」只有 6 个短列，继续用 `auto` 的表格模式。
           */}
          {variants.length === 0 ? (
            <s-paragraph>
              The selected location has no active product variants with
              trackable inventory.
            </s-paragraph>
          ) : visibleVariants.length === 0 ? (
            <s-paragraph>Nothing in this state right now.</s-paragraph>
          ) : (
            <s-table variant="list">
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  Product / SKU
                </s-table-header>
                <s-table-header listSlot="labeled">Stock status</s-table-header>
                <s-table-header listSlot="labeled">
                  Available / Incoming
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Observed demand
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Coverage / Est. stockout
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Suggested reorder
                </s-table-header>
                <s-table-header listSlot="labeled">
                  How this was calculated
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Your decision
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {visibleVariants.map((variant) => {
                  const recommendation = variant.recommendation;
                  const canOrder = Boolean(
                    recommendation &&
                    canMarkReorderRecommendationOrdered(recommendation),
                  );
                  const hasAdvice = variant.suggestedReorderQuantity > 0;
                  // 暂停或没建议时整行按钮锁住；服务端会再挡一次，这里只是不让人白点。
                  const locked = dataHealth.paused || !hasAdvice;
                  const recordedFeedback = feedbackByVariant[variant.variantId];
                  return (
                    <s-table-row key={variant.id}>
                      <s-table-cell>
                        {variant.productTitle} — {variant.variantTitle}
                        <br />
                        SKU: {variant.sku || "Not set"}
                        {variant.actionState && (
                          <>
                            <br />
                            <s-badge tone="neutral">
                              {ACTION_BOARD_LABELS[variant.actionState]}
                            </s-badge>
                          </>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {INVENTORY_STATUS_LABELS[variant.status]}
                      </s-table-cell>
                      <s-table-cell>
                        {variant.available} / {variant.incoming}
                      </s-table-cell>
                      <s-table-cell>
                        {formatNumber(variant.observedDemand.perDay)} units/day
                        <br />
                        {variant.observedDemand.quantity} units over{" "}
                        {variant.observedDemand.sampleDaysAvailable} visible of{" "}
                        {variant.observedDemand.windowDays} days
                        {variant.observedDemand.daysWithSales !== null && (
                          <>
                            <br />
                            sold on {variant.observedDemand.daysWithSales} of
                            those days
                          </>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {variant.daysOfInventory === null
                          ? "No observed sales"
                          : `${formatNumber(variant.daysOfInventory)} days`}
                        <br />
                        {variant.estimatedStockoutDate ??
                          "No stockout estimate"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-text type="strong">
                          {variant.suggestedReorderQuantity}
                        </s-text>
                        <br />
                        <s-badge
                          tone={CONFIDENCE_TONES[variant.confidence.level]}
                        >
                          {CONFIDENCE_LABELS[variant.confidence.level]}
                        </s-badge>
                        {variant.confidence.reasons.map((reason) => (
                          <s-paragraph key={reason.code}>
                            • {reason.label}
                          </s-paragraph>
                        ))}
                      </s-table-cell>
                      <s-table-cell>{variant.reorderReason}</s-table-cell>
                      <s-table-cell>
                        <s-stack direction="block" gap="small">
                          {recommendation ? (
                            <s-paragraph>
                              {ACTION_BOARD_LABELS[recommendation.status]}
                              {recommendation.status !== "ignored" &&
                                ` · quantity ${recommendation.quantity}`}
                              {recommendation.decisionReason &&
                                ` · reason “${recommendation.decisionReason}”`}
                              {recommendation.needsReview &&
                                " · advice changed since you decided, please re-confirm"}
                            </s-paragraph>
                          ) : (
                            <s-paragraph>No decision recorded</s-paragraph>
                          )}
                          {dataHealth.paused && (
                            <s-paragraph>
                              Decisions are locked while store data is
                              unreliable.
                            </s-paragraph>
                          )}
                          {!hasAdvice && !dataHealth.paused && (
                            <s-paragraph>
                              No reorder advice right now, so there’s nothing to
                              accept.
                            </s-paragraph>
                          )}
                          {hasAdvice && (
                            <s-stack direction="block" gap="small">
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="accept-recommendation"
                                />
                                <input
                                  type="hidden"
                                  name="locationId"
                                  value={settings?.locationId ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="variantId"
                                  value={variant.variantId}
                                />
                                <input
                                  type="hidden"
                                  name="requestKey"
                                  value={requestKeyFor(variant.variantId)}
                                />
                                <s-button
                                  type="submit"
                                  variant="primary"
                                  disabled={locked || isBusy}
                                >
                                  Accept recommendation
                                </s-button>
                              </fetcher.Form>
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="edit-recommendation"
                                />
                                <input
                                  type="hidden"
                                  name="locationId"
                                  value={settings?.locationId ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="variantId"
                                  value={variant.variantId}
                                />
                                <input
                                  type="hidden"
                                  name="requestKey"
                                  value={requestKeyFor(variant.variantId)}
                                />
                                <input
                                  type="number"
                                  name="quantity"
                                  min="1"
                                  step="1"
                                  required
                                  disabled={locked || isBusy}
                                  aria-label={`${variant.productTitle} purchase quantity`}
                                  defaultValue={
                                    canOrder
                                      ? recommendation?.quantity
                                      : variant.suggestedReorderQuantity
                                  }
                                />
                                <input
                                  type="text"
                                  name="reason"
                                  maxLength={DECISION_REASON_MAX_LENGTH}
                                  placeholder="Why this quantity? (optional)"
                                  disabled={locked || isBusy}
                                  aria-label={`Reason for adjusted quantity for ${variant.productTitle}`}
                                />
                                <s-button
                                  type="submit"
                                  disabled={locked || isBusy}
                                >
                                  Save adjusted quantity
                                </s-button>
                              </fetcher.Form>
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="ignore-recommendation"
                                />
                                <input
                                  type="hidden"
                                  name="locationId"
                                  value={settings?.locationId ?? ""}
                                />
                                <input
                                  type="hidden"
                                  name="variantId"
                                  value={variant.variantId}
                                />
                                <input
                                  type="hidden"
                                  name="requestKey"
                                  value={requestKeyFor(variant.variantId)}
                                />
                                <input
                                  type="text"
                                  name="reason"
                                  maxLength={DECISION_REASON_MAX_LENGTH}
                                  placeholder="Why skip this round? (optional)"
                                  disabled={locked || isBusy}
                                  aria-label={`Reason for ignoring advice for ${variant.productTitle}`}
                                />
                                <s-button
                                  type="submit"
                                  disabled={locked || isBusy}
                                >
                                  Ignore this round
                                </s-button>
                              </fetcher.Form>
                              {canOrder && (
                                <fetcher.Form method="post">
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value="mark-ordered"
                                  />
                                  <input
                                    type="hidden"
                                    name="locationId"
                                    value={settings?.locationId ?? ""}
                                  />
                                  <input
                                    type="hidden"
                                    name="variantId"
                                    value={variant.variantId}
                                  />
                                  <input
                                    type="hidden"
                                    name="requestKey"
                                    value={requestKeyFor(variant.variantId)}
                                  />
                                  <s-button
                                    type="submit"
                                    disabled={locked || isBusy}
                                  >
                                    Mark as ordered
                                  </s-button>
                                </fetcher.Form>
                              )}
                            </s-stack>
                          )}
                          <s-stack direction="block" gap="small">
                            {recordedFeedback && (
                              <s-paragraph>
                                Feedback recorded:{" "}
                                {recordedFeedback.verdict === "useful"
                                  ? "useful"
                                  : `not useful (${recordedFeedback.reason ?? "other"})`}
                              </s-paragraph>
                            )}
                            <fetcher.Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="advice-feedback"
                              />
                              <input
                                type="hidden"
                                name="locationId"
                                value={settings?.locationId ?? ""}
                              />
                              <input
                                type="hidden"
                                name="variantId"
                                value={variant.variantId}
                              />
                              <div className="feedbackForm">
                                <select
                                  name="choice"
                                  defaultValue=""
                                  required
                                  aria-label={`Feedback for ${variant.productTitle} ${variant.variantTitle}`}
                                >
                                  <option value="" disabled>
                                    Was this advice useful?
                                  </option>
                                  {Object.entries(FEEDBACK_CHOICE_LABELS).map(
                                    ([value, label]) => (
                                      <option key={value} value={value}>
                                        {label}
                                      </option>
                                    ),
                                  )}
                                </select>
                                <input
                                  type="text"
                                  name="comment"
                                  maxLength={FEEDBACK_COMMENT_MAX_LENGTH}
                                  placeholder="Add a note (optional)"
                                  aria-label={`Optional note for ${variant.productTitle} ${variant.variantTitle}`}
                                />
                                <s-button
                                  type="submit"
                                  variant="tertiary"
                                  disabled={isBusy}
                                >
                                  Send feedback
                                </s-button>
                              </div>
                            </fetcher.Form>
                          </s-stack>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      <s-section heading="Recent decisions">
        {auditTrail.length === 0 ? (
          <s-paragraph>
            No decisions recorded yet. Every accept, adjust, ignore or ordered
            action adds a row here, and each sync records newly created advice.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product / SKU</s-table-header>
              <s-table-header listSlot="labeled">When</s-table-header>
              <s-table-header listSlot="labeled">Action</s-table-header>
              <s-table-header listSlot="labeled">From → To</s-table-header>
              <s-table-header listSlot="labeled">
                Suggested / Recorded
              </s-table-header>
              <s-table-header listSlot="labeled">By</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {auditTrail.map((entry) => (
                <s-table-row
                  key={`${entry.variantId}-${entry.createdAt.toISOString()}`}
                >
                  <s-table-cell>
                    {namesByVariant.get(entry.variantId) ??
                      `Variant ${entry.variantId.split("/").pop()}`}
                  </s-table-cell>
                  <s-table-cell>{formatDate(entry.createdAt)}</s-table-cell>
                  <s-table-cell>
                    {entry.action.replace(/-/g, " ")}
                    {entry.reason && (
                      <s-paragraph>“{entry.reason}”</s-paragraph>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {entry.fromStatus
                      ? `${entry.fromStatus} → ${entry.toStatus}`
                      : `— → ${entry.toStatus}`}
                  </s-table-cell>
                  <s-table-cell>
                    {entry.suggestedQuantity} / {entry.quantity}
                  </s-table-cell>
                  <s-table-cell>{entry.operator ?? "unknown"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="App navigation">
        <s-link href="/app">Back to workspace</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

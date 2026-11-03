import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventoryDashboard,
  getRecentRecommendationAudit,
  type DashboardVariant,
} from "../inventory.server";
import {
  ensureOnboardingCompletedTracked,
  trackDailyVisit,
} from "../analytics.server";
import { deriveOnboardingSteps } from "../lib/onboarding";
import { safeLoader } from "../lib/route-error";
import { buildSyncFreshnessNotice } from "../lib/sync-freshness";
import {
  formatDateTime,
  formatDate,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatRate,
  MISSING,
} from "../lib/format";
import { freshnessBannerTone, isBusinessState } from "../lib/status";
import { EmptyState } from "../components/ui/empty-state";
import { FactGrid } from "../components/ui/fact-grid";
import { LoadingState } from "../components/ui/loading-state";
import {
  ConfidenceBadge,
  DataHealthStateBadge,
  HealthBadge,
  InventoryStatusBadge,
  ReadinessBadge,
  StatusBadge,
} from "../components/ui/status-badge";

/** 首页只需看板数据，不查草稿或地点列表。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const canReadAllOrders =
    session.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("read_all_orders") ?? false;
  const [dashboard, recentDecisions] = await Promise.all([
    getInventoryDashboard(session.shop, [], canReadAllOrders),
    getRecentRecommendationAudit(session.shop, 3),
  ]);

  // 每日一条 dashboard_viewed：周活与 7/30 日留存都以它为心跳；fire-and-forget 不拖慢首屏。
  void trackDailyVisit(session.shop);

  // Onboarding 进度直接从看板推导，不为引导卡加一次查询。
  const onboarding = deriveOnboardingSteps({
    locationChosen: Boolean(dashboard.settings?.locationId),
    synced: Boolean(dashboard.settings?.lastInventorySyncAt),
    paramsSaved: Boolean(dashboard.settings?.replenishmentSettingsSavedAt),
    adviceCount: dashboard.variants.filter(
      (variant) => variant.recommendation !== null,
    ).length,
    decidedCount: dashboard.variants.filter((variant) => {
      const status = variant.recommendation?.status;
      return status === "accepted" || status === "edited" || status === "ordered";
    }).length,
  });

  // 引导全部走完时补记一次 onboarding_completed（每店仅一次）；fire-and-forget。
  void ensureOnboardingCompletedTracked(
    session.shop,
    onboarding.every((step) => step.done),
  );

  return { dashboard, recentDecisions, onboarding };
});

/** 越靠前的库存状态越该先看，首页只给最紧急的几条。 */
const STATUS_PRIORITY = [
  "stockout",
  "critical",
  "stockout_risk",
  "low_stock",
  "overstock",
  "dead_stock",
  "no_sales",
  "healthy",
] as const;

/** 取最该处理的建议：只保留给出正数补货量的行，按紧急度再按建议量排序。 */
function priorityRows(variants: DashboardVariant[], limit: number) {
  return variants
    .filter((variant) => variant.suggestedReorderQuantity > 0)
    .sort((left, right) => {
      const byUrgency =
        STATUS_PRIORITY.indexOf(left.status) -
        STATUS_PRIORITY.indexOf(right.status);
      return (
        byUrgency ||
        right.suggestedReorderQuantity - left.suggestedReorderQuantity
      );
    })
    .slice(0, limit);
}

/** 库存决策首页：真实指标卡、优先建议、数据健康与最近决策。 */
export default function HomePage() {
  const { dashboard, recentDecisions, onboarding } =
    useLoaderData<typeof loader>();
  const {
    settings,
    metrics,
    variants,
    dataHealth,
    board,
    snapshotDate,
    syncStatus,
  } = dashboard;
  const navigation = useNavigation();
  const isRefreshing = navigation.state === "loading";
  const timeZone = settings?.timezone ?? null;
  const currencyCode = settings?.currencyCode ?? "USD";
  const freshness = buildSyncFreshnessNotice(syncStatus, {
    lastSuccessLabel: syncStatus.lastSuccessfulSyncAt
      ? formatDateTime(syncStatus.lastSuccessfulSyncAt, timeZone)
      : null,
  });
  const freshnessTone = freshnessBannerTone(freshness.tone);
  const advice = priorityRows(variants, 4);
  const reviewedCount =
    board.counts.accepted +
    board.counts.edited +
    board.counts.ignored +
    board.counts.ordered;
  const namesByVariant = new Map(
    variants.map((variant) => [
      variant.variantId,
      `${variant.productTitle} — ${variant.variantTitle}`,
    ]),
  );
  const supplierBoundCount = variants.filter(
    (variant) => variant.supplierTermsApplied !== null,
  ).length;
  const onboardingComplete = onboarding.every((step) => step.done);

  const metricCards = [
    {
      label: "Trackable SKUs",
      value: formatQuantity(metrics.totalSkus),
      note: snapshotDate
        ? `Snapshot ${formatDate(snapshotDate, timeZone)}`
        : "No inventory snapshot captured yet",
      tone: "tonePurple",
      icon: "▦",
    },
    {
      label: "Stockout risk",
      value: formatQuantity(metrics.atRisk),
      note: "Out of stock, critical or short of lead time",
      tone: "toneRed",
      icon: "⚠",
    },
    {
      label: "Needs a decision",
      value: formatQuantity(board.adoption.actionableCount),
      note: `${formatQuantity(board.counts.pending)} pending · ${formatQuantity(
        reviewedCount,
      )} reviewed`,
      tone: "toneBlue",
      icon: "▤",
    },
    {
      label: "Estimated inventory value",
      value: formatMoney(metrics.inventoryValue, currencyCode),
      note:
        metrics.variantsMissingCost > 0
          ? `${formatQuantity(
              metrics.variantsMissingCost,
            )} variants missing a readable cost`
          : "Product costs readable for every variant",
      tone: "toneGreen",
      icon: "▣",
    },
    {
      label: "Advice adoption",
      value: formatRate(board.adoption.adoptionRate),
      note:
        board.adoption.reviewedRate === null
          ? "No recommendation reviewed yet"
          : `${formatRate(board.adoption.reviewedRate)} of advice reviewed`,
      tone: "tonePurple",
      icon: "◷",
    },
  ];

  return (
    <s-page heading="mypi">
      <s-section heading="At a glance">
        <s-stack direction="block" gap="base">
          {/* s-page 的 React 类型不暴露 primaryAction / aside 插槽（只有 preact
              声明带），所以主操作与侧栏内容都按参考页的做法落在 section 里。 */}
          <s-stack direction="inline" gap="small">
            <s-button href="/app/inventory" variant="primary">
              View reorder advice
            </s-button>
            <s-button href="/app/data-health" variant="secondary">
              Check data health
            </s-button>
          </s-stack>
          <s-paragraph>
            mypi turns your paid orders and current stock into reorder advice you
            can question, adjust and export — and tells you plainly when the
            data isn’t good enough to act on.
          </s-paragraph>
          {isRefreshing && <LoadingState label="Refreshing dashboard…" />}
          <section className="dsMetrics" aria-label="Key metrics">
            {metricCards.map((metric) => (
              <article className="dsMetric" key={metric.label}>
                <span
                  className={`dsMetricIcon ${metric.tone}`}
                  aria-hidden="true"
                >
                  {metric.icon}
                </span>
                <div className="dsMetricBody">
                  <span className="dsMetricLabel">{metric.label}</span>
                  <strong className="dsMetricValue">{metric.value}</strong>
                  <span className="dsMetricTrend isPlain">{metric.note}</span>
                </div>
              </article>
            ))}
          </section>
          {freshnessTone && (
            <s-banner tone={freshnessTone} heading="Sync freshness">
              <s-paragraph>{freshness.message}</s-paragraph>
            </s-banner>
          )}
          {dataHealth.paused && (
            <s-banner tone="critical" heading="Reorder decisions are paused">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  Store data currently fails a blocking check, so advice stays
                  visible for reference but shouldn’t drive a purchase.
                </s-paragraph>
                {dataHealth.pauseReasons.map((reason) => (
                  <s-paragraph key={reason}>• {reason}</s-paragraph>
                ))}
                <s-link href="/app/data-health">
                  Review data health details →
                </s-link>
              </s-stack>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {!onboardingComplete && (
        <s-section heading="Get to your first reliable advice">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {formatQuantity(onboarding.filter((step) => step.done).length)} of{" "}
              {formatQuantity(onboarding.length)} done.
            </s-paragraph>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
              gap="base"
            >
              {onboarding.map((step, index) => {
                // 第一个未完成的步骤才是此刻该做的事；后面的只标状态，不给按钮。
                const isNext =
                  !step.done &&
                  onboarding
                    .slice(0, index)
                    .every((earlier) => earlier.done || earlier.key === "params");
                return (
                  <s-box
                    key={step.key}
                    padding="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">
                        {step.done
                          ? "✓ "
                          : isNext
                            ? "▸ "
                            : `${index + 1}. `}
                        {step.title}
                      </s-text>
                      <s-paragraph>{step.hint}</s-paragraph>
                      {isNext && <s-button href={step.href} variant="secondary">{step.cta}</s-button>}
                    </s-stack>
                  </s-box>
                );
              })}
            </s-grid>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Reorder decision board">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
            gap="base"
          >
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text type="strong">
                {formatQuantity(board.counts.pending)}
              </s-text>
              <s-paragraph>Pending review</s-paragraph>
            </s-box>
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text type="strong">
                {formatQuantity(board.counts.paused)}
              </s-text>
              <s-paragraph>Paused</s-paragraph>
            </s-box>
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text type="strong">
                {formatQuantity(board.counts.ordered)}
              </s-text>
              <s-paragraph>Ordered</s-paragraph>
            </s-box>
            <s-box padding="base" borderRadius="base" background="subdued">
              <s-text type="strong">
                {formatQuantity(board.counts.ignored)}
              </s-text>
              <s-paragraph>Ignored</s-paragraph>
            </s-box>
          </s-grid>

          {advice.length === 0 ? (
            <EmptyState
              heading={
                snapshotDate
                  ? "Nothing needs a purchase order right now"
                  : "No inventory snapshot yet"
              }
              body={
                snapshotDate
                  ? "No variant currently has a positive reorder suggestion, so the worklist is empty. Advice appears as soon as coverage drops below your lead time and review cycle."
                  : "Pick a location and run a sync on the Replenishment page to compute coverage and advice."
              }
              action={
                <s-button href="/app/inventory" variant="secondary">
                  Open Replenishment
                </s-button>
              }
            />
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Product / SKU</s-table-header>
                <s-table-header listSlot="labeled">Available</s-table-header>
                <s-table-header listSlot="labeled">
                  Stock status
                </s-table-header>
                <s-table-header listSlot="labeled">
                  Est. stockout
                </s-table-header>
                <s-table-header listSlot="labeled">Suggested</s-table-header>
                <s-table-header listSlot="labeled">Confidence</s-table-header>
                <s-table-header listSlot="inline">Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {advice.map((variant) => (
                  <s-table-row key={variant.id}>
                    <s-table-cell>
                      {variant.productTitle} — {variant.variantTitle}
                      <br />
                      SKU: {variant.sku || MISSING}
                    </s-table-cell>
                    <s-table-cell>
                      {formatQuantity(variant.available)}
                    </s-table-cell>
                    <s-table-cell>
                      <InventoryStatusBadge status={variant.status} />
                    </s-table-cell>
                    <s-table-cell>
                      {variant.daysOfInventory === null
                        ? "No sales observed"
                        : `${formatDecimal(variant.daysOfInventory)} days`}
                    </s-table-cell>
                    <s-table-cell>
                      {formatQuantity(variant.suggestedReorderQuantity)} units
                    </s-table-cell>
                    <s-table-cell>
                      <ConfidenceBadge level={variant.confidence.level} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button href="/app/inventory" variant="tertiary">
                        Review
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-link href="/app/inventory">
            Open action board <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Data health">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <s-text type="strong">Overall store data</s-text>
            <DataHealthStateBadge state={dataHealth.state} />
          </s-stack>
          {/* 数据可信时这里只留一句安静的新鲜度说明；不可信时由“概览”区画横幅，
              两处不重复说同一句话。 */}
          {!freshnessTone && <s-paragraph>{freshness.message}</s-paragraph>}
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
            gap="small"
          >
            {dataHealth.checks.map((check) => (
              <s-box
                key={check.key}
                padding="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="small">
                  <s-text>{check.label}</s-text>
                  <HealthBadge tone={check.tone} />
                </s-stack>
              </s-box>
            ))}
          </s-grid>
          <s-link href="/app/data-health">
            Details <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Replenishment settings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <ReadinessBadge
              kind={
                settings?.replenishmentSettingsSavedAt
                  ? "storeSettings"
                  : "systemEstimate"
              }
            />
          </s-paragraph>
          <FactGrid
            facts={[
              {
                label: "Lead time",
                value: settings
                  ? `${formatQuantity(settings.leadTimeDays)} days`
                  : MISSING,
              },
              {
                label: "Review cycle + safety",
                value: settings
                  ? `${formatQuantity(settings.reviewPeriodDays)} + ${formatQuantity(
                      settings.safetyStockDays,
                    )} days`
                  : MISSING,
              },
              {
                label: "Supplier terms",
                value:
                  supplierBoundCount > 0
                    ? `${formatQuantity(
                        supplierBoundCount,
                      )} SKUs on supplier MOQ terms`
                    : "No supplier terms bound yet",
              },
            ]}
          />
          <s-link href="/app/settings">
            Edit settings <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Purchase budget planner">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <s-text type="strong">Cash-aware purchase ranking</s-text>
            <ReadinessBadge kind="notEnabled" />
          </s-stack>
          <s-paragraph>
            Ranking purchases by cash on hand and supplier payment terms isn’t
            built yet, so no budget figures are shown here.
          </s-paragraph>
          <s-link href="/app/purchase-plans">
            Open Purchase Plans <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Recent decisions">
        <s-stack direction="block" gap="base">
          {recentDecisions.length === 0 ? (
            <EmptyState
              heading="No recorded decisions yet"
              body="Accepting, adjusting, ignoring or ordering advice adds an audited row here. Nothing has been written for this store yet."
              action={
                <s-button href="/app/inventory" variant="secondary">
                  Open Replenishment
                </s-button>
              }
            />
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="labeled">When</s-table-header>
                <s-table-header listSlot="labeled">Change</s-table-header>
                <s-table-header listSlot="labeled">Units</s-table-header>
                <s-table-header listSlot="labeled">By</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentDecisions.map((entry) => (
                  <s-table-row
                    key={`${entry.variantId}-${entry.createdAt.toISOString()}`}
                  >
                    <s-table-cell>
                      {namesByVariant.get(entry.variantId) ??
                        `Variant ${entry.variantId.split("/").pop()}`}
                      <br />
                      {entry.action.replace(/-/g, " ")}
                    </s-table-cell>
                    <s-table-cell>
                      {formatDateTime(entry.createdAt, timeZone)}
                    </s-table-cell>
                    <s-table-cell>
                      {isBusinessState(entry.fromStatus) ? (
                        <StatusBadge state={entry.fromStatus} />
                      ) : (
                        MISSING
                      )}{" "}
                      →{" "}
                      {isBusinessState(entry.toStatus) ? (
                        <StatusBadge state={entry.toStatus} />
                      ) : (
                        entry.toStatus
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {formatQuantity(entry.quantity || entry.suggestedQuantity)}
                    </s-table-cell>
                    <s-table-cell>{entry.operator ?? "unknown"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-link href="/app/inventory">
            View all <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Quick actions">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))"
          gap="base"
        >
          {[
            { href: "/app/inventory", label: "Replenishment" },
            { href: "/app/data-health", label: "Data health" },
            { href: "/app/settings", label: "Lead times" },
            { href: "/app/purchase-plans", label: "Purchase plans" },
          ].map((action) => (
            <s-box
              key={action.href}
              padding="base"
              borderRadius="base"
              background="subdued"
            >
              <s-link href={action.href}>{action.label}</s-link>
            </s-box>
          ))}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

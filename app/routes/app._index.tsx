import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getInventoryDashboard,
  getRecentRecommendationAudit,
  type DashboardVariant,
} from "../inventory.server";
import { trackDailyVisit } from "../analytics.server";
import { deriveOnboardingSteps } from "../lib/onboarding";
import { safeLoader } from "../lib/route-error";
import { buildSyncFreshnessNotice } from "../lib/sync-freshness";
import type { DataHealthState, DataHealthTone } from "../lib/data-health";
import {
  INVENTORY_STATUS_LABELS,
  type InventoryHealthStatus,
} from "../lib/inventory-calculations";
import type { ReorderConfidenceLevel } from "../lib/reorder-confidence";

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

  return { dashboard, recentDecisions, onboarding };
});

const CONFIDENCE_CLASS: Record<ReorderConfidenceLevel, string> = {
  high: "badgeHigh",
  medium: "badgeMedium",
  low: "badgeLow",
};

const CONFIDENCE_LABELS: Record<ReorderConfidenceLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const TONE_CLASS: Record<DataHealthTone, string> = {
  ok: "",
  warn: "isWarn",
  critical: "isCritical",
};

/** 看板整体健康态对应的颜色语气，paused 比 degraded 更重。 */
const STATE_TONE: Record<DataHealthState, DataHealthTone> = {
  healthy: "ok",
  degraded: "warn",
  paused: "critical",
};

/** 越靠前的库存状态越该先看，首页只给最紧急的几条。 */
const STATUS_PRIORITY: InventoryHealthStatus[] = [
  "stockout",
  "critical",
  "stockout_risk",
  "low_stock",
  "overstock",
  "dead_stock",
  "no_sales",
  "healthy",
];

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

function formatMoney(value: number, currencyCode: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatDateTime(value: Date | null | undefined): string {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "Not synced yet";
}

/** 库存决策首页：真实指标卡、优先建议、数据健康与最近决策。 */
export default function HomePage() {
  const { dashboard, recentDecisions, onboarding } =
    useLoaderData<typeof loader>();
  const { settings, metrics, variants, dataHealth, board, snapshotDate, syncStatus } =
    dashboard;
  const freshness = buildSyncFreshnessNotice(syncStatus, {
    lastSuccessLabel: syncStatus.lastSuccessfulSyncAt
      ? formatDateTime(syncStatus.lastSuccessfulSyncAt)
      : null,
  });
  const freshnessClass =
    TONE_CLASS[freshness.tone === "muted" ? "ok" : freshness.tone];
  const advice = priorityRows(variants, 4);
  const topAdvice = advice[0];
  const reviewedCount =
    board.counts.accepted +
    board.counts.edited +
    board.counts.ignored +
    board.counts.ordered;
  const currencyCode = settings?.currencyCode ?? "USD";
  const healthTone = TONE_CLASS[STATE_TONE[dataHealth.state]];
  const healthCopy =
    dataHealth.state === "paused"
      ? { title: "Reorder decisions paused", glyph: "!" }
      : dataHealth.state === "degraded"
        ? { title: "Data needs attention", glyph: "!" }
        : { title: "Data sync healthy", glyph: "✓" };
  const namesByVariant = new Map(
    variants.map((variant) => [
      variant.variantId,
      `${variant.productTitle} — ${variant.variantTitle}`,
    ]),
  );
  const supplierBoundCount = variants.filter(
    (variant) => variant.supplierTermsApplied !== null,
  ).length;

  const metricsCards = [
    {
      label: "Trackable SKUs",
      value: String(metrics.totalSkus),
      note: snapshotDate
        ? `Snapshot ${snapshotDate}`
        : "No inventory snapshot captured yet",
      tone: "tonePurple",
      icon: "▦",
    },
    {
      label: "Stockout risk",
      value: String(metrics.atRisk),
      note: "Out of stock, critical or short of lead time",
      tone: "toneRed",
      icon: "⚠",
    },
    {
      label: "Needs a decision",
      value: String(board.adoption.actionableCount),
      note: `${board.counts.pending} pending · ${reviewedCount} reviewed`,
      tone: "toneBlue",
      icon: "🛒",
    },
    {
      label: "Estimated inventory value",
      value: formatMoney(metrics.inventoryValue, currencyCode),
      note:
        metrics.variantsMissingCost > 0
          ? `${metrics.variantsMissingCost} variants missing a readable cost`
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
    <div className="ds">
      <section className="dsHero">
        <div className="dsHeroCopy">
          <span className="dsHeroTag">
            <img className="dsHeroTagLogo" src="/pi-logo.png" alt="" />
            mypi · Inventory Decision Intelligence
          </span>
          <h1 className="dsHeroTitle">
            Sharper replenishment,
            <br />
            steadier supply chain
          </h1>
          <p className="dsHeroSub">
            mypi turns your paid orders and current stock into reorder advice
            you can question, adjust and export — and tells you plainly when the
            data isn’t good enough to act on.
          </p>
          <div className="dsHeroActions">
            <Link className="dsBtnPrimary" to="/app/inventory">
              View reorder advice <span aria-hidden="true">→</span>
            </Link>
            <Link className="dsBtnGhost" to="/app/data-health">
              Check data health <span aria-hidden="true">▣</span>
            </Link>
          </div>
        </div>
        <div className="dsHeroArt" aria-hidden="true">
          <div className="dsArtMain">
            <span className="dsArtCheck">
              {topAdvice ? "↗" : dataHealth.paused ? "!" : "✓"}
            </span>
            <span className="dsArtLabel">
              {topAdvice ? "Top suggested purchase" : "Awaiting first sync"}
            </span>
            <span className="dsArtQty">
              {topAdvice
                ? `${topAdvice.suggestedReorderQuantity} units`
                : "No advice yet"}
            </span>
            <span className="dsArtEta">
              {topAdvice
                ? `${topAdvice.productTitle} · covers ${topAdvice.replenishment.coverageDays} days`
                : "Sync a location to start the daily snapshot series"}
            </span>
          </div>
          <div className="dsArtChip dsArtChipOne">
            <span>▤</span>
            <div>
              Observed demand
              <small>Visible days only</small>
            </div>
          </div>
          <div className="dsArtChip dsArtChipTwo">
            <span>▣</span>
            <div>
              Confidence notes
              <small>Why advice is lowered</small>
            </div>
          </div>
          <div className="dsArtChip dsArtChipThree">
            <span>◷</span>
            <div>
              Data health gate
              <small>Pauses when data is stale</small>
            </div>
          </div>
        </div>
      </section>

      {!onboarding.every((step) => step.done) && (
        <section className="dsPanel dsOnboarding" aria-label="Getting started">
          <div className="dsPanelHead">
            <span className="dsPanelTitle">
              <span aria-hidden="true">◍</span> Get to your first reliable
              advice
            </span>
            <span className="dsOnboardingCount">
              {onboarding.filter((step) => step.done).length} /{" "}
              {onboarding.length} done
            </span>
          </div>
          <ol className="dsOnboardingList">
            {onboarding.map((step, index) => {
              const firstOpen =
                !step.done &&
                onboarding
                  .slice(0, index)
                  .every((earlier) => earlier.done || earlier.key === "params");
              return (
                <li
                  key={step.key}
                  className={`dsOnboardingItem${step.done ? " isDone" : ""}${firstOpen ? " isOpen" : ""}`}
                >
                  <span className="dsOnboardingMark" aria-hidden="true">
                    {step.done ? "✓" : index + 1}
                  </span>
                  <div className="dsOnboardingBody">
                    <strong>{step.title}</strong>
                    <p>{step.hint}</p>
                  </div>
                  {!step.done && firstOpen && (
                    <Link className="dsBtnGhost" to={step.href}>
                      {step.cta} <span aria-hidden="true">→</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section className="dsMetrics" aria-label="Key metrics">
        {metricsCards.map((metric) => (
          <article className="dsMetric" key={metric.label}>
            <span className={`dsMetricIcon ${metric.tone}`} aria-hidden="true">
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

      <section className="dsMain">
        <div className="dsPanel">
          <div className="dsPanelHead">
            <span className="dsPanelTitle">
              <span aria-hidden="true">↗</span> Reorder decision board
            </span>
            <Link className="dsViewAll" to="/app/inventory">
              Open action board <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="dsTabs">
            <span className="dsTab isActive">
              Pending <b>{board.counts.pending}</b>
            </span>
            <span className="dsTab">
              Paused <b>{board.counts.paused}</b>
            </span>
            <span className="dsTab">
              Ordered <b>{board.counts.ordered}</b>
            </span>
            <span className="dsTab">
              Ignored <b>{board.counts.ignored}</b>
            </span>
          </div>
          <div className="dsTableWrap">
            {advice.length === 0 ? (
              <p className="dsEmptyRow">
                {snapshotDate
                  ? "Nothing needs a purchase order right now: no variant currently has a positive reorder suggestion."
                  : "No inventory snapshot yet. Pick a location and sync on the Replenishment page to compute coverage and advice."}
              </p>
            ) : (
              <table className="dsTable">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Available</th>
                    <th>Stock status</th>
                    <th>Est. stockout</th>
                    <th>Suggested</th>
                    <th>Confidence</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {advice.map((variant) => (
                    <tr key={variant.id}>
                      <td>
                        <span className="dsProduct">
                          <span className="dsThumb" aria-hidden="true">
                            ▣
                          </span>
                          {variant.productTitle} — {variant.variantTitle}
                        </span>
                        <br />
                        <span className="dsSku">{variant.sku || "No SKU"}</span>
                      </td>
                      <td>{variant.available}</td>
                      <td>{INVENTORY_STATUS_LABELS[variant.status]}</td>
                      <td className="dsStockout">
                        {variant.daysOfInventory === null
                          ? "No sales observed"
                          : `${Math.round(variant.daysOfInventory)} days`}
                      </td>
                      <td>{variant.suggestedReorderQuantity} units</td>
                      <td>
                        <span
                          className={`dsBadge ${CONFIDENCE_CLASS[variant.confidence.level]}`}
                        >
                          {CONFIDENCE_LABELS[variant.confidence.level]}
                        </span>
                      </td>
                      <td>
                        <Link className="dsRowBtn" to="/app/inventory">
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="dsRail">
          <div className="dsPanel dsHealth">
            <div className="dsPanelHead" style={{ padding: "0 0 4px" }}>
              <span className="dsPanelTitle">
                <span aria-hidden="true">✓</span> Data health
              </span>
              <Link className="dsViewAll" to="/app/data-health">
                Details <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className={`dsHealthState ${healthTone}`}>
              <span className={`dsHealthDot ${healthTone}`} aria-hidden="true">
                {healthCopy.glyph}
              </span>
              <div>
                <strong>{healthCopy.title}</strong>
                <span className={freshnessClass}>{freshness.message}</span>
              </div>
            </div>
            <div className="dsHealthRows">
              {dataHealth.checks.map((check) => (
                <div className="dsHealthRow" key={check.key}>
                  <span>{check.label}</span>
                  <em className={TONE_CLASS[check.tone]}>
                    {check.tone === "ok"
                      ? "Pass"
                      : check.tone === "warn"
                        ? "Needs attention"
                        : "Blocking"}
                  </em>
                </div>
              ))}
            </div>
          </div>

          <div className="dsBudget">
            <div className="dsBudgetHead">
              Purchase budget planner{" "}
              <span className="dsBeta">Not enabled yet</span>
            </div>
            <p>
              Ranking purchases by cash on hand and supplier payment terms isn’t
              built yet, so no budget figures are shown here.
            </p>
            <Link to="/app/purchase-plans">
              Open Purchase Plans <span aria-hidden="true">→</span>
            </Link>
            <span className="dsBudgetArt" aria-hidden="true">
              🪙
            </span>
          </div>
        </div>
      </section>

      <section className="dsBottom">
        <div className="dsPanel dsCard">
          <div className="dsCardTitle">
            <h3>
              <span aria-hidden="true">⛓</span> Replenishment settings
            </h3>
            <Link className="dsViewAll" to="/app/settings">
              Edit <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="dsSupply">
            <div className="dsSupplyStat">
              <span>Lead time</span>
              <strong>
                {settings ? `${settings.leadTimeDays} days` : "—"}
              </strong>
              <em className="dsMetricTrend isPlain">
                {settings?.replenishmentSettingsSavedAt
                  ? "Store settings"
                  : "System estimate"}
              </em>
            </div>
            <div className="dsMap" aria-hidden="true">
              🌍
            </div>
            <div className="dsSupplyStat">
              <span>Review cycle + safety</span>
              <strong>
                {settings
                  ? `${settings.reviewPeriodDays} + ${settings.safetyStockDays} days`
                  : "—"}
              </strong>
              <em className="dsMetricTrend isPlain">
                {supplierBoundCount > 0
                  ? `${supplierBoundCount} SKUs on supplier MOQ terms`
                  : "No supplier terms bound yet"}
              </em>
            </div>
          </div>
        </div>

        <div className="dsPanel dsCard">
          <div className="dsCardTitle">
            <h3>
              <span aria-hidden="true">▤</span> Recent decisions
            </h3>
            <Link className="dsViewAll" to="/app/inventory">
              View all <span aria-hidden="true">→</span>
            </Link>
          </div>
          {recentDecisions.length === 0 ? (
            <p className="dsEmptyRow">
              No recorded decisions yet. Accepting, adjusting, ignoring or
              ordering advice adds an audited row here.
            </p>
          ) : (
            recentDecisions.map((entry) => (
              <div
                className="dsPo"
                key={`${entry.variantId}-${entry.createdAt.toISOString()}`}
              >
                <div>
                  <span className="dsPoId">
                    {namesByVariant.get(entry.variantId) ??
                      `Variant ${entry.variantId.split("/").pop()}`}
                  </span>
                  <span className="dsPoMeta">
                    {entry.action.replace(/-/g, " ")} ·{" "}
                    {entry.fromStatus ? `${entry.fromStatus} → ` : ""}
                    {entry.toStatus}
                  </span>
                  <span className="dsPoMeta">
                    {formatDateTime(entry.createdAt)} ·{" "}
                    {entry.operator ?? "unknown"}
                  </span>
                </div>
                <span className="dsPill pillDraft">
                  {entry.quantity || entry.suggestedQuantity} units
                </span>
              </div>
            ))
          )}
        </div>

        <div className="dsPanel dsCard">
          <div className="dsCardTitle">
            <h3>
              <span aria-hidden="true">⚡</span> Quick actions
            </h3>
          </div>
          <div className="dsQuick">
            <Link to="/app/inventory">
              <span aria-hidden="true">↗</span>Replenishment
            </Link>
            <Link to="/app/data-health">
              <span aria-hidden="true">▣</span>Data health
            </Link>
            <Link to="/app/settings">
              <span aria-hidden="true">⚙</span>Lead times
            </Link>
            <Link to="/app/purchase-plans">
              <span aria-hidden="true">▤</span>Purchase plans
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

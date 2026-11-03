import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getInventoryDashboard } from "../inventory.server";
import { recentJobs } from "../sync-jobs.server";
import { safeLoader } from "../lib/route-error";
import { buildSyncFreshnessNotice } from "../lib/sync-freshness";
import {
  formatDateTime,
  formatDate,
  formatQuantity,
} from "../lib/format";
import { freshnessBannerTone, isBusinessState } from "../lib/status";
import { EmptyState } from "../components/ui/empty-state";
import { LoadingState } from "../components/ui/loading-state";
import {
  DataHealthStateBadge,
  HealthBadge,
  StatusBadge,
  SyncStatusBadge,
} from "../components/ui/status-badge";

/** 数据健康页：检查清单、恢复条件与同步台账，全部来自当前库内事实。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const canReadAllOrders =
    session.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("read_all_orders") ?? false;
  const [dashboard, jobs] = await Promise.all([
    getInventoryDashboard(session.shop, [], canReadAllOrders),
    recentJobs(session.shop, 15),
  ]);

  return {
    dataHealth: dashboard.dataHealth,
    settings: dashboard.settings,
    syncStatus: dashboard.syncStatus,
    snapshotDate: dashboard.snapshotDate,
    historyDaysAvailable: dashboard.historyDaysAvailable,
    board: dashboard.board,
    jobs,
  };
});

/** 每个检查项不达标时该做什么，和 data-health 的检查 key 一一对应。 */
const RECOVERY_HINTS: Record<string, string> = {
  authorization:
    "Re-authorize the app so a background session is stored again; webhooks and scheduled syncs can't read the store without it.",
  primary_location:
    "Choose a primary inventory location on the Replenishment page, then run a sync.",
  inventory_snapshot:
    "Run a sync on the Replenishment page. A fresh snapshot clears the stale-data pause immediately.",
  sales_history:
    "Sync order history. To cover more than 60 days, wait for Shopify to approve read_all_orders historical order access, then re-authorize.",
  sync_failures:
    "Fix the reported sync error, then run a manual sync. One successful run clears the failure streak.",
  product_cost:
    "Give the app the “view product costs” permission so inventory value stops being an estimate.",
};

export default function DataHealthPage() {
  const {
    dataHealth,
    settings,
    syncStatus,
    snapshotDate,
    historyDaysAvailable,
    board,
    jobs,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isRefreshing = navigation.state === "loading";
  const timeZone = settings?.timezone ?? null;
  const freshness = buildSyncFreshnessNotice(syncStatus, {
    lastSuccessLabel: syncStatus.lastSuccessfulSyncAt
      ? formatDateTime(syncStatus.lastSuccessfulSyncAt, timeZone)
      : null,
  });
  // 只有数据不可信或还没数据时才画横幅；全绿的时候不给商家看一条没有信息量的绿条。
  const freshnessTone = freshnessBannerTone(freshness.tone);
  const failingChecks = dataHealth.checks.filter(
    (check) => check.tone !== "ok",
  );
  const snapshotAge =
    dataHealth.snapshotAgeHours === null
      ? "No snapshot captured yet"
      : `Newest snapshot captured ${formatQuantity(
          Math.round(dataHealth.snapshotAgeHours),
        )} h ago`;

  return (
    <s-page heading="Data Health">
      <s-section heading="Status">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            <DataHealthStateBadge state={dataHealth.state} />
          </s-paragraph>
          {dataHealth.paused ? (
            <s-paragraph>
              <strong>Reorder decisions are paused.</strong> The store data
              behind the numbers currently fails a blocking check, so advice
              stays visible for reference but can’t be accepted, adjusted or
              ordered.
              {board.counts.paused > 0 &&
                ` ${formatQuantity(board.counts.paused)} recommendations are held in Paused.`}
            </s-paragraph>
          ) : (
            <s-paragraph>
              {dataHealth.state === "healthy"
                ? "Every blocking check passes, so replenishment advice is safe to act on."
                : "Advice is active. Some non-blocking checks need attention and currently lower recommendation confidence."}
            </s-paragraph>
          )}
          <s-paragraph>
            {settings?.locationName
              ? `Coverage reads ${settings.locationName}. `
              : "No location selected. "}
            {snapshotDate
              ? `Snapshot date ${formatDate(snapshotDate, timeZone)}. `
              : ""}
            {snapshotAge}. Sales history readable for{" "}
            {formatQuantity(historyDaysAvailable)} days.
          </s-paragraph>
          <s-link href="/app/inventory">
            Open Replenishment <span aria-hidden="true">→</span>
          </s-link>
        </s-stack>
      </s-section>

      <s-section heading="Sync status">
        {isRefreshing && <LoadingState label="Refreshing data health…" />}
        <s-stack direction="block" gap="small">
          {freshnessTone && (
            <s-banner tone={freshnessTone} heading="Sync freshness">
              <s-paragraph>{freshness.message}</s-paragraph>
            </s-banner>
          )}
          {/* 真机取证：`s-paragraph` 里「前置裸文本 + 内联自定义元素」混排时，
              前置文本会被 Polaris 的默认 slot 丢掉（曾渲染成 ". Last sync attempt:"）。
              徽章一律和自己的说明文字分块，不混进同一个段落开头。 */}
          <s-stack direction="inline" gap="small">
            <s-text type="strong">Current status</s-text>
            <SyncStatusBadge current={syncStatus.current} />
          </s-stack>
          <s-paragraph>
            Last sync attempt:{" "}
            {formatDateTime(syncStatus.lastSyncAttemptAt, timeZone)}. Last
            successful sync:{" "}
            {formatDateTime(syncStatus.lastSuccessfulSyncAt, timeZone)}.
          </s-paragraph>
          {syncStatus.lastSyncError && (
            <s-paragraph>
              Last failure reason: {syncStatus.lastSyncError}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Checks">
        {dataHealth.checks.length === 0 ? (
          <EmptyState
            heading="No checks to report"
            body="This store has no data-foundation checks yet, which normally means nothing has been synced. Run a sync on the Replenishment page and the checklist will appear here."
          />
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Check</s-table-header>
              <s-table-header listSlot="labeled">Result</s-table-header>
              <s-table-header listSlot="labeled">Detail</s-table-header>
              <s-table-header listSlot="labeled">
                Affects advice
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {dataHealth.checks.map((check) => (
                <s-table-row key={check.key}>
                  <s-table-cell>{check.label}</s-table-cell>
                  <s-table-cell>
                    <HealthBadge tone={check.tone} />
                  </s-table-cell>
                  <s-table-cell>{check.detail}</s-table-cell>
                  <s-table-cell>
                    {check.blocksRecommendations
                      ? "Blocking — pauses decisions"
                      : "Non-blocking — lowers confidence"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="How to resume">
        {failingChecks.length === 0 ? (
          <s-paragraph>
            Nothing to fix. Scheduled and webhook syncs keep the snapshot
            fresh; decisions unlock automatically as soon as every blocking
            check passes.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="small">
            {failingChecks.map((check) => (
              <s-paragraph key={check.key}>
                <strong>{check.label}</strong> —{" "}
                {RECOVERY_HINTS[check.key] ??
                  "Resolve this check, then run a sync on the Replenishment page."}
              </s-paragraph>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Sync ledger">
        {jobs.length === 0 ? (
          <EmptyState
            heading="No sync has run yet"
            body="Every manual, scheduled and webhook run is recorded here with its outcome. Run a sync on the Replenishment page and its result lands in this ledger."
          />
        ) : (
          <>
            <s-paragraph>Last {formatQuantity(jobs.length)} jobs</s-paragraph>
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Job</s-table-header>
                <s-table-header listSlot="labeled">Started</s-table-header>
                <s-table-header listSlot="labeled">Trigger</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
                <s-table-header listSlot="labeled">Records</s-table-header>
                <s-table-header listSlot="labeled">Detail</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {jobs.map((job) => (
                  <s-table-row
                    key={`${job.jobType}-${job.createdAt.toISOString()}`}
                  >
                    <s-table-cell>{job.jobType}</s-table-cell>
                    <s-table-cell>
                      {formatDateTime(
                        job.startedAt ?? job.createdAt,
                        timeZone,
                      )}
                    </s-table-cell>
                    <s-table-cell>{job.triggeredBy}</s-table-cell>
                    {/* 台账存的是数据库原值：认得的状态走统一徽章，认不出的原样显示，
                        这样历史脏数据不会被徽章吞掉（不改审计语义）。 */}
                    <s-table-cell>
                      {isBusinessState(job.status) ? (
                        <StatusBadge state={job.status} />
                      ) : (
                        job.status
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {formatQuantity(job.recordsProcessed)}
                    </s-table-cell>
                    <s-table-cell>
                      {job.error ?? formatDateTime(job.finishedAt, timeZone)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
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

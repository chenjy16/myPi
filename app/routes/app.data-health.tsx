import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getInventoryDashboard } from "../inventory.server";
import { recentJobs } from "../sync-jobs.server";
import { safeLoader } from "../lib/route-error";
import { buildSyncFreshnessNotice } from "../lib/sync-freshness";
import type { DataHealthTone } from "../lib/data-health";

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

const CHECK_PILL: Record<DataHealthTone, string> = {
  ok: "pillActive",
  warn: "pillDraft",
  critical: "pillCritical",
};

const CHECK_LABEL: Record<DataHealthTone, string> = {
  ok: "Pass",
  warn: "Needs attention",
  critical: "Blocking",
};

const JOB_STATUS_PILL: Record<string, string> = {
  succeeded: "pillActive",
  running: "pillMuted",
  failed: "pillCritical",
};

function formatDateTime(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
}

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
  const freshness = buildSyncFreshnessNotice(syncStatus, {
    lastSuccessLabel: syncStatus.lastSuccessfulSyncAt
      ? formatDateTime(syncStatus.lastSuccessfulSyncAt)
      : null,
  });
  const failingChecks = dataHealth.checks.filter(
    (check) => check.tone !== "ok",
  );
  const snapshotAge =
    dataHealth.snapshotAgeHours === null
      ? "No snapshot captured yet"
      : `Newest snapshot captured ${Math.round(dataHealth.snapshotAgeHours)} h ago`;

  return (
    <div className="ds">
      <s-page heading="Data Health">
        <s-section heading="Status">
          {dataHealth.paused ? (
            <p className="dsEmptyRow">
              <strong>Reorder decisions are paused.</strong> The store data
              behind the numbers currently fails a blocking check, so advice
              stays visible for reference but can’t be accepted, adjusted or
              ordered.
              {board.counts.paused > 0 &&
                ` ${board.counts.paused} recommendations are held in Paused.`}
            </p>
          ) : (
            <p className="dsEmptyRow">
              {dataHealth.state === "healthy"
                ? "Every blocking check passes, so replenishment advice is safe to act on."
                : "Advice is active. Some non-blocking checks need attention and currently lower recommendation confidence."}
            </p>
          )}
          <p className="dsEmptyRow">
            {settings?.locationName
              ? `Coverage reads ${settings.locationName}. `
              : "No location selected. "}
            {snapshotDate ? `Snapshot date ${snapshotDate}. ` : ""}
            {snapshotAge}. Sales history readable for {historyDaysAvailable}{" "}
            days.
          </p>
          <p className="dsEmptyRow">
            <Link className="dsViewAll" to="/app/inventory">
              Open Replenishment <span aria-hidden="true">→</span>
            </Link>
          </p>
        </s-section>

        <s-section heading="Sync status">
          <p className="dsEmptyRow">
            <strong>{freshness.message}</strong>
          </p>
          <p className="dsEmptyRow">
            Current status: <strong>{syncStatus.current}</strong>. Last sync
            attempt: {formatDateTime(syncStatus.lastSyncAttemptAt)}. Last
            successful sync: {formatDateTime(syncStatus.lastSuccessfulSyncAt)}.
          </p>
          {syncStatus.lastSyncError && (
            <p className="dsEmptyRow">
              Last failure reason: {syncStatus.lastSyncError}
            </p>
          )}
        </s-section>

        <s-section heading="Checks">
          <div className="dsTableWrap">
            <table className="dsTable">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Detail</th>
                  <th>Affects advice</th>
                </tr>
              </thead>
              <tbody>
                {dataHealth.checks.map((check) => (
                  <tr key={check.key}>
                    <td>{check.label}</td>
                    <td>
                      <span className={`dsPill ${CHECK_PILL[check.tone]}`}>
                        {CHECK_LABEL[check.tone]}
                      </span>
                    </td>
                    <td>{check.detail}</td>
                    <td>
                      {check.blocksRecommendations
                        ? "Blocking — pauses decisions"
                        : "Non-blocking — lowers confidence"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </s-section>

        <s-section heading="How to resume">
          {failingChecks.length === 0 ? (
            <p className="dsEmptyRow">
              Nothing to fix. Scheduled and webhook syncs keep the snapshot
              fresh; decisions unlock automatically as soon as every blocking
              check passes.
            </p>
          ) : (
            failingChecks.map((check) => (
              <p className="dsEmptyRow" key={check.key}>
                <strong>{check.label}</strong> —{" "}
                {RECOVERY_HINTS[check.key] ??
                  "Resolve this check, then run a sync on the Replenishment page."}
              </p>
            ))
          )}
        </s-section>

        <s-section heading="Sync ledger">
          <p className="dsEmptyRow">Last {jobs.length} jobs</p>
          {jobs.length === 0 ? (
            <p className="dsEmptyRow">
              No sync has run yet. Every manual, scheduled and webhook run is
              recorded here with its outcome.
            </p>
          ) : (
            <div className="dsTableWrap">
              <table className="dsTable">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Job</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Records</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={`${job.jobType}-${job.createdAt.toISOString()}`}>
                      <td>{formatDateTime(job.startedAt ?? job.createdAt)}</td>
                      <td>{job.jobType}</td>
                      <td>{job.triggeredBy}</td>
                      <td>
                        <span
                          className={`dsPill ${
                            JOB_STATUS_PILL[job.status] ?? "pillMuted"
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td>{job.recordsProcessed}</td>
                      <td>{job.error ?? formatDateTime(job.finishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>

        <s-section heading="App navigation">
          <div className="dsQuick">
            <Link to="/app">
              <span aria-hidden="true">⌂</span>Home
            </Link>
            <Link to="/app/inventory">
              <span aria-hidden="true">↗</span>Replenishment
            </Link>
            <Link to="/app/settings">
              <span aria-hidden="true">⚙</span>Settings
            </Link>
          </div>
        </s-section>
      </s-page>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

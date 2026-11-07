import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { AUTOMATION_ENABLED } from "../features";
import { getDashboardMetrics } from "../dashboard-metrics.server";
import { safeLoader } from "../lib/route-error";
import { formatDateTime, formatRate, formatQuantity } from "../lib/format";
import { KpiCard } from "../components/ui/kpi-card";
import { EmptyState } from "../components/ui/empty-state";
import { LoadingState } from "../components/ui/loading-state";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import type { DashboardMetrics } from "../lib/dashboard-metrics";

/**
 * V2.0 首页 · 自动化运行控制台（UI Alignment R1-B3）。
 * 定位与 Automation Center 严格分离：本页回答「系统跑得怎么样」，
 * Center 回答「我可以自动化哪些事」。KPI 全部来自 ExecutionLog / Automation
 * 真实计数，口径与 P4-17 /health 探针一致（无终态样本时 rate=null，
 * 不谎报 100%）。AUTOMATION_ENABLED 关闭时 302 到 /app/overview 保留旧 V1 首页。
 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  // flag 关时：不改行为、不换页面内容——把用户带到旧 V1「At a glance」。
  if (!AUTOMATION_ENABLED) throw redirect("/app/overview");

  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const metrics = await getDashboardMetrics(shop.id);
  return { metrics, timezone: shop.timezone };
});

/** 24h 窗口口径展示：无终态样本时诚实 N/A，不填 0 也不填 100。 */
function successRateDisplay(m: DashboardMetrics): {
  value: string | null;
  note: string;
} {
  const r = m.kpis.successRate;
  if (r.rate === null) {
    return { value: null, note: "No completed runs in the last 24h yet" };
  }
  return {
    value: formatRate(r.rate),
    note: `${formatQuantity(r.succeeded + r.partial)} of ${formatQuantity(r.terminalTotal)} terminal runs succeeded`,
  };
}

export default function Dashboard() {
  const { metrics, timezone } = useLoaderData<typeof loader>();

  // flag 关闭时 loader 已经 302 走了；这里只在 flag 打开路径上渲染。
  if (!AUTOMATION_ENABLED) return <LoadingState label="Loading…" />;

  const rate = successRateDisplay(metrics);
  const showEmpty = !metrics.hasAutomations;

  return (
    <s-page heading="Dashboard">
      <s-section heading="Monitor your automations and store activity">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-button href="/app/automation/templates" variant="primary">
              Create Automation
            </s-button>
            <s-button href="/app/automation/templates" variant="secondary">
              Browse Templates
            </s-button>
          </s-stack>
          <section className="dsMetrics" aria-label="Key metrics">
            <KpiCard
              label="Active Automations"
              value={metrics.kpis.activeAutomations}
              note="Running rules on this store"
              tone="tonePurple"
              icon="⚡"
              href="/app/automation/automations"
            />
            <KpiCard
              label="Total Executions"
              value={metrics.kpis.totalExecutions}
              note="Lifetime ExecutionLog rows"
              tone="toneBlue"
              icon="≡"
              href="/app/automation/activity"
            />
            <KpiCard
              label="Success Rate (24h)"
              value={rate.value}
              note={rate.note}
              tone="toneGreen"
              icon="✓"
              href="/app/automation/activity"
            />
            <KpiCard
              label="Failed Executions (24h)"
              value={metrics.kpis.failedExecutions24h}
              note="Only FAILED status counts; SKIPPED is not failure"
              tone="toneRed"
              icon="⚠"
              href="/app/automation/activity?status=FAILED&days=1"
            />
          </section>
        </s-stack>
      </s-section>

      {showEmpty ? (
        <s-section heading="Start automating your Shopify store">
          <EmptyState
            heading="Start automating your Shopify store"
            body="Create your first automation to reduce repetitive work and keep your store running smoothly."
            action={
              <s-stack direction="inline" gap="small">
                <s-link href="/app/automation/templates">
                  Create your first automation →
                </s-link>
                <s-link href="/app/automation/templates">
                  Explore templates
                </s-link>
              </s-stack>
            }
          />
        </s-section>
      ) : (
        <>
          <s-section heading="Automation health">
            <s-stack direction="block" gap="small">
              <s-paragraph>
                Success {formatQuantity(metrics.kpis.successRate.succeeded)} ·
                Partial {formatQuantity(metrics.kpis.successRate.partial)} ·
                Failed {formatQuantity(metrics.kpis.successRate.failed)} ·
                Terminal {formatQuantity(metrics.kpis.successRate.terminalTotal)}{" "}
                in the last 24h. SKIPPED and in-flight rows are intentionally
                excluded from the rate.
              </s-paragraph>
            </s-stack>
          </s-section>

          <s-section heading="Active automations">
            {metrics.activeAutomations.length === 0 ? (
              <s-paragraph>
                No automations are currently active. Enable one from{" "}
                <s-link href="/app/automation/templates">Templates</s-link> or
                manage existing rules in{" "}
                <s-link href="/app/automation/automations">My Automations</s-link>.
              </s-paragraph>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Automation</s-table-header>
                  <s-table-header listSlot="labeled">Trigger</s-table-header>
                  <s-table-header listSlot="labeled">Status</s-table-header>
                  <s-table-header listSlot="labeled">Executions</s-table-header>
                  <s-table-header listSlot="labeled">Success rate</s-table-header>
                  <s-table-header listSlot="labeled">Last run</s-table-header>
                  <s-table-header listSlot="inline">Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {metrics.activeAutomations.map((row) => (
                    <s-table-row key={row.id}>
                      <s-table-cell>
                        <Link to={`/app/automation/automations/${row.id}`}>
                          {row.name}
                        </Link>
                      </s-table-cell>
                      <s-table-cell>{row.trigger}</s-table-cell>
                      <s-table-cell>
                        <AutomationStatusBadge status={row.status} />
                      </s-table-cell>
                      <s-table-cell>{formatQuantity(row.executions)}</s-table-cell>
                      <s-table-cell>
                        {row.successRate === null
                          ? "N/A"
                          : formatRate(row.successRate)}
                      </s-table-cell>
                      <s-table-cell>
                        {row.lastRun ? (
                          <s-stack direction="inline" gap="small">
                            <AutomationStatusBadge status={row.lastRun.status} />
                            <s-text>
                              {formatDateTime(row.lastRun.at, timezone)}
                            </s-text>
                          </s-stack>
                        ) : (
                          <s-text>Not run yet</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small">
                          <s-link href={`/app/automation/automations/${row.id}`}>
                            View
                          </s-link>
                        </s-stack>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <s-link href="/app/automation/automations">
              View all automations →
            </s-link>
          </s-section>

          <s-section heading="Recent activity">
            {metrics.recentActivity.length === 0 ? (
              <s-paragraph>
                Nothing has run yet. Activity will show up here as your
                automations fire.
              </s-paragraph>
            ) : (
              <div className="autTimeline">
                {metrics.recentActivity.map((run) => (
                  <div className="autTimelineRow" key={run.executionId}>
                    <s-stack direction="inline" gap="small">
                      <AutomationStatusBadge status={run.status} />
                      <s-text>{run.automationName}</s-text>
                      <s-text>{run.trigger}</s-text>
                      <s-text>{formatDateTime(run.when, timezone)}</s-text>
                      <Link to={`/app/automation/activity/${run.executionId}`}>
                        View →
                      </Link>
                    </s-stack>
                  </div>
                ))}
              </div>
            )}
            <s-link href="/app/automation/activity">Open Activity Logs →</s-link>
          </s-section>

          <s-section heading="Quick start">
            <s-stack direction="inline" gap="small">
              <s-button href="/app/automation/templates" variant="secondary">
                Create Automation
              </s-button>
              <s-button href="/app/automation/templates" variant="tertiary">
                Browse Templates
              </s-button>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

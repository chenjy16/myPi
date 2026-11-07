import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { formatDateTime } from "../lib/format";
import { activityService } from "../activity.server";
import { automationsService } from "../automations.server";
import { triggerSummary } from "../lib/automation-wizard";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";

const DAY = 24 * 60 * 60 * 1000;
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "SUCCESS", label: "Succeeded" },
  { value: "PARTIAL_SUCCESS", label: "Partially done" },
  { value: "FAILED", label: "Failed" },
  { value: "SKIPPED", label: "Skipped" },
  { value: "RUNNING", label: "Running" },
];

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || undefined;
  const automationId = url.searchParams.get("automationId") || undefined;
  const cursor = url.searchParams.get("cursor") || undefined;
  const days = Number(url.searchParams.get("days") ?? "") || undefined;
  const from = days && days > 0 ? new Date(Date.now() - days * DAY) : undefined;

  const [page, automations, totalCount] = await Promise.all([
    activityService.listRows(shop.id, { status, automationId, cursor, from, limit: 25 }),
    automationsService.list(shop.id),
    activityService.count(shop.id),
  ]);

  // Distinguish "no data at all" from "filters yield nothing"
  const hasActiveFilters = Boolean(status || automationId || days);

  return {
    timezone: shop.timezone,
    status,
    automationId,
    days: days ?? "",
    hasActiveFilters,
    totalCount,
    nextCursor: page.nextCursor,
    automationOptions: automations.map((a) => ({ id: a.id, name: a.name })),
    rows: page.items.map((r) => ({
      id: r.id,
      automationName: automations.find((a) => a.id === r.automationId)?.name ?? r.automationId,
      status: r.status,
      trigger: triggerSummary(r.triggerType),
      summary: r.summary,
      when: formatDateTime(r.createdAt, shop.timezone),
      retried: Boolean(r.parentExecutionId),
    })),
  };
});

export default function ActivityLogs() {
  const data = useLoaderData<typeof loader>();
  const filterQuery = buildFilterQuery(data);

  return (
    <s-page heading="Activity Logs">
      <s-section>
        <s-paragraph>
          Track every automation execution and troubleshoot issues.
        </s-paragraph>
      </s-section>

      <s-section>
        <Form method="get">
          <s-stack direction="block" gap="small">
            <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="small">
              <s-select label="Status" name="status" value={data.status ?? ""}>
                {STATUS_OPTIONS.map((o) => (
                  <s-option key={o.value} value={o.value} selected={(data.status ?? "") === o.value}>
                    {o.label}
                  </s-option>
                ))}
              </s-select>
              <s-select label="Automation" name="automationId" value={data.automationId ?? ""}>
                <s-option value="" selected={!data.automationId}>
                  All automations
                </s-option>
                {data.automationOptions.map((a) => (
                  <s-option key={a.id} value={a.id} selected={data.automationId === a.id}>
                    {a.name}
                  </s-option>
                ))}
              </s-select>
              <s-select label="Time range" name="days" value={String(data.days ?? "")}>
                <s-option value="" selected={!data.days}>
                  Any time
                </s-option>
                <s-option value="1" selected={data.days === 1}>
                  Last 24 hours
                </s-option>
                <s-option value="7" selected={data.days === 7}>
                  Last 7 days
                </s-option>
                <s-option value="30" selected={data.days === 30}>
                  Last 30 days
                </s-option>
              </s-select>
              <s-stack direction="inline" gap="small">
                <s-button type="submit" variant="secondary">
                  Apply
                </s-button>
                {data.hasActiveFilters && (
                  <s-link href="/app/automation/activity">Clear</s-link>
                )}
              </s-stack>
            </s-grid>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Runs (${data.rows.length})`}>
        {data.rows.length === 0 ? (
          data.totalCount === 0 ? (
            // Case A: No execution records exist at all
            <EmptyState
              heading="No activity yet"
              body="Your automation runs will appear here once an automation is triggered."
              action={
                <s-link href="/app/automation/templates">Browse Templates →</s-link>
              }
            />
          ) : (
            // Case B: No results match the current filters
            <EmptyState
              heading="No matching activity"
              body="Try adjusting your filters or selecting a wider time range."
              action={
                <s-link href="/app/automation/activity">Clear Filters →</s-link>
              }
            />
          )
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Automation</s-table-header>
              <s-table-header listSlot="labeled">Trigger</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header listSlot="labeled">Started At</s-table-header>
              <s-table-header listSlot="labeled">Summary</s-table-header>
              <s-table-header listSlot="inline">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      <span>{row.automationName}</span>
                      {row.retried ? <s-badge tone="info">retry</s-badge> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.trigger}</s-table-cell>
                  <s-table-cell>
                    <AutomationStatusBadge status={row.status} />
                  </s-table-cell>
                  <s-table-cell>{row.when}</s-table-cell>
                  <s-table-cell>{row.summary}</s-table-cell>
                  <s-table-cell>
                    <Link to={`/app/automation/activity/${row.id}`}>View details →</Link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {data.nextCursor ? (
          <s-stack direction="inline" gap="small">
            <s-link href={`/app/automation/activity?${filterQuery}&cursor=${encodeURIComponent(data.nextCursor)}`}>
              Load older runs →
            </s-link>
          </s-stack>
        ) : null}
      </s-section>
    </s-page>
  );
}

/** 保留当前筛选条件（不含游标），供“加载更多”拼下一页。 */
function buildFilterQuery(data: {
  status?: string;
  automationId?: string;
  days?: string | number;
}): string {
  const parts: string[] = [];
  if (data.status) parts.push(`status=${encodeURIComponent(data.status)}`);
  if (data.automationId) parts.push(`automationId=${encodeURIComponent(data.automationId)}`);
  if (data.days) parts.push(`days=${encodeURIComponent(String(data.days))}`);
  return parts.join("&");
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

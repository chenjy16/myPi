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

  const [page, automations] = await Promise.all([
    activityService.listRows(shop.id, { status, automationId, cursor, from, limit: 25 }),
    automationsService.list(shop.id),
  ]);

  return {
    timezone: shop.timezone,
    status,
    automationId,
    days: days ?? "",
    nextCursor: page.nextCursor,
    automationOptions: automations.map((a) => ({ id: a.id, name: a.name })),
    rows: page.items.map((r) => ({
      id: r.id,
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
      <s-section heading="Filters">
        <Form method="get">
          <s-stack direction="block" gap="small">
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="small">
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
              <s-select label="Time window" name="days" value={String(data.days ?? "")}>
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
            </s-grid>
            <s-button type="submit" variant="secondary">
              Apply filters
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Runs (${data.rows.length})`}>
        {data.rows.length === 0 ? (
          <EmptyState
            heading="No activity yet"
            body="Runs will appear here once one of your automations has fired. Adjust the filters to widen the search."
            action={<Link to="/app/automation/templates">Browse templates →</Link>}
          />
        ) : (
          <div className="autTimeline">
            {data.rows.map((row) => (
              <div className="autTimelineRow" key={row.id}>
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    <AutomationStatusBadge status={row.status} />
                    <s-paragraph>{row.trigger}</s-paragraph>
                    {row.retried ? <s-badge tone="info">retry</s-badge> : null}
                  </s-stack>
                  <s-paragraph>{row.summary}</s-paragraph>
                  <s-stack direction="inline" gap="small">
                    <s-text>{row.when}</s-text>
                    <Link to={`/app/automation/activity/${row.id}`}>View details →</Link>
                  </s-stack>
                </s-stack>
              </div>
            ))}
          </div>
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

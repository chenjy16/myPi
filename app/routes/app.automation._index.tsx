import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { formatDateTime } from "../lib/format";
import { automationsService } from "../automations.server";
import { activityService } from "../activity.server";
import { triggerSummary } from "../lib/automation-wizard";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import { FactGrid } from "../components/ui/fact-grid";
import { EmptyState } from "../components/ui/empty-state";

/** 按店铺时区把时刻归到"哪一天"（en-CA 给出 YYYY-MM-DD，避免 UTC 跨日误算今日数）。 */
function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);

  const [automations, recent, awaiting] = await Promise.all([
    automationsService.list(shop.id),
    activityService.list(shop.id, { limit: 100 }),
    activityService.awaitingCount(shop.id),
  ]);

  const activeCount = automations.filter((a) => a.status === "active").length;
  const today = dayKey(new Date(), shop.timezone);
  const todayRuns = recent.items.filter((e) => dayKey(e.createdAt, shop.timezone) === today).length;
  const recentFailures = recent.items.filter((e) => e.status === "FAILED").length;

  return {
    hasAutomations: automations.length > 0,
    metrics: [
      { label: "Active automations", value: String(activeCount) },
      { label: "Runs today", value: String(todayRuns) },
      { label: "Waiting for confirmation", value: String(awaiting) },
      { label: "Recent failures", value: String(recentFailures) },
    ],
    recentRuns: recent.items.slice(0, 6).map((e) => ({
      id: e.id,
      status: e.status,
      trigger: triggerSummary(e.triggerType),
      when: formatDateTime(e.createdAt, shop.timezone),
    })),
  };
});

export default function AutomationCenter() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Automation">
      <s-section heading="Overview">
        <FactGrid facts={data.metrics} />
      </s-section>

      {data.hasAutomations ? null : (
        <s-section heading="Get started">
          <EmptyState
            heading="No automations yet"
            body="Enable your first automation in about three minutes. Start with Low Stock — it runs end to end on your store's own data, so you can see a real result right away."
            action={
              <s-stack direction="inline" gap="small">
                <s-link href="/app/automation/templates/T4-low-stock">
                  Start with Low Stock →
                </s-link>
                <s-link href="/app/automation/templates">Browse all templates</s-link>
              </s-stack>
            }
          />
        </s-section>
      )}

      <s-section heading="Recent activity">
        {data.recentRuns.length === 0 ? (
          <s-paragraph>Nothing has run yet. Activity will show up here as your automations fire.</s-paragraph>
        ) : (
          <div className="autTimeline">
            {data.recentRuns.map((run) => (
              <div className="autTimelineRow" key={run.id}>
                <s-stack direction="inline" gap="small">
                  <AutomationStatusBadge status={run.status} />
                  <s-text>{run.trigger}</s-text>
                  <s-text>{run.when}</s-text>
                  <Link to={`/app/automation/activity/${run.id}`}>View →</Link>
                </s-stack>
              </div>
            ))}
          </div>
        )}
        <s-stack direction="inline" gap="small">
          <s-link href="/app/automation/activity">Open Activity Logs →</s-link>
          {data.metrics[2] && data.metrics[2].value !== "0" ? (
            <s-link href="/app/automation/activity?status=RUNNING">See runs waiting on you</s-link>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

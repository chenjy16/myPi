import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { toSafeError } from "../lib/app-error";
import { trackEvent } from "../analytics.server";
import { formatDateTime } from "../lib/format";
import { automationsService } from "../automations.server";
import { activityService } from "../activity.server";
import { triggerSummary } from "../lib/automation-wizard";
import { evaluateScopeGap, type ScopeGap } from "../lib/scope-guard";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ConfirmFetchForm } from "../components/ui/confirm-fetch-form";
import { ScopeGapBanner } from "../components/ui/scope-gap-banner";

type Row = {
  id: string;
  name: string;
  status: string;
  trigger: string;
  currentVersion: number | null;
  recentRun: { status: string; when: string } | null;
};

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const [automations, executions] = await Promise.all([
    automationsService.list(shop.id),
    activityService.list(shop.id, { limit: 100 }),
  ]);
  // 每个自动化最近一次执行（executions 已按 createdAt desc 排好，首见即最新）。
  const recentByAutomation = new Map<string, { status: string; createdAt: Date }>();
  for (const e of executions.items) {
    if (!recentByAutomation.has(e.automationId))
      recentByAutomation.set(e.automationId, { status: e.status, createdAt: e.createdAt });
  }
  const rows: Row[] = automations.map((a) => {
    const recent = recentByAutomation.get(a.id);
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      trigger: a.triggerType ? triggerSummary(a.triggerType) : "—",
      currentVersion: a.currentVersion,
      recentRun: recent
        ? { status: recent.status, when: formatDateTime(recent.createdAt, shop.timezone) }
        : null,
    };
  });
  // P4-06：本页所有自动化的动作合起来需要哪些写 scope，session.scope 里缺多少。
  // 保守并集：宁可在页头提示一次「重授权」，也不让单条自动化在运行时静默失败。
  const allActionIds = new Set<string>();
  for (const a of automations) for (const id of a.actionIds) allActionIds.add(id);
  const scopeGap: ScopeGap = evaluateScopeGap(session.scope, allActionIds);
  return { rows, scopeGap, shopDomain: session.shop };
});

type ActionResult = { notice?: string; error?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  try {
    switch (intent) {
      case "set-active":
        await automationsService.setActive(shop.id, id);
        void trackEvent(session.shop, "automation_status_changed", { id, to: "active" });
        return { notice: "Automation enabled." };
      case "pause":
        await automationsService.pause(shop.id, id);
        void trackEvent(session.shop, "automation_status_changed", { id, to: "paused" });
        return { notice: "Automation paused." };
      case "soft-delete":
        await automationsService.softDelete(shop.id, id);
        void trackEvent(session.shop, "automation_status_changed", { id, to: "deleted" });
        return { notice: "Automation removed. Its history is kept for auditing." };
      default:
        return { error: "Unsupported action." };
    }
  } catch (error) {
    return { error: toSafeError(error).message };
  }
};

export default function MyAutomations() {
  const { rows, scopeGap, shopDomain } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  return (
    <s-page heading="My Automations">
      {/* R2-A: 与 Dashboard/Automation Center 风格统一，提供快捷创建入口。 */}
      <s-stack direction="inline" gap="small">
        <s-button href="/app/automation/templates" variant="primary">
          Create Automation
        </s-button>
        <s-button href="/app/automation" variant="secondary">
          Explore Capabilities
        </s-button>
      </s-stack>
      {scopeGap.ok ? null : (
        <s-section>
          <ScopeGapBanner gap={scopeGap} shopDomain={shopDomain} />
        </s-section>
      )}
      <s-section heading={`Automations (${rows.length})`}>
        <s-stack direction="block" gap="small">
          {data?.notice ? (
            <s-banner tone="success" heading="Done">{data.notice}</s-banner>
          ) : null}
          {data?.error ? (
            <s-banner tone="critical" heading="Couldn't update">{data.error}</s-banner>
          ) : null}
        </s-stack>
      </s-section>

      <s-section>
        {rows.length === 0 ? (
          <EmptyState
            heading="No automations yet"
            body="Start from a template to enable your first automation in about three minutes."
            action={
              <s-link href="/app/automation/templates">Browse templates →</s-link>
            }
          />
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Automation</s-table-header>
              <s-table-header listSlot="labeled">Trigger</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header listSlot="labeled">Last run</s-table-header>
              <s-table-header listSlot="labeled">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <Link to={`/app/automation/automations/${row.id}`}>{row.name}</Link>
                    {row.currentVersion ? (
                      <s-paragraph>v{row.currentVersion}</s-paragraph>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>{row.trigger}</s-table-cell>
                  <s-table-cell>
                    <AutomationStatusBadge status={row.status} />
                  </s-table-cell>
                  <s-table-cell>
                    {row.recentRun ? (
                      <s-stack direction="inline" gap="small">
                        <AutomationStatusBadge status={row.recentRun.status} />
                        <s-paragraph>{row.recentRun.when}</s-paragraph>
                      </s-stack>
                    ) : (
                      <s-paragraph>Not run yet</s-paragraph>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value={row.status === "active" ? "pause" : "set-active"} />
                        <input type="hidden" name="id" value={row.id} />
                        <s-button type="submit" variant="tertiary" disabled={busy}>
                          {row.status === "active" ? "Pause" : "Enable"}
                        </s-button>
                      </fetcher.Form>
                      <ConfirmFetchForm
                        fetcher={fetcher}
                        confirm={{
                          heading: "Remove this automation?",
                          body: "It stops running. Its past runs are kept for auditing, but you can't undo this from here.",
                          confirmLabel: "Remove automation",
                          danger: true,
                        }}
                      >
                        <input type="hidden" name="intent" value="soft-delete" />
                        <input type="hidden" name="id" value={row.id} />
                        <s-button type="submit" variant="tertiary" disabled={busy}>
                          Remove
                        </s-button>
                      </ConfirmFetchForm>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

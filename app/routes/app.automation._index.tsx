import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { automationsService } from "../automations.server";
import {
  KNOWN_TRIGGER_TYPES,
  getTrigger,
  type TriggerDefinition,
} from "../lib/trigger-registry";
import { listActions, type ActionDefinition } from "../lib/action-registry";
import {
  LAUNCH_TEMPLATES,
  ALL_TEMPLATES,
  type TemplateDefinition,
} from "../lib/template-catalog";
import { EmptyState } from "../components/ui/empty-state";

/**
 * V2.0 UI Alignment R1-B4 · Automation Center。
 * 定位与 Dashboard 严格分离（PRD 决策 1）：
 *   - Dashboard 回答「跑得怎么样」（KPI / health / recent activity）
 *   - Center   回答「我能自动化什么」（Recommended / Scenarios / Triggers / Actions）
 * 生产级诚实边界（PRD 决策 3）：
 *   - Trigger / Action 全部从 registry 派生，availability / protectedCustomerData
 *     直连 trigger-registry；受 R1 审批墙阻塞的 order/customer 类明确标 PENDING，
 *     不再"假装在跑"。
 *   - Recommended 模板与 templates/{id} 详情页一一对应，trigger 与 action 已实现
 *     并有 P3-05 契约测覆盖，页面可点击 = 后端可执行。
 *   - Center 不再展示 KPI 数字，也不展示 Recent activity 时间线——这两块归 Dashboard。
 */

type ScenarioGroup = {
  category: string;
  templates: readonly TemplateDefinition[];
};

function groupByCategory(
  templates: readonly TemplateDefinition[],
): ScenarioGroup[] {
  const map = new Map<string, TemplateDefinition[]>();
  for (const t of templates) {
    const bucket = map.get(t.category) ?? [];
    bucket.push(t);
    map.set(t.category, bucket);
  }
  // 稳定顺序：按类别名 locale compare，避免每渲染抖动。
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, list]) => ({ category, templates: list }));
}

/** Trigger 可用性对商家的一句话（与 P4-17 health 口径一致，不粉饰）。 */
function triggerAvailabilityNote(t: TriggerDefinition): string {
  if (!t.protectedCustomerData && t.availability === "VERIFIED") {
    return "Ready to use on your store.";
  }
  if (t.availability === "PENDING") {
    return "Awaiting Shopify protected-data approval; templates using it will not fire yet.";
  }
  return "Verified.";
}

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);

  const automations = await automationsService.list(shop.id);
  const activeCount = automations.filter((a) => a.status === "active").length;

  return {
    hasAutomations: automations.length > 0,
    activeCount,
    recommended: LAUNCH_TEMPLATES.slice(0, 3),
    scenarios: groupByCategory(ALL_TEMPLATES),
    triggers: KNOWN_TRIGGER_TYPES.map((type) => getTrigger(type)),
    actions: listActions(),
  };
});

export default function AutomationCenter() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Automation Center">
      <s-section heading="What can you automate?">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Explore the scenarios mypi can run for you. Every trigger and action
            listed here is wired end-to-end — nothing shown as available unless
            it can actually fire on your store.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/automation/templates" variant="primary">
              Browse all templates
            </s-button>
            <s-button href="/app/automation/automations/new" variant="secondary">
              Create from scratch
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      {!data.hasAutomations && (
        <s-section heading="Start with a proven setup">
          <EmptyState
            heading="No automations yet"
            body="Enable your first automation in about three minutes. Start with Low Stock — it runs end to end on your store's own data, so you can see a real result right away."
            action={
              <s-stack direction="inline" gap="small">
                <s-link href="/app/automation/templates/T4-low-stock">
                  Start with Low Stock →
                </s-link>
                <s-link href="/app/automation/templates">
                  Browse all templates
                </s-link>
              </s-stack>
            }
          />
        </s-section>
      )}

      <s-section heading="Recommended for your store">
        <s-stack direction="inline" gap="small">
          {data.recommended.map((t) => (
            <s-box padding="base" borderRadius="base" background="subdued" key={t.id}>
              <s-stack direction="block" gap="small">
                <s-heading>{t.name}</s-heading>
                <s-paragraph>{t.oneLine}</s-paragraph>
                <s-stack direction="block" gap="small">
                  {t.stepsPreview.map((step, i) => (
                    <s-text key={`${t.id}-step-${i}`}>
                      {i + 1}. {step}
                    </s-text>
                  ))}
                </s-stack>
                {t.requiresProtectedData ? (
                  <s-text>
                    Requires Shopify protected-data approval
                  </s-text>
                ) : null}
                <s-link href={`/app/automation/templates/${t.id}`}>
                  Use this template →
                </s-link>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Explore by scenario">
        <s-stack direction="block" gap="small">
          {data.scenarios.map((group) => (
            <s-stack direction="inline" gap="small" key={group.category}>
              <s-heading>{group.category}</s-heading>
              {group.templates.map((t) => (
                <s-link key={t.id} href={`/app/automation/templates/${t.id}`}>
                  {t.name}
                </s-link>
              ))}
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Available triggers">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Event</s-table-header>
            <s-table-header listSlot="labeled">Source</s-table-header>
            <s-table-header listSlot="labeled">Status</s-table-header>
            <s-table-header listSlot="labeled">Notes</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.triggers.map((t) => (
              <s-table-row key={t.type}>
                <s-table-cell>{t.type}</s-table-cell>
                <s-table-cell>
                  {t.source === "scheduler"
                    ? "Daily schedule"
                    : t.topic
                      ? `Shopify · ${t.topic}`
                      : "Shopify webhook"}
                </s-table-cell>
                <s-table-cell>
                  <s-text>{t.availability}</s-text>
                </s-table-cell>
                <s-table-cell>{triggerAvailabilityNote(t)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Available actions">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Action</s-table-header>
            <s-table-header listSlot="labeled">Targets</s-table-header>
            <s-table-header listSlot="labeled">Risk</s-table-header>
            <s-table-header listSlot="labeled">Confirmation</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.actions.map((a: ActionDefinition) => (
              <s-table-row key={a.actionId}>
                <s-table-cell>{a.actionId}</s-table-cell>
                <s-table-cell>
                  {a.targetEntities.length > 0
                    ? a.targetEntities.join(", ")
                    : "—"}
                </s-table-cell>
                <s-table-cell>{a.riskLevel}</s-table-cell>
                <s-table-cell>{a.confirmation}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-paragraph>
          Every action listed here is implemented in the executor and covered by
          contract tests. Risk level and confirmation mode come from
          action-registry — not hand-written copy.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

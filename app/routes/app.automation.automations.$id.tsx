import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { toSafeError } from "../lib/app-error";
import { trackEvent } from "../analytics.server";
import { formatDateTime } from "../lib/format";
import { automationsService } from "../automations.server";
import { activityService } from "../activity.server";
import { AutomationNotFoundError, AutomationValidationError } from "../lib/automations-core";
import { getTemplate, type TemplateDefinition } from "../lib/template-catalog";
import {
  describePlan,
  validateTemplateParams,
} from "../lib/automation-wizard";
import { buildHumanSummary } from "../lib/activity";
import type { CompiledPlan } from "../lib/automation-compiler";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import { ScopeGapBanner } from "../components/ui/scope-gap-banner";
import { evaluateScopeGap, type ScopeGap } from "../lib/scope-guard";

function currentParamValues(
  plan: CompiledPlan,
  template: TemplateDefinition,
): Record<string, string> {
  const clause0 = plan.conditions.clauses[0]?.value;
  const action0 = plan.actions[0];
  const out: Record<string, string> = {};
  for (const p of template.params) {
    switch (p.key) {
      case "amount":
      case "threshold":
      case "keyword":
        out[p.key] = clause0 !== undefined ? String(clause0) : "";
        break;
      case "tag":
        out[p.key] = action0?.params.tag ? String(action0.params.tag) : "";
        break;
      case "template":
        out[p.key] = action0?.params.template ? String(action0.params.template) : "";
        break;
      case "recipient":
        out[p.key] = action0?.params.to ? String(action0.params.to) : "";
        break;
      default:
        out[p.key] = p.default !== undefined ? String(p.default) : "";
    }
  }
  return out;
}

export const loader = safeLoader(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  let detail;
  try {
    detail = await automationsService.get(shop.id, params.id ?? "");
  } catch (error) {
    if (error instanceof AutomationNotFoundError)
      throw new Response("Automation not found", { status: 404 });
    throw error;
  }
  const plan = detail.currentVersion?.plan ?? null;
  const readable = plan ? describePlan(plan) : null;
  const template = detail.currentVersion?.templateId
    ? getTemplate(detail.currentVersion.templateId)
    : undefined;
  const executions = await activityService.list(shop.id, {
    automationId: detail.id,
    limit: 10,
  });
  // P4-06：本自动化当前版本的写动作需要哪些 scope，session 里缺多少。
  const actionIds = plan ? plan.actions.map((a) => a.actionId) : [];
  const scopeGap: ScopeGap = evaluateScopeGap(session.scope, actionIds);
  return {
    shopDomain: session.shop,
    scopeGap,
    automation: {
      id: detail.id,
      name: detail.name,
      status: detail.status,
      requiresProtectedData: detail.requiresProtectedData,
      version: detail.currentVersion?.version ?? null,
      templateId: detail.currentVersion?.templateId ?? null,
      trigger: readable?.trigger ?? "—",
      conditions: readable?.conditions ?? [],
      actions: readable?.actions ?? [],
    },
    editableParams: template
      ? {
          templateId: template.id,
          fields: template.params.map((p) => ({
            key: p.key,
            label: p.label,
            type: p.type,
            required: p.required,
            options: p.options ? [...p.options] : undefined,
            value: plan ? currentParamValues(plan, template)[p.key] : String(p.default ?? ""),
          })),
        }
      : null,
    recentRuns: executions.items.map((e) => ({
      id: e.id,
      status: e.status,
      when: formatDateTime(e.createdAt, shop.timezone),
      summary: buildHumanSummary(e, []),
    })),
  };
});

type ActionData = { fieldErrors?: Record<string, string>; error?: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent !== "update-params") return { error: "Unsupported action." } satisfies ActionData;
    const detail = await automationsService.get(shop.id, params.id ?? "");
    const templateId = detail.currentVersion?.templateId;
    const template = templateId ? getTemplate(templateId) : undefined;
    if (!template) return { error: "This automation can't be edited by parameters." } satisfies ActionData;

    const raw: Record<string, string | undefined> = {};
    for (const p of template.params) {
      const v = form.get(`param_${p.key}`);
      raw[p.key] = v === null ? undefined : String(v);
    }
    const { ok, values, fieldErrors } = validateTemplateParams(template, raw);
    if (!ok) return { fieldErrors } satisfies ActionData;

    await automationsService.updateParams(shop.id, detail.id, values);
    void trackEvent(session.shop, "automation_updated", { id: detail.id, templateId: template.id });
    throw redirect(`/app/automation/automations/${detail.id}?saved=1`);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof AutomationValidationError)
      return { error: error.errors[0] ?? error.message } satisfies ActionData;
    return { error: toSafeError(error).message } satisfies ActionData;
  }
};

export default function AutomationDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const fieldErrors = actionData?.fieldErrors ?? {};
  const a = data.automation;

  return (
    <s-page heading={a.name}>
      <s-section heading="Status">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <AutomationStatusBadge status={a.status} />
            {a.version ? <s-paragraph>Version {a.version}</s-paragraph> : null}
          </s-stack>
          {a.requiresProtectedData && a.status === "active" ? (
            <s-banner tone="warning" heading="Enabled, waiting on data access">
              Enabled. It starts running automatically once protected order or
              customer data access is approved for your store. It is not
              pretending to run in the meantime.
            </s-banner>
          ) : null}
          {data.scopeGap.ok ? null : (
            <ScopeGapBanner gap={data.scopeGap} shopDomain={data.shopDomain} />
          )}
          <Link to="/app/automation/automations">← Back to My Automations</Link>
        </s-stack>
      </s-section>

      <s-section heading="What it does">
        <s-stack direction="block" gap="small">
          <s-text type="strong">{a.trigger}</s-text>
          {a.conditions.length ? (
            <s-stack direction="block" gap="small">
              <s-paragraph>Run only when:</s-paragraph>
              <ul className="autStepList">
                {a.conditions.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </s-stack>
          ) : null}
          <s-paragraph>Then it will:</s-paragraph>
          <ol className="autStepList">
            {a.actions.map((act, i) => (
              <li key={i}>{act}</li>
            ))}
          </ol>
        </s-stack>
      </s-section>

      {data.editableParams ? (
        <s-section heading="Edit settings">
          <s-stack direction="block" gap="base">
            <s-banner tone="info" heading="Editing creates a new version">
              Your changes start a fresh version. Past runs stay recorded under
              the version that ran them.
            </s-banner>
            {actionData?.error ? (
              <s-banner tone="critical" heading="Couldn't save">{actionData.error}</s-banner>
            ) : null}
            <Form method="post">
              <input type="hidden" name="intent" value="update-params" />
              <s-stack direction="block" gap="base">
                {data.editableParams.fields.map((f) => {
                  const id = `param_${f.key}`;
                  const common = { id, name: id, label: f.label, required: f.required, error: fieldErrors[f.key] } as const;
                  return f.type === "email" ? (
                    <s-email-field {...common} defaultValue={f.value} key={f.key} />
                  ) : f.type === "number" || f.type === "amount" ? (
                    <s-number-field {...common} defaultValue={f.value} key={f.key} />
                  ) : f.type === "select" ? (
                    <s-select {...common} value={f.value} key={f.key}>
                      {(f.options ?? []).map((opt) => (
                        <s-option key={opt} value={opt} selected={opt === f.value}>
                          {opt}
                        </s-option>
                      ))}
                    </s-select>
                  ) : (
                    <s-text-field {...common} defaultValue={f.value} key={f.key} />
                  );
                })}
                <s-button type="submit" variant="primary" disabled={submitting}>
                  Save changes
                </s-button>
              </s-stack>
            </Form>
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading={`Recent runs (${data.recentRuns.length})`}>
        {data.recentRuns.length === 0 ? (
          <s-paragraph>No runs recorded yet.</s-paragraph>
        ) : (
          <div className="autTimeline">
            {data.recentRuns.map((run) => (
              <div className="autTimelineRow" key={run.id}>
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small">
                    <AutomationStatusBadge status={run.status} />
                    <s-paragraph>{run.when}</s-paragraph>
                  </s-stack>
                  <s-paragraph>{run.summary}</s-paragraph>
                  <Link to={`/app/automation/activity/${run.id}`}>View run →</Link>
                </s-stack>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

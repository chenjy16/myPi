import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { toSafeError } from "../lib/app-error";
import { trackEvent } from "../analytics.server";
import { formatDateTime } from "../lib/format";
import { activityService } from "../activity.server";
import { automationsService } from "../automations.server";
import { buildHumanSummary } from "../lib/activity";
import {
  describeEvaluation,
  stepActionLabel,
  triggerSummary,
} from "../lib/automation-wizard";
import { AutomationStatusBadge } from "../components/ui/status-badge";
import {
  confirmStepAction,
  retryExecutionAction,
  evaluateRetryEligibility,
} from "../automation-ui-actions.server";

export const loader = safeLoader(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const executionId = params.executionId ?? "";
  const detail = await activityService.detail(shop.id, executionId);
  if (!detail) throw new Response("Run not found", { status: 404 });

  let automationName: string | null = null;
  try {
    const automation = await automationsService.get(shop.id, detail.automationId);
    automationName = automation.name;
  } catch {
    automationName = null; // 自动化可能已被移除，详情仍应可读
  }

  const [eligibility] = await Promise.all([
    evaluateRetryEligibility({ client: db }, shop.id, detail.id),
  ]);

  return {
    timezone: shop.timezone,
    execution: {
      id: detail.id,
      status: detail.status,
      trigger: triggerSummary(detail.triggerType),
      summary: buildHumanSummary(detail, detail.steps),
      when: formatDateTime(detail.createdAt, shop.timezone),
      automationName,
      automationId: detail.automationId,
    },
    condition: detail.conditionResult
      ? {
          passed: detail.conditionResult.result,
          logic: detail.conditionResult.logic,
          rows: describeEvaluation(detail.conditionResult),
        }
      : null,
    steps: detail.steps.map((s) => ({
      id: s.id,
      order: s.order,
      label: stepActionLabel(s.actionId),
      status: s.status,
      awaiting: s.status === "AWAITING_CONFIRMATION",
      errorText: s.errorText,
    })),
    lineage: {
      parent: detail.parent
        ? {
            id: detail.parent.id,
            status: detail.parent.status,
            when: formatDateTime(detail.parent.createdAt, shop.timezone),
          }
        : null,
      children: detail.children.map((c) => ({
        id: c.id,
        status: c.status,
        when: formatDateTime(c.createdAt, shop.timezone),
      })),
    },
    retry: eligibility
      ? { allowed: eligibility.allowed, reason: eligibility.reason ?? null }
      : { allowed: false, reason: "This run can't be evaluated right now." },
  };
});

type ActionData = { notice?: string; error?: string };

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const executionId = params.executionId ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "confirm-step") {
      const stepId = String(form.get("stepId") ?? "");
      const res = await confirmStepAction({ client: db, admin, requestSource: "automation-ui" }, {
        shopId: shop.id,
        stepId,
      });
      if (!res.ok) return { error: res.message } satisfies ActionData;
      void trackEvent(session.shop, "automation_step_confirmed", { executionId, stepId });
      return { notice: res.message } satisfies ActionData;
    }

    if (intent === "retry-all" || intent === "retry-failed") {
      const res = await retryExecutionAction(
        { client: db, admin, requestSource: "automation-ui" },
        {
          shopId: shop.id,
          executionId,
          failedOnly: intent === "retry-failed",
        },
      );
      if (!res.ok) return { error: res.message } satisfies ActionData;
      void trackEvent(session.shop, "automation_retried", {
        executionId,
        failedOnly: intent === "retry-failed",
        childExecutionId: res.childExecutionId ?? null,
      });
      return { notice: res.message } satisfies ActionData;
    }

    return { error: "Unsupported action." } satisfies ActionData;
  } catch (error) {
    return { error: toSafeError(error).message } satisfies ActionData;
  }
};

export default function ExecutionDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const e = data.execution;

  return (
    <s-page heading="Run detail">
      {actionData?.notice ? (
        <s-section>
          <s-banner tone="success" heading="Done">{actionData.notice}</s-banner>
        </s-section>
      ) : null}
      {actionData?.error ? (
        <s-section>
          <s-banner tone="critical" heading="Couldn't complete that">{actionData.error}</s-banner>
        </s-section>
      ) : null}

      <s-section heading="Overview">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline" gap="small">
            <AutomationStatusBadge status={e.status} />
            <s-text type="strong">{e.trigger}</s-text>
          </s-stack>
          <s-paragraph>{e.summary}</s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-text>{e.when}</s-text>
            {e.automationName ? (
              <Link to={`/app/automation/automations/${e.automationId}`}>{e.automationName}</Link>
            ) : null}
          </s-stack>
          <Link to="/app/automation/activity">← Back to Activity Logs</Link>
        </s-stack>
      </s-section>

      {data.lineage.parent || data.lineage.children.length ? (
        <s-section heading="Related runs">
          <s-stack direction="block" gap="small">
            {data.lineage.parent ? (
              <s-stack direction="inline" gap="small">
                <s-text>Retried from</s-text>
                <AutomationStatusBadge status={data.lineage.parent.status} />
                <Link to={`/app/automation/activity/${data.lineage.parent.id}`}>
                  original run
                </Link>
              </s-stack>
            ) : null}
            {data.lineage.children.map((c) => (
              <s-stack direction="inline" gap="small" key={c.id}>
                <s-text>Retry</s-text>
                <AutomationStatusBadge status={c.status} />
                <s-text>{c.when}</s-text>
                <Link to={`/app/automation/activity/${c.id}`}>view →</Link>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      {data.condition ? (
        <s-section heading="Conditions">
          <s-stack direction="block" gap="small">
            {data.condition.rows.length === 0 ? (
              <s-paragraph>No conditions — this ran every time the trigger fired.</s-paragraph>
            ) : (
              <ul className="autStepList">
                {data.condition.rows.map((row, i) => (
                  <li key={i}>
                    <s-stack direction="inline" gap="small">
                      <AutomationStatusBadge status={row.pass ? "SUCCESS" : "SKIPPED"} />
                      <s-text>{row.text}</s-text>
                      <s-text>(was: {row.actual})</s-text>
                    </s-stack>
                  </li>
                ))}
              </ul>
            )}
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading="Steps">
        <div className="autTimeline">
          {data.steps.map((s) => (
            <div className="autTimelineRow" key={s.id} data-awaiting={s.awaiting ? "true" : undefined}>
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small">
                  <AutomationStatusBadge status={s.status} />
                  <s-text type="strong">{s.label}</s-text>
                </s-stack>
                {s.awaiting ? (
                  <s-stack direction="block" gap="small">
                    <s-banner tone="warning" heading="Needs your confirmation">
                      When you confirm, the app will {s.label.toLowerCase()} now. Nothing was
                      done until you approve it.
                    </s-banner>
                    <Form method="post">
                      <input type="hidden" name="intent" value="confirm-step" />
                      <input type="hidden" name="stepId" value={s.id} />
                      <s-button type="submit" variant="primary" disabled={submitting}>
                        Confirm &amp; run
                      </s-button>
                    </Form>
                  </s-stack>
                ) : null}
                {s.errorText ? <s-paragraph>{s.errorText}</s-paragraph> : null}
              </s-stack>
            </div>
          ))}
        </div>
      </s-section>

      <s-section heading="Retry">
        <s-stack direction="block" gap="small">
          {!data.retry.allowed ? (
            <s-banner tone="info" heading="Nothing to retry">{data.retry.reason}</s-banner>
          ) : null}
          <s-stack direction="inline" gap="small">
            <Form method="post">
              <input type="hidden" name="intent" value="retry-all" />
              <s-button type="submit" variant="secondary" disabled={submitting || !data.retry.allowed}>
                Retry whole run
              </s-button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="retry-failed" />
              <s-button type="submit" variant="secondary" disabled={submitting || !data.retry.allowed}>
                Retry failed steps only
              </s-button>
            </Form>
          </s-stack>
          <s-paragraph>
            A retry starts a new run and keeps this one unchanged, so history stays accurate.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

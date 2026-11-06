import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { toSafeError } from "../lib/app-error";
import { trackEvent } from "../analytics.server";
import { getTemplate, type TemplateDefinition } from "../lib/template-catalog";
import { validateTemplateParams, describeTemplate } from "../lib/automation-wizard";
import {
  automationsService,
} from "../automations.server";
import { AutomationValidationError, buildPlanFromTemplate } from "../lib/automations-core";
import { evaluateScopeGap, type ScopeGap } from "../lib/scope-guard";
import { ScopeGapBanner } from "../components/ui/scope-gap-banner";

type ParamView = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  default: string | number | undefined;
  options: string[] | undefined;
  helpText: string | undefined;
};

function serializeTemplate(t: TemplateDefinition) {
  return {
    id: t.id,
    name: t.name,
    oneLine: t.oneLine,
    requiresProtectedData: t.requiresProtectedData,
    preview: describeTemplate(t, Object.fromEntries(t.params.map((p) => [p.key, p.default]))),
    params: t.params.map((p): ParamView => ({
      key: p.key,
      label: p.label,
      type: p.type,
      required: p.required,
      default: p.default,
      options: p.options ? [...p.options] : undefined,
      helpText: p.helpText,
    })),
  };
}

function requireTemplate(templateId: string | undefined): TemplateDefinition {
  const template = templateId ? getTemplate(templateId) : undefined;
  if (!template) throw new Response("Template not found", { status: 404 });
  return template;
}

export const loader = safeLoader(async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const template = requireTemplate(params.templateId);
  // P4-06：预览时把默认参数喂进模板，拿到编译产物的 actionId 集合→ 写 scope 缺口。
  // 失败不阻断预览（模板基线契约测保证默认参数可编译），防御式降级为 ok。
  let scopeGap: ScopeGap = { ok: true, required: [], missing: [] };
  try {
    const plan = buildPlanFromTemplate(template, {});
    scopeGap = evaluateScopeGap(
      session.scope,
      plan.actions.map((a) => a.actionId),
    );
  } catch {
    /* stays ok — never fail the wizard on scope-guard itself */
  }
  return { template: serializeTemplate(template), scopeGap, shopDomain: session.shop };
});

type ActionData = {
  fieldErrors?: Record<string, string>;
  error?: string;
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const template = requireTemplate(params.templateId);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  try {
    if (intent !== "create-from-template") {
      return { error: "Unsupported action." } satisfies ActionData;
    }

    const raw: Record<string, string | undefined> = {};
    for (const p of template.params) {
      const v = formData.get(`param_${p.key}`);
      raw[p.key] = v === null ? undefined : String(v);
    }
    const { ok, values, fieldErrors } = validateTemplateParams(template, raw);
    if (!ok) return { fieldErrors } satisfies ActionData;

    const name = String(formData.get("name") ?? "").trim() || undefined;
    await automationsService.createFromTemplate(shop.id, {
      templateId: template.id,
      params: values,
      name,
    });
    void trackEvent(session.shop, "automation_created_from_template", {
      templateId: template.id,
    });
    throw redirect("/app/automation/automations");
  } catch (error) {
    // redirect()/鉴权跳转都是 Response：原样再抛，绝不折成错误横幅。
    if (error instanceof Response) throw error;
    if (error instanceof AutomationValidationError) {
      return { error: error.errors[0] ?? error.message } satisfies ActionData;
    }
    return { error: toSafeError(error).message } satisfies ActionData;
  }
};

// 成功后跳 My Automations：action 里 throw redirect，浏览器整页导航到新列表。
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

function ParamField({ param, error }: { param: ParamView; error?: string }) {
  const id = `param_${param.key}`;
  const common = {
    id,
    name: id,
    label: param.label,
    required: param.required,
    error,
    details: param.helpText,
  } as const;
  if (param.type === "email")
    return <s-email-field {...common} defaultValue={String(param.default ?? "")} />;
  if (param.type === "number" || param.type === "amount")
    return <s-number-field {...common} defaultValue={String(param.default ?? "")} />;
  if (param.type === "select") {
    return (
      <s-select {...common} value={String(param.default ?? "")}>
        {(param.options ?? []).map((opt) => (
          <s-option key={opt} value={opt} selected={opt === param.default}>
            {opt}
          </s-option>
        ))}
      </s-select>
    );
  }
  return <s-text-field {...common} defaultValue={String(param.default ?? "")} />;
}

export default function TemplateWizard() {
  const { template, scopeGap, shopDomain } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const fieldErrors = actionData?.fieldErrors ?? {};

  return (
    <s-page heading={template.name}>
      <s-section heading="What it will do">
        <s-stack direction="block" gap="small">
          <s-paragraph>{template.oneLine}</s-paragraph>
          <s-box padding="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small">
              <s-text type="strong">{template.preview.headline}</s-text>
              <ol className="autStepList">
                {template.preview.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </s-stack>
          </s-box>
          {template.requiresProtectedData ? (
            <s-banner tone="warning" heading="Needs store data access">
              You can enable this now. It stays paused-until-approved for order
              or customer events until protected data access is granted.
            </s-banner>
          ) : null}
          {scopeGap.ok ? null : (
            <ScopeGapBanner gap={scopeGap} shopDomain={shopDomain} />
          )}
        </s-stack>
      </s-section>

      <s-section heading="Settings">
        <s-stack direction="block" gap="base">
          {actionData?.error ? (
            <s-banner tone="critical" heading="Couldn't enable">
              {actionData.error}
            </s-banner>
          ) : null}
          <Form method="post">
            <input type="hidden" name="intent" value="create-from-template" />
            <s-stack direction="block" gap="base">
              <s-text-field
                id="name"
                name="name"
                label="Automation name"
                defaultValue={template.name}
                details="Give it a name you'll recognize in My Automations."
              />
              {template.params.map((param) => (
                <ParamField key={param.key} param={param} error={fieldErrors[param.key]} />
              ))}
              <s-stack direction="inline" gap="small">
                <s-button type="submit" variant="primary" disabled={submitting}>
                  Enable automation
                </s-button>
                <s-link href="/app/automation/templates">Cancel</s-link>
              </s-stack>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

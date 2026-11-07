import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { safeLoader } from "../lib/route-error";
import {
  ALL_TEMPLATES,
  LAUNCH_TEMPLATES,
  EXTENDED_TEMPLATES,
  type TemplateDefinition,
} from "../lib/template-catalog";

/** loader 只下发可序列化视图：剥掉 definitionTemplate 函数，画廊与卡片够用。 */
type TemplateView = {
  id: string;
  name: string;
  oneLine: string;
  category: string;
  tier: string;
  requiresProtectedData: boolean;
  stepsPreview: string[];
  paramCount: number;
};

function toView(t: TemplateDefinition): TemplateView {
  return {
    id: t.id,
    name: t.name,
    oneLine: t.oneLine,
    category: t.category,
    tier: t.tier,
    requiresProtectedData: t.requiresProtectedData,
    stepsPreview: [...t.stepsPreview],
    paramCount: t.params.length,
  };
}

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    launch: LAUNCH_TEMPLATES.map(toView),
    extended: EXTENDED_TEMPLATES.map(toView),
    total: ALL_TEMPLATES.length,
  };
});

function TemplateCard({ template }: { template: TemplateView }) {
  return (
    <div className="autCard">
      <div className="autCardHead">
        <span className="autCardTitle">{template.name}</span>
        <s-badge tone={template.tier === "LAUNCH" ? "success" : "info"}>
          {template.tier === "LAUNCH" ? "Ready" : "Coming soon"}
        </s-badge>
      </div>
      <p className="autCardSummary">{template.oneLine}</p>
      <s-paragraph>
        <s-text type="strong">{template.category}</s-text>
        {" · "}
        {template.paramCount === 0
          ? "No settings"
          : `${template.paramCount} setting${template.paramCount === 1 ? "" : "s"}`}
      </s-paragraph>
      <ol className="autStepList">
        {template.stepsPreview.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {template.requiresProtectedData ? (
        <s-banner tone="warning" heading="Needs store data access">
          This runs on order or customer events. You can enable it now, but it
          only starts acting once protected data access is approved for your
          store.
        </s-banner>
      ) : null}
      {template.tier === "LAUNCH" ? (
        <s-link href={`/app/automation/templates/${template.id}`}>
          Enable →
        </s-link>
      ) : (
        <s-paragraph>Preview only — not yet available to enable.</s-paragraph>
      )}
    </div>
  );
}

export default function TemplatesGallery() {
  const { launch, extended } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Templates">
      <s-section heading="Start from a template">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Pick a pre-built automation, set a couple of values, and enable it.
            Ready templates can be turned on in about three minutes.
          </s-paragraph>
          {/* R2-C: 强化 V2 IA 面包屑，与 Automation Center 能力发现形成闭环。 */}
          <s-link href="/app/automation">← Back to Automation Center</s-link>
        </s-stack>
      </s-section>

      <s-section heading={`Ready to enable (${launch.length})`}>
        <div className="autCardGrid">
          {launch.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      </s-section>

      <s-section heading={`More, in progress (${extended.length})`}>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            These are registered but marked experimental. They preview what
            comes next and do not block the ready templates above.
          </s-paragraph>
          <div className="autCardGrid">
            {extended.map((template) => (
              <TemplateCard key={template.id} template={template} />
            ))}
          </div>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

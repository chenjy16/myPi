import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { safeLoader } from "../lib/route-error";
import { toSafeError } from "../lib/app-error";
import { trackEvent } from "../analytics.server";
import { formatDateTime } from "../lib/format";
import { integrationsService } from "../integrations.server";
import { EmptyState } from "../components/ui/empty-state";
import { ConfirmFetchForm } from "../components/ui/confirm-fetch-form";

type ActionData = { notice?: string; error?: string };

function statusTone(status: string): "success" | "critical" | "info" {
  if (status === "healthy") return "success";
  if (status === "failing") return "critical";
  return "info";
}

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const integrations = await integrationsService.list(shop.id);
  return {
    timezone: shop.timezone,
    rows: integrations.map((i) => ({
      id: i.id,
      kind: i.kind,
      status: i.status,
      // 只显安全配置摘要；密钥永不回显（core 已剥离，页面仅有 secretConfigured 布尔）。
      detail:
        i.kind === "CUSTOM_WEBHOOK"
          ? String(i.config.url ?? "—")
          : String(i.config.from ?? i.config.testTo ?? "—"),
      secretConfigured: i.secretConfigured,
      lastTestedAt: i.lastTestedAt ? formatDateTime(i.lastTestedAt, shop.timezone) : null,
    })),
  };
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    switch (intent) {
      case "create-email": {
        const from = String(form.get("from") ?? "").trim();
        const testTo = String(form.get("testTo") ?? "").trim();
        if (!testTo) return { error: "A test recipient email is required." } satisfies ActionData;
        await integrationsService.create(shop.id, {
          kind: "EMAIL",
          config: { ...(from ? { from } : {}), testTo },
        });
        void trackEvent(session.shop, "integration_saved", { kind: "EMAIL" });
        return { notice: "Email integration saved. Test it to confirm it works." } satisfies ActionData;
      }
      case "create-webhook": {
        const url = String(form.get("url") ?? "").trim();
        const secret = String(form.get("secret") ?? "").trim();
        if (!url) return { error: "An endpoint URL is required." } satisfies ActionData;
        await integrationsService.create(shop.id, {
          kind: "CUSTOM_WEBHOOK",
          config: { url },
          secret: secret || undefined,
        });
        void trackEvent(session.shop, "integration_saved", { kind: "CUSTOM_WEBHOOK" });
        return { notice: "Webhook integration saved. Its secret is stored encrypted." } satisfies ActionData;
      }
      case "test": {
        const id = String(form.get("id") ?? "");
        const result = await integrationsService.test(shop.id, id);
        void trackEvent(session.shop, "integration_tested", { id, ok: result.ok });
        return result.ok
          ? ({ notice: result.message } satisfies ActionData)
          : ({ error: result.message } satisfies ActionData);
      }
      case "delete": {
        const id = String(form.get("id") ?? "");
        const removed = await integrationsService.remove(shop.id, id);
        void trackEvent(session.shop, "integration_saved", { id, deleted: true });
        return {
          notice: `Integration removed.${removed.referencedBy ? ` It was still referenced by ${removed.referencedBy} automation version(s).` : ""}`,
        } satisfies ActionData;
      }
      default:
        return { error: "Unsupported action." } satisfies ActionData;
    }
  } catch (error) {
    return { error: toSafeError(error).message } satisfies ActionData;
  }
};

export default function Integrations() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const fetcher = useFetcher<ActionData>();
  const busy = navigation.state === "submitting" || fetcher.state !== "idle";
  // 路由导航（Test / 新增）走 actionData；删除走 fetcher，反馈在 fetcher.data。两处合并呈现。
  const notice = actionData?.notice ?? fetcher.data?.notice;
  const error = actionData?.error ?? fetcher.data?.error;

  return (
    <s-page heading="Integrations">
      <s-section heading="Connection status">
        <s-stack direction="block" gap="small">
          {notice ? (
            <s-banner tone="success" heading="Saved">{notice}</s-banner>
          ) : null}
          {error ? (
            <s-banner tone="critical" heading="Couldn't complete that">{error}</s-banner>
          ) : null}
          <s-paragraph>
            Secrets are stored encrypted and never shown again in plain text. Email delivery and
            outbound webhook wiring go live with provider access in a later phase — testing now
            reports what is actually reachable, it will not pretend to be healthy.
          </s-paragraph>
          {/* R2-E: 状态说明诚实边界——不假装未实现的连接。 */}
          <s-paragraph>
            Status reflects the last real test result. “Unknown” means the
            integration was saved but never tested. Click “Test” to perform an
            actual connectivity check; the status only updates to “healthy” when
            the test succeeds.
          </s-paragraph>
          {/* P4-12：隐私披露入口——上架前把 href 替成已发布的 Privacy Policy URL（见 docs/release-runbook.md）。 */}
          <s-paragraph>
            What we collect, why, and how long we keep it is documented in the
            user guide ( Data, privacy & permissions ). A publicly hosted
            privacy policy is required before App Store submission and will be
            linked from this page once published.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading={`Configured (${data.rows.length})`}>
        {data.rows.length === 0 ? (
          <EmptyState
            heading="No integrations yet"
            body="Add an email or webhook connection below. Automations that send email or call a webhook use these."
          />
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Kind</s-table-header>
              <s-table-header listSlot="labeled">Detail</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header listSlot="labeled">Secret</s-table-header>
              <s-table-header listSlot="labeled">Last tested</s-table-header>
              <s-table-header listSlot="labeled">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{row.kind === "EMAIL" ? "Email" : "Webhook"}</s-table-cell>
                  <s-table-cell>
                    <s-text>{row.detail}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(row.status)}>{row.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {row.secretConfigured ? <s-text>Configured</s-text> : <s-text>None</s-text>}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text>{row.lastTestedAt ?? "Never"}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      <Form method="post">
                        <input type="hidden" name="intent" value="test" />
                        <input type="hidden" name="id" value={row.id} />
                        <s-button type="submit" variant="tertiary" disabled={busy}>
                          Test
                        </s-button>
                      </Form>
                      <ConfirmFetchForm
                        fetcher={fetcher}
                        confirm={{
                          heading: "Remove this integration?",
                          body: "Automations that rely on it will fail cleanly until you add one back. Past runs are kept.",
                          confirmLabel: "Remove",
                          danger: true,
                        }}
                      >
                        <input type="hidden" name="intent" value="delete" />
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

      <s-section heading="Add an email integration">
        <Form method="post">
          <input type="hidden" name="intent" value="create-email" />
          <s-stack direction="block" gap="base">
            <s-email-field
              id="from"
              name="from"
              label="From address (optional)"
              details="The sender address for outbound emails."
            />
            <s-email-field
              id="testTo"
              name="testTo"
              label="Default recipient"
              required
              details="Used for connection tests and default sends."
            />
            <s-button type="submit" variant="primary" disabled={busy}>
              Save email integration
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Add a webhook integration">
        <Form method="post">
          <input type="hidden" name="intent" value="create-webhook" />
          <s-stack direction="block" gap="base">
            <s-text-field
              id="url"
              name="url"
              label="Endpoint URL"
              required
              details="Must be an https endpoint. Internal addresses are blocked."
            />
            <s-text-field
              id="secret"
              name="secret"
              label="Signing secret (optional)"
              details="Stored encrypted and never shown again."
            />
            <s-button type="submit" variant="primary" disabled={busy}>
              Save webhook integration
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

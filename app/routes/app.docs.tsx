import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { trackEvent } from "../analytics.server";
import { FEEDBACK_COMMENT_MAX_LENGTH } from "../lib/analytics.ts";
import { safeLoader } from "../lib/route-error";

/**
 * 应用内文档：替代模板时代的假 Help center / Contact support 外链。
 * 内容只写应用真实具备的机制与口径，商家在这里能看懂数字怎么来的、
 * 数据去了哪里，以及功能不可用时该做什么。
 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
});

type ActionState = { sent?: boolean; error?: string };

/** 店铺级反馈：收进 AnalyticsEvent 的 feedback_submitted（scope: "app"）。 */
export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionState> => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const raw = formData.get("comment");
  const comment = typeof raw === "string" ? raw.trim() : "";

  if (!comment) {
    return { error: "Write a short note before sending feedback." };
  }
  if (comment.length > FEEDBACK_COMMENT_MAX_LENGTH) {
    return {
      error: `Feedback must be ${FEEDBACK_COMMENT_MAX_LENGTH} characters or shorter.`,
    };
  }

  trackEvent(session.shop, "feedback_submitted", { scope: "app", comment });
  return { sent: true };
};

export default function DocsPage() {
  const fetcher = useFetcher<typeof action>();

  const pending = fetcher.state !== "idle";
  const sent = Boolean(fetcher.data?.sent);
  const error = fetcher.data?.error;

  return (
    <s-page heading="Guide & docs">
      <s-section heading="How reorder advice is calculated">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            mypi reads your sales history (a rolling observation window, 30 days
            by default), current inventory levels and location data through
            read-only Shopify Admin API scopes. For each variant with recent
            sales it computes an average daily sales rate, then two numbers:
          </s-paragraph>
          <s-paragraph>
            <strong>Reorder point</strong> = daily sales × (lead time + safety
            stock days). When available stock falls below it, the variant
            appears in the action board.
          </s-paragraph>
          <s-paragraph>
            <strong>Target stock</strong> = daily sales × (lead time + review
            period + safety stock days). The suggested quantity closes the gap
            between target stock and what is available now, then rounds up to
            your supplier&apos;s minimum order quantity and case pack when both
            are set. A per-supplier lead time overrides the store-level lead
            time when present.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="From advice to purchase">
        <s-paragraph>
          Every suggestion needs your explicit decision: Accept keeps the
          suggested quantity, Edit lets you set your own, Ignore dismisses it.
          Accepted and edited advice collects in the Purchase Plans pool, where
          lines merge per supplier into a plan. Plans are snapshots —
          quantities, supplier names and unit costs are stored at creation time,
          so a plan stays readable even after a supplier is deleted. A plan is
          marked ordered when the purchase actually happened; ordered and
          cancelled plans are final, so create a new plan for anything that
          changed. Export any plan as CSV to send to your supplier.
        </s-paragraph>
      </s-section>

      <s-section heading="When advice pauses">
        <s-paragraph>
          Recommendations depend on a local inventory snapshot refreshed by
          manual, scheduled and webhook syncs. If a blocking data check fails —
          for example the snapshot is too old or the location is missing —
          decisions pause and the affected recommendations move to Paused. The
          Data Health page lists every check, whether it blocks decisions or
          only lowers confidence, and how to resume.
        </s-paragraph>
      </s-section>

      <s-section heading="Your data and permissions">
        <s-paragraph>
          mypi requests read-only access to products, inventory, orders and
          locations. It stores what it needs to make decisions: inventory
          snapshots, sales counts, your settings, supplier records, accepted
          decisions, purchase plans and per-shop usage events that power the
          activation and advice-quality metrics we review during this beta.
          Feedback notes are stored with your shop domain so the team can follow
          up. Nothing is written back to your store. Uninstalling the app deletes
          every record tied to your shop on our side.
        </s-paragraph>
      </s-section>

      <s-section heading="Settings that move the numbers">
        <s-paragraph>
          Lead time, safety stock days and review period live in Settings and
          apply store-wide as defaults; supplier-level lead times and
          per-variant order terms take precedence. A smaller review period trims
          suggested quantities; more safety stock raises them. Changes apply to
          advice computed after you save — history keeps the values in effect at
          decision time.
        </s-paragraph>
      </s-section>

      <s-section heading="Send feedback">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Wrong advice, missing feature, or something confusing? Tell us here —
            feedback goes to the beta team with your shop domain. For a specific
            recommendation, the advice feedback control on each Replenishment
            line is faster and more useful.
          </s-paragraph>
          {error && (
            <s-banner tone="critical" heading="Feedback not sent">
              {error}
            </s-banner>
          )}
          {sent ? (
            <s-banner tone="success" heading="Thanks — feedback received">
              The beta team follows up using your shop domain.
            </s-banner>
          ) : (
            <fetcher.Form method="post">
              <s-stack direction="block" gap="base">
                <s-text-area
                  name="comment"
                  label="Your feedback"
                  rows={4}
                  maxLength={FEEDBACK_COMMENT_MAX_LENGTH}
                  placeholder="What worked, what didn't…"
                  details={`Up to ${FEEDBACK_COMMENT_MAX_LENGTH} characters. Stored with your shop domain so we can follow up.`}
                  disabled={pending}
                />
                <s-button type="submit" variant="primary" disabled={pending}>
                  {pending ? "Sending…" : "Send feedback"}
                </s-button>
              </s-stack>
            </fetcher.Form>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

/** Shopify 要求页面声明 boundary 头，嵌入式 iframe 会话才能正确引导。 */
export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

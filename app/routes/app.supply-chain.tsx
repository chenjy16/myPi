import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { safeLoader } from "../lib/route-error";
import { ReadinessBadge } from "../components/ui/status-badge";

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
});

/**
 * Supply Chain 占位页：本模块尚未实现，所以这里只有「未启用」的诚实说明，
 * 不编造分段时效或停产日历的数据（spec §9：未实现的功能一律标 not enabled）。
 * 形态仍走全站 s-page / s-section 骨架 —— 占位页不是设计体系的例外。
 */
export default function SupplyChainPage() {
  return (
    <s-page heading="Supply Chain">
      <s-section heading="Segmented lead times">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small">
            <s-text type="strong">Module status</s-text>
            <ReadinessBadge kind="notEnabled" />
          </s-stack>
          <s-paragraph>
            Splitting a supplier lead time into production, freight, customs and
            receiving, plus supplier shutdown calendars, is not built yet. No
            segmented figures are shown here because nothing has been measured
            or stored for this store.
          </s-paragraph>
          <s-paragraph>
            Until then, one lead time per supplier drives advice: a supplier’s
            own lead time overrides the store-wide default for every SKU bound
            to it. Set the supplier-level value on the Suppliers page, or the
            store-wide default on Settings.
          </s-paragraph>
          {/* 页内导航不混进段落里（§3c-7：段落内「裸文本 + 行内 s-* 元素」会被
              Polaris 默认 slot 吞掉前置文本），单独一行给足间距。 */}
          <s-stack direction="inline" gap="base">
            <s-link href="/app/suppliers">Suppliers</s-link>
            <s-link href="/app/settings">Settings</s-link>
            <s-link href="/app">Back to workspace</s-link>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

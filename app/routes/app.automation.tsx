import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { AUTOMATION_ENABLED } from "../features";
import { safeLoader } from "../lib/route-error";
import { FeatureDisabledPage } from "../components/feature-disabled";

/**
 * V2.0 Final：Automation 路由组透明包装，不再渲染重复的横向导航。
 * 保留 loader 以提供 FeatureDisabledPage 的权限校验。
 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await resolveShopFromSession(session.shop);
  return {
    shopDomain: session.shop,
    shopId: shop.id,
    timezone: shop.timezone,
    enabled: AUTOMATION_ENABLED,
  };
});

export default function AutomationLayout() {
  if (!AUTOMATION_ENABLED) {
    return (
      <FeatureDisabledPage
        heading="Automation"
        featureName="Automation"
      />
    );
  }

  return <Outlet />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

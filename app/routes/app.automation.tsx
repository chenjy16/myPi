import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLocation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { AUTOMATION_ENABLED } from "../features";
import { safeLoader } from "../lib/route-error";
import { FeatureDisabledPage } from "../components/feature-disabled";

/**
 * 自动化区二级导航（与侧栏五项同集，区内互切）。Center 用 exact 匹配避免吞子路由，
 * 其余按前缀高亮。href 与 app.tsx 的 AUTOMATION_NAV 保持一一对应。
 */
const TABS = [
  { to: "/app/automation", label: "Center", end: true },
  { to: "/app/automation/templates", label: "Templates" },
  { to: "/app/automation/automations", label: "My Automations" },
  { to: "/app/automation/activity", label: "Activity Logs" },
  { to: "/app/automation/integrations", label: "Integrations" },
];

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // 租户锚点：把域名升级为 Shop.id，供子页复用（useRouteLoaderData("routes/app/automation")）。
  const shop = await resolveShopFromSession(session.shop);
  return {
    shopDomain: session.shop,
    shopId: shop.id,
    timezone: shop.timezone,
    enabled: AUTOMATION_ENABLED,
  };
});

export default function AutomationLayout() {
  const location = useLocation();

  if (!AUTOMATION_ENABLED) {
    return (
      <FeatureDisabledPage
        heading="Automation"
        featureName="Automation"
      />
    );
  }

  const isActive = (to: string, end?: boolean) =>
    end
      ? location.pathname === to
      : location.pathname === to || location.pathname.startsWith(`${to}/`);

  return (
    <s-stack direction="block" gap="base">
      <nav className="autTabs" aria-label="Automation sections">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            className="autTab"
            to={tab.to}
            aria-current={isActive(tab.to, tab.end) ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

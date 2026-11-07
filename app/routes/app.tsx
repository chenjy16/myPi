import type { CSSProperties } from "react";
import { Fragment } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Link,
  Outlet,
  useLocation,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { ensureInstallTracked } from "../analytics.server";
import { AUTOMATION_ENABLED } from "../features";
import { readSafeErrorPayload, toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import "../styles/tokens.css";
import "../styles/app-shell.css";
import "../styles/dashboard.css";
import "../styles/automation.css";

type NavItem = {
  to: string;
  label: string;
  glyph: string;
  /** 精确匹配高亮（父级路由用，避免吞子路由）。 */
  end?: boolean;
  /** 分组标题；相邻同段项只显示一次小标题。 */
  section?: string;
};

// V2.0 Final Alignment：Sidebar 仅保留 7 项核心导航 + Guide & Docs。
// PRD 决策 2：V1 库存功能完全隐藏，不保留 Inventory Tools 菜单。
// PRD 决策 4：全局只保留一套 Sidebar，删除重复的顶部 Automation 导航。
const AUTOMATION_NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", glyph: "⌂", end: true, section: "MAIN" },
  { to: "/app/automation", label: "Automation Center", glyph: "✦", end: true, section: "MAIN" },
  { to: "/app/automation/automations", label: "My Automations", glyph: "⚡", section: "MAIN" },
  { to: "/app/automation/templates", label: "Templates", glyph: "▦", section: "MAIN" },
  { to: "/app/automation/activity", label: "Activity Logs", glyph: "≡", section: "MAIN" },
  { to: "/app/automation/integrations", label: "Integrations", glyph: "⇄", section: "CONFIGURATION" },
  { to: "/app/settings", label: "Settings", glyph: "⚙", section: "CONFIGURATION" },
];

// flag 关闭时的兜底导航：保留 V1 完整信息架构，Home 直连 /app/overview 避免 loader redirect。
const V1_NAV: NavItem[] = [
  { to: "/app/overview", label: "Home", glyph: "⌂", end: true },
  { to: "/app/inventory", label: "Replenishment", glyph: "↗" },
  { to: "/app/purchase-plans", label: "Purchase Plans", glyph: "▤" },
  { to: "/app/suppliers", label: "Suppliers", glyph: "☐" },
  { to: "/app/supply-chain", label: "Supply Chain", glyph: "⛓" },
  { to: "/app/data-health", label: "Data Health", glyph: "✓" },
  { to: "/app/metrics", label: "Beta Metrics", glyph: "◔" },
  { to: "/app/settings", label: "Settings", glyph: "⚙" },
];

const DOCS_NAV: NavItem[] = [
  { to: "/app/docs", label: "Guide & Docs", glyph: "?", section: "HELP" },
];

const NAV_ITEMS: NavItem[] = [
  ...(AUTOMATION_ENABLED ? AUTOMATION_NAV : V1_NAV),
  ...DOCS_NAV,
];

/** 嵌入式应用布局的鉴权：未登录会跳 OAuth；成功则把 apiKey 和店铺域名交给壳组件。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // 每店补记一次 app_installed（埋点上线前装的老店也在这里被追认）。
  // fire-and-forget：采集失败不拦任何人进后台。
  void ensureInstallTracked(session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
});

/** /app 壳：App Bridge、侧栏导航、顶栏店铺名；子页面渲染在 Outlet。 */
export default function App() {
  const { apiKey, shop } = useLoaderData<typeof loader>();
  const location = useLocation();

  return (
    <AppProvider apiKey={apiKey}>
      <div className="appShell">
        <aside className="appSidebar">
          <Link className="appBrand" to="/app">
            <img className="appBrandLogo" src="/pi-logo.png" alt="mypi" />
            <span>mypi</span>
          </Link>
          <nav className="appNavigation" aria-label="App navigation">
            {NAV_ITEMS.map((item, index) => {
              const isActive = item.end
                ? location.pathname === item.to
                : location.pathname === item.to ||
                  location.pathname.startsWith(`${item.to}/`);
              const prev = NAV_ITEMS[index - 1];
              const showSection = Boolean(item.section) && item.section !== prev?.section;
              return (
                <Fragment key={item.to}>
                  {showSection ? (
                    <p className="appNavSectionLabel" aria-hidden="true">
                      {item.section}
                    </p>
                  ) : null}
                  <Link
                    className={`appNavLink${isActive ? " isActive" : ""}`}
                    to={item.to}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="appNavGlyph" aria-hidden="true">
                      {item.glyph}
                    </span>
                    {item.label}
                  </Link>
                </Fragment>
              );
            })}
          </nav>
        </aside>
        <div className="appMain">
          <header className="appTopbar">
            <span className="shopContext">
              <span className="shopContextMark" aria-hidden="true">
                S
              </span>
              {shop}
            </span>
          </header>
          <main className="appOutlet">
            <Outlet />
          </main>
        </div>
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
/**
 * 子页面崩溃时不再渲染成无声白屏：
 * - Shopify 框架抛出的特殊 Response（鉴权跳转、限流等，即 ErrorResponse）交给 boundary.error 处理；
 * - 其它运行时错误在这里兜底，把可读信息直接显示在页面上。
 */
export function ErrorBoundary() {
  const error = useRouteError();

  // 1) 我们折进 Response 的安全错误（loader 经 safeLoader 收口）：
  //    data 在所有 serverMode 下都被原样带到客户端，服务端与客户端渲染同一份，
  //    既不掩盖真实 cause，也不产生 hydration 文本不匹配。
  const safePayload = readSafeErrorPayload(error);
  if (safePayload) {
    return renderErrorCard(
      `${safePayload.message} (Reference: ${safePayload.kind})`,
    );
  }

  // 2) Shopify/React Router 抛出的 ErrorResponse（含嵌入式 app-bridge 引导响应）不是
  //    Error 实例，必须按 constructor.name 识别并交回 boundary.error，否则会破坏会话重建。
  const ctorName = (
    error as { constructor?: { name?: string } } | null | undefined
  )?.constructor?.name;
  if (ctorName === "ErrorResponse" || ctorName === "ErrorResponseImpl") {
    return boundary.error(error as Error);
  }

  // 3) 兜底：直接抛出、未经收口的 Error。此时只有服务端渲染信息完整，客户端会退化，
  //    仍按分类给出可读文案。
  // eslint-disable-next-line no-console
  console.error("[app ErrorBoundary] uncaught render error:", error);
  return renderErrorCard(describeRouteError(error));
}

/** 统一的错误卡片外观：把任意来源的文案收敛到同一呈现。 */
function renderErrorCard(message: string) {
  return (
    <div style={ERROR_BOUNDARY_STYLE}>
      <strong>Something went wrong</strong>
      <p style={ERROR_BOUNDARY_TEXT_STYLE}>{message}</p>
      <p style={ERROR_BOUNDARY_HINT_STYLE}>
        Reload the page, or return to the home screen. If it keeps happening,
        copy this message to support.
      </p>
    </div>
  );
}

/**
 * 把任意抛出的值折成商家可读的一段话。
 * 堆栈与上游原文一律不下发：应用上架后这是公开页面，把 stack 画进 DOM 等于把
 * 服务器路径、查询语句和依赖版本发给浏览器。商家拿到分类文案 + 参考码即可求助。
 */
function describeRouteError(error: unknown): string {
  const safe = toSafeError(error);
  return `${safe.message} (Reference: ${safe.kind})`;
}

/* 颜色全部走 tokens.css（Sprint 6 drain：此处曾是裸 hex，值以 var 引用，渲染不变）。 */
const ERROR_BOUNDARY_STYLE: CSSProperties = {
  margin: "40px auto",
  maxWidth: 560,
  padding: "22px 24px",
  border: "1px solid var(--app-eb-card-border)",
  borderLeft: "4px solid var(--app-purple)",
  borderRadius: 14,
  background: "var(--app-surface)",
  boxShadow: "0 4px 14px var(--app-eb-shadow)",
  color: "var(--app-eb-card-ink)",
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontSize: 14,
  lineHeight: 1.6,
};

const ERROR_BOUNDARY_TEXT_STYLE: CSSProperties = {
  margin: "10px 0 0",
  color: "var(--app-eb-text-ink)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const ERROR_BOUNDARY_HINT_STYLE: CSSProperties = {
  margin: "12px 0 0",
  color: "var(--app-eb-hint-ink)",
  fontSize: 12,
};

/** 合并 Shopify boundary 要求的响应头。 */
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

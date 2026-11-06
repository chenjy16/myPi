import type { HeadersFunction } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Templates 分组布局：flatRoutes 把 `templates._index`（画廊）与 `templates.$templateId`（向导）
 * 作为本子路由，父级只负责透传 Outlet，二者按 URL 互斥渲染。鉴权/降级由上层 app.automation.tsx 兜底。
 */
export default function TemplatesLayout() {
  return <Outlet />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

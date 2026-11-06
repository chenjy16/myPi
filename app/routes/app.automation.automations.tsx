import type { HeadersFunction } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * My Automations 分组布局：flatRoutes 把 `automations._index`（列表 + 启停/删除意图）与
 * `automations.$id`（详情/编辑向导）作为子路由，父级只透传 Outlet，按 URL 互斥渲染。
 */
export default function AutomationsLayout() {
  return <Outlet />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

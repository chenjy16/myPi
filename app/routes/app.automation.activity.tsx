import type { HeadersFunction } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

/**
 * Activity Logs 分组布局：flatRoutes 把 `activity._index`（过滤 + 时间线）与
 * `activity.$executionId`（逐步骤详情 + 确认/重试入口）作为子路由，父级只透传 Outlet。
 */
export default function ActivityLayout() {
  return <Outlet />;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

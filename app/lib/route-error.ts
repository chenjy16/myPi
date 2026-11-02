import type { LoaderFunctionArgs } from "react-router";

import { toSafeErrorResponse } from "./app-error";

/**
 * 收口读取类 loader 的崩溃路径。
 *
 * 目的：把裸抛的基础设施错误（Prisma 连不上、Shopify API 超时等）折成可跨
 * SSR→hydration 的安全错误响应（见 app-error.ts 的 toSafeErrorResponse），
 * 让 ErrorBoundary 在服务端与客户端渲染到同一份数据——既不让客户端把服务端
 * 已经算对的 cause（如 database）覆盖成 unknown，也消除 hydration 文本不匹配。
 *
 * 放行规则（原样再抛，绝不折叠）：
 * - `Response`：包括 authenticate 的 OAuth/授权跳转、`redirect`、`json`、以及
 *   已经折好的安全错误响应。嵌入式会话重建依赖这些 Response 的头部，一旦被
 *   换成 500 页面就会破坏登录串联，所以必须最先放行。
 *
 * 本模块同构（仅用 Response 与类型），因此不加 .server 后缀，可安全被同时
 * 在客户端渲染的 app.tsx 引用。
 */
export function safeLoader<T>(
  handler: (args: LoaderFunctionArgs) => Promise<T>,
): (args: LoaderFunctionArgs) => Promise<T> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof Response) throw error;
      throw toSafeErrorResponse(error);
    }
  };
}

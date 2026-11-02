import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/** 进程级 Shopify 应用实例：OAuth、Admin 鉴权、Webhook 校验、Prisma session。 */
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  // 后台 worker、定时任务和 webhook 增量同步都依赖 offline session（库内部按
  // getOfflineId(shop) 只从存储里 load，不会自建）；useOnlineTokens 下模板仅写入 online
  // session，因此这里改为 offline。per-user 权限差异不再适用，数据可见范围以应用 scope 为准。
  useOnlineTokens: false,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
/** 当前 Admin GraphQL API 版本，须与 shopify.app.toml 中 webhook api_version 一致。 */
export const apiVersion = ApiVersion.October26;
/** 给 HTML 响应加上嵌入 Admin 所需的安全头（entry.server 里调用）。 */
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
/** 校验 Admin 请求或 Webhook 签名，并取出 session / admin GraphQL 客户端。 */
export const authenticate = shopify.authenticate;
/** 在没有用户 session 时访问 API 的入口（本应用几乎不用）。 */
export const unauthenticated = shopify.unauthenticated;
/** 发起或处理 Shopify 登录（落地页 /auth/login）。 */
export const login = shopify.login;
/** 向 Shopify 注册 webhook 订阅。 */
export const registerWebhooks = shopify.registerWebhooks;
/** Prisma 实现的 session 存储，供官方库读写 OAuth token。 */
export const sessionStorage = shopify.sessionStorage;

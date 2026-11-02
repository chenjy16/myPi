import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  AppError,
  SHOPIFY_API_UNAVAILABLE_MESSAGE,
  describeError,
} from "./app-error";

/**
 * Admin GraphQL 的唯一出口。做三件事，而 `admin.graphql` 本身都不做：
 *   1. 带上官方客户端的限流重试（不传 `tries` 时库默认 retries=0，429/503 直接抛给调用方）；
 *   2. 把 HTTP 失败、GraphQL errors、`extensions.cost` 节流统一折成带类别的 AppError；
 *   3. 让所有调用点共用一套错误语义，不再各写一份解析。
 */

/** 官方客户端把 `tries` 折成 retries = tries - 1，并校验 retries ∈ [0,3]，所以 tries 上限是 4。 */
const MAX_SUPPORTED_TRIES = 4;

/** 每次调用的重试上限；一次突发限流通常 1-2 次退避就能过。 */
function resolveTries(): number {
  const configured = Number(process.env.SHOPIFY_GRAPHQL_TRIES ?? 3);
  if (!Number.isFinite(configured)) return 3;
  return Math.min(MAX_SUPPORTED_TRIES, Math.max(1, Math.floor(configured)));
}

type GraphQLErrorEntry = {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string };
};

type ShopifyResponse<T> = {
  data?: T;
  errors?: GraphQLErrorEntry[];
  extensions?: {
    cost?: {
      throttled?: boolean;
      throttleStatus?: number;
      nextWaitEstimate?: number;
      requestedQueryCost?: number;
      actualQueryCost?: number;
      queryCostLimit?: number;
    };
  };
};

export type AdminGraphqlOptions = {
  variables?: Record<string, unknown>;
  /**
   * 没有商品成本读权限的店铺要能继续同步库存，因此这类错误按「成本读不到」降级处理，
   * 而不是让整个同步失败。其余错误照旧抛出。
   */
  allowUnitCostAccessError?: boolean;
};

/** 成本读取被拒的判定，与旧的过滤口径保持一致。 */
function isUnitCostAccessError(error: GraphQLErrorEntry): boolean {
  return (
    error.path?.includes("unitCost") === true ||
    /unit cost|product costs/i.test(error.message)
  );
}

/** 节流类错误：Shopify 用 THROTTLED / cost extensions 表达「稍后再试」。 */
function isThrottlingError(error: GraphQLErrorEntry): boolean {
  return (
    error.extensions?.code === "THROTTLED" ||
    /throttl|rate limit|too many|complexity|bucket/i.test(error.message)
  );
}

/** 权限/授权类错误：商家能做的只有重新授权，与「API 暂时不可用」必须分开呈现。 */
function isAccessError(error: GraphQLErrorEntry): boolean {
  return /permission|unauthorized|not authorized|doesn.t have|scope|disabled/i.test(
    error.message,
  );
}

/**
 * 执行一次 Admin GraphQL 查询并返回 data。
 * 抛出的一律是 AppError：validation 保留可行动的 API 原文，shopify_api / auth 走通用文案。
 */
export async function adminGraphql<T>(
  admin: AdminApiContext,
  operation: string,
  options: AdminGraphqlOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await admin.graphql(operation, {
      variables: options.variables,
      tries: resolveTries(),
    });
  } catch (error) {
    const detail = describeError(error);
    // 重试耗尽后库会抛「Attempted maximum number of N network retries」，属于暂时不可用。
    if (/retries/i.test(detail)) {
      throw new AppError(
        "shopify_api",
        SHOPIFY_API_UNAVAILABLE_MESSAGE,
        detail,
      );
    }
    if (/session|expires|revoked|invalid_grant|401|403/i.test(detail)) {
      throw new AppError(
        "auth",
        "This store's authorization is no longer valid for Shopify. Re-authorize the app to continue.",
        detail,
      );
    }
    throw new AppError("shopify_api", SHOPIFY_API_UNAVAILABLE_MESSAGE, detail);
  }

  let payload: ShopifyResponse<T>;
  try {
    payload = (await response.json()) as ShopifyResponse<T>;
  } catch (error) {
    throw new AppError(
      "shopify_api",
      SHOPIFY_API_UNAVAILABLE_MESSAGE,
      `non-JSON response (HTTP ${response.status}): ${describeError(error)}`,
    );
  }

  const cost = payload.extensions?.cost;
  if (cost && (cost.throttled || (cost.nextWaitEstimate ?? 0) > 0)) {
    // 只记账不拦截：官方客户端已经做过退避，这里留一条可观测线索。
    console.warn(
      "[adminGraphql] Shopify reported throttling",
      JSON.stringify({
        throttled: cost.throttled ?? null,
        throttleStatus: cost.throttleStatus ?? null,
        nextWaitEstimate: cost.nextWaitEstimate ?? null,
      }),
    );
  }

  const errors = payload.errors ?? [];
  const blockingErrors = options.allowUnitCostAccessError
    ? errors.filter((error) => !isUnitCostAccessError(error))
    : errors;

  if (!response.ok || blockingErrors.length || !payload.data) {
    const first = blockingErrors[0];
    const detail =
      blockingErrors
        .map(({ message }) => message)
        .join("; ")
        .slice(0, 500) || `HTTP ${response.status}`;

    if (first && isThrottlingError(first)) {
      throw new AppError(
        "shopify_api",
        SHOPIFY_API_UNAVAILABLE_MESSAGE,
        detail,
      );
    }
    if (first && isAccessError(first)) {
      throw new AppError(
        "auth",
        "mypi no longer has the Shopify permission it needs for this operation. Re-authorize the app to continue.",
        detail,
      );
    }
    if (first) {
      // GraphQL 自身的报错（字段不存在、变量不合法、userErrors）对开发者是可行动的，保留原文。
      throw new AppError("validation", first.message, detail);
    }
    throw new AppError(
      "shopify_api",
      SHOPIFY_API_UNAVAILABLE_MESSAGE,
      `Shopify Admin API returned HTTP ${response.status} without data`,
    );
  }

  return payload.data;
}

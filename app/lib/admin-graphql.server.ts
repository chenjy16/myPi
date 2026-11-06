import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  AppError,
  SHOPIFY_API_UNAVAILABLE_MESSAGE,
  describeError,
} from "./app-error.ts";
import { createLogger } from "./logger.ts";
import {
  classifyThrownDetail,
  isAccessError,
  isThrottlingError,
  isUnitCostAccessError,
  resolveTries,
  throttleWaitMs,
  type CostExtension,
  type GraphQLErrorEntry,
} from "./shopify-throttle.ts";

/**
 * Admin GraphQL 的唯一出口。做三件事，而 `admin.graphql` 本身都不做：
 *   1. 带上官方客户端的限流重试（不传 `tries` 时库默认 retries=0，429/503 直接抛给调用方）；
 *   2. 把 HTTP 失败、GraphQL errors、`extensions.cost` 节流统一折成带类别的 AppError；
 *   3. 让所有调用点共用一套错误语义，不再各写一份解析。
 * 限流识别、退避时长、错误分类的算术全部下沉到 shopify-throttle.ts 的纯函数，便于单测覆盖。
 */

type ShopifyResponse<T> = {
  data?: T;
  errors?: GraphQLErrorEntry[];
  extensions?: { cost?: CostExtension };
};

export type AdminGraphqlOptions = {
  variables?: Record<string, unknown>;
  /**
   * 没有商品成本读权限的店铺要能继续同步库存，因此这类错误按「成本读不到」降级处理，
   * 而不是让整个同步失败。其余错误照旧抛出。
   */
  allowUnitCostAccessError?: boolean;
};

/** 测试可注入的等待实现；生产用真实 setTimeout，被 throttleWaitMs 封顶到最多 5s。 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 执行一次 Admin GraphQL 查询并返回 data。
 * 抛出的一律是 AppError：validation 保留可行动的 API 原文，shopify_api / auth 走通用文案。
 */
export async function adminGraphql<T>(
  admin: AdminApiContext,
  operation: string,
  options: AdminGraphqlOptions = {},
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let response: Response;
  try {
    response = await admin.graphql(operation, {
      variables: options.variables,
      tries: resolveTries(),
    });
  } catch (error) {
    const detail = describeError(error);
    const kind = classifyThrownDetail(detail);
    if (kind === "retry_exhausted") {
      // 重试耗尽后库会抛「Attempted maximum number of N network retries」，属于暂时不可用。
      throw new AppError(
        "shopify_api",
        SHOPIFY_API_UNAVAILABLE_MESSAGE,
        detail,
      );
    }
    if (kind === "auth") {
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
  const waitMs = throttleWaitMs(cost);
  if (cost && (cost.throttled || (cost.nextWaitEstimate ?? 0) > 0)) {
    // 留一条可观测线索；官方客户端已在本次调用内做过退避。
    createLogger().warn("adminGraphql: Shopify reported throttling", {
      throttled: cost.throttled ?? null,
      throttleStatus: cost.throttleStatus ?? null,
      nextWaitEstimate: cost.nextWaitEstimate ?? null,
    });
  }
  // 确实被节流时，按 Shopify 的动态估算主动等待（封顶 5s）再返回，
  // 让分页循环里的下一次请求自然让路，避免连续请求把配额一次性打空。
  if (waitMs > 0) {
    await wait(waitMs);
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

// —— P2-07 写通道：与读共用错误语义，但独立函数、绝不动上方读路径（风险隔离）。——

export type AdminGraphqlWriteOptions = {
  variables?: Record<string, unknown>;
  /** 来源标识（automation:<id> / manual / sync）：尽力而为地写进 GraphQL query 注释，
   * 供 P2-14 防循环排查回溯；**不假设 Shopify 会回传**（OQ-7）。 */
  requestSource?: string;
};

export type UserError = { field?: string[]; message: string };

function isUserError(value: unknown): value is UserError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * 从 Mutation data 里抽取 userErrors：递归找任意路径下的 userErrors 数组
（不同 Mutation 的返回形状不同：data.productUpdate.userErrors / data.userErrors 等）。
 * 只认带 message 的对象条目，其他形状一律忽略（不误报）。
 */
export function collectUserErrors(data: unknown): UserError[] {
  const found: UserError[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isUserError(item)) found.push(item);
        else walk(item, depth + 1);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    let handledUserErrors = false;
    if (Array.isArray(record.userErrors)) {
      handledUserErrors = true;
      for (const item of record.userErrors) if (isUserError(item)) found.push(item);
    }
    // 已收过 userErrors 的节点不再下钻该分支：防同一条目被重复收集
    for (const value of Object.values(record)) {
      if (handledUserErrors && value === record.userErrors) continue;
      walk(value, depth + 1);
    }
  };
  walk(data, 0);
  return found;
}

/**
 * Mutation 的统一出口：透传给 adminGraphql（tries/退避/错误分类全部复用），
 * 拿回 data 后把 userErrors 折成 validation 型 AppError——绝不吞掉：写操作的
 * 业务失败（如 tag 超长、对象不存在）必须带可行动原文进 ExecutionStep。
 */
export async function adminGraphqlWrite<T>(
  admin: AdminApiContext,
  mutation: string,
  options: AdminGraphqlWriteOptions = {},
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  const banner = options.requestSource
    ? `# mypi-request-source: ${options.requestSource.replace(/[^\w.:-]/g, "_")}\n`
    : "";
  const data = await adminGraphql<T>(
    admin,
    `${banner}${mutation}`,
    { variables: options.variables },
    wait,
  );
  const userErrors = collectUserErrors(data);
  if (userErrors.length) {
    const detail = userErrors
      .map((e) => (e.field?.length ? `[${e.field.join(",")}] ${e.message}` : e.message))
      .join("; ")
      .slice(0, 500);
    throw new AppError("validation", userErrors[0].message, detail);
  }
  return data;
}


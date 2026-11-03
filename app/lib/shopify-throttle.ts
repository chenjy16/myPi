/**
 * Shopify Admin GraphQL 限流与错误分类的「纯策略层」。
 * 单独成文件是为了能在不联网、不连库的情况下被测试 —— 实际发请求留在 admin-graphql.server.ts。
 * 计划红线：不凭函数名假设限流处理已到位，这里把「什么时候该退避、退避多久、错误算哪一类」
 * 收敛成可断言的纯函数，配合 mock 的 admin.graphql 覆盖 429 / THROTTLED / 超时 / 重试耗尽。
 */

/** 官方客户端把 `tries` 折成 retries = tries - 1，并校验 retries ∈ [0,3]，所以 tries 上限是 4。 */
const MAX_SUPPORTED_TRIES = 4;
const DEFAULT_TRIES = 3;

/**
 * 主动退避的硬上限（毫秒）。
 * nextWaitEstimate 是 Shopify 估算的「再等这么久配额能回正」，理论上可能很大；
 * worker 与交互式同步都不能被单个响应挂死，所以这里封顶，超出部分交给官方客户端的下一轮 tries 退避。
 */
export const MAX_THROTTLE_WAIT_MS = 5000;

/** GraphQL 响应里 extensions.cost 的节流字段（形状按 Shopify 文档，全部可选以便兼容不同 API 版本）。 */
export type CostExtension = {
  throttled?: boolean | null;
  requestedQueryCost?: number | null;
  actualQueryCost?: number | null;
  queryCostLimit?: number | null;
  throttleStatus?: number | null;
  nextWaitEstimate?: number | null;
};

/** 单条 GraphQL 错误的最小形状。 */
export type GraphQLErrorEntry = {
  message: string;
  path?: Array<string | number>;
  extensions?: { code?: string };
};

/**
 * 每次调用的重试上限。env 缺失/非法回落到默认，并夹在 [1, MAX_SUPPORTED_TRIES]，
 * 避免出现 tries=0（库会直接抛）或超过库支持的范围。
 */
export function resolveTries(
  raw: string | undefined = process.env.SHOPIFY_GRAPHQL_TRIES,
): number {
  const configured = Number(raw ?? DEFAULT_TRIES);
  if (!Number.isFinite(configured)) return DEFAULT_TRIES;
  return Math.min(MAX_SUPPORTED_TRIES, Math.max(1, Math.floor(configured)));
}

/**
 * 节流响应后应该主动等待多久（毫秒），用于给分页循环里的下一次请求让路。
 * 只对「确实被节流（throttled=true）」的响应生效——成功响应里的 nextWaitEstimate
 * 是「假如被限流会等多久」的预测值，不能当成必须等待，否则每个正常请求都会被无谓拖慢。
 * 优先用 Shopify 给的动态估算，而不是固定 sleep；非法或缺失返回 0，上限封顶防挂死。
 */
export function throttleWaitMs(
  cost: CostExtension | undefined | null,
  capMs: number = MAX_THROTTLE_WAIT_MS,
): number {
  if (!cost || cost.throttled !== true) return 0;
  const estimate = Number(cost.nextWaitEstimate);
  if (!Number.isFinite(estimate) || estimate <= 0) return 0;
  return Math.min(Math.floor(estimate), Math.max(0, Math.floor(capMs)));
}

/** 节流类错误：Shopify 用 THROTTLED / cost extensions / 明确的 rate limit 文案表达「稍后再试」。 */
export function isThrottlingError(error: GraphQLErrorEntry): boolean {
  return (
    error.extensions?.code === "THROTTLED" ||
    /throttl|rate limit|too many|complexity|bucket|429/i.test(error.message)
  );
}

/** 权限/授权类错误：商家能做的只有重新授权，与「API 暂时不可用」必须分开呈现。 */
export function isAccessError(error: GraphQLErrorEntry): boolean {
  return /permission|unauthorized|not authorized|doesn.t have|scope|disabled/i.test(
    error.message,
  );
}

/** 成本读取被拒的判定：无 read product costs 权限的店要能继续同步，按「成本读不到」降级。 */
export function isUnitCostAccessError(error: GraphQLErrorEntry): boolean {
  return (
    error.path?.includes("unitCost") === true ||
    /unit cost|product costs/i.test(error.message)
  );
}

/**
 * 从抛出错误的文本判定类别，供 adminGraphql 的 catch 分支复用（也便于单测）。
 * 官方客户端重试耗尽会抛「Attempted maximum number of N network retries」→ 暂时不可用。
 * 会话/token 失效、401/403 → auth。其余网络/超时 → shopify_api。
 */
export function classifyThrownDetail(
  detail: string,
): "retry_exhausted" | "auth" | "api" {
  if (/retries/i.test(detail)) return "retry_exhausted";
  if (/session|expires|revoked|invalid_grant|401|403/i.test(detail)) {
    return "auth";
  }
  return "api";
}

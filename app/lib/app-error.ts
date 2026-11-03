/**
 * 统一错误分类。目的有两个：
 *   1. 让商家看到「能行动的文案」，而不是 Prisma / Shopify 的原始报错或堆栈；
 *   2. 让「系统不可用」与「业务校验失败」在 UI 上是两类东西，不混成一句 failed。
 *
 * 本文件必须保持无外部依赖（浏览器与服务端 bundle 都会引入），所以不 import Prisma / Shopify 类型，
 * 全部按结构探测。
 */

export type AppErrorKind =
  "validation" | "auth" | "database" | "shopify_api" | "unknown";

/**
 * 服务层可预期的业务错误。message 直接面向商家（英文），kind 决定前端呈现方式；
 * detail 只进服务端日志，绝不下发。
 */
export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly detail: string;

  constructor(kind: AppErrorKind, message: string, detail = "") {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** 授权类问题只能靠重新安装/重新授权解决，文案必须把动作说清楚。 */
export const AUTH_REQUIRED_MESSAGE =
  "This store is no longer authorized for mypi. Reinstall or re-authorize the app to continue.";

/** 数据库不可用：明确告知没有写入，商家可以放心重试，避免误以为数据丢失。 */
export const DATABASE_UNAVAILABLE_MESSAGE =
  "mypi can't reach its database right now. Nothing was changed and no data was lost. Please try again in a minute.";

/** Shopify API 不可用 / 限流耗尽。 */
export const SHOPIFY_API_UNAVAILABLE_MESSAGE =
  "Shopify didn't return the store data in time. This is usually temporary — please retry in a few minutes.";

export const UNKNOWN_ERROR_MESSAGE =
  "mypi hit an unexpected error. The request was not completed. If it keeps happening, share the details with support.";

/**
 * Prisma 里代表「连不上/池耗尽/事务超时」的错误码。
 * 这些一律按数据库不可用处理，而不是业务错误：商家能做的只有重试。
 * P2002（唯一约束）等数据完整性码故意不在此列，它们属于服务端缺陷或并发，不该伪装成可重试。
 */
const PRISMA_DATABASE_ERROR_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1009",
  "P1014",
  "P1017",
  "P1039",
  "P2024",
  "P2028",
  "P2034",
]);

/** 从抛出值上取 name；不是字符串就当没有。 */
function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/** 从任意抛出的值里取 Prisma 错误码；不是 Prisma 错误就返回 null。 */
function prismaErrorCode(error: unknown): string | null {
  const name = errorName(error);
  if (!name || !name.startsWith("PrismaClient")) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** HTTP 状态里可归为「上游服务暂时不可用」的那一档（429 / 5xx）。 */
function retriableHttpStatus(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  if (typeof status !== "number") return false;
  return status === 429 || status >= 500;
}

/** 判定抛出值属于哪一类错误。服务层显式抛的 AppError 优先。 */
export function classifyAppError(error: unknown): AppErrorKind {
  if (error instanceof AppError) return error.kind;

  // ProductCopyError 的 message 全部来自固定的文案表（不含供应商响应原文），
  // 可以直接给商家看，因此按校验类透出而不是折成通用文案。
  if (errorName(error) === "ProductCopyError") return "validation";

  const code = prismaErrorCode(error);
  if (code && PRISMA_DATABASE_ERROR_CODES.has(code)) return "database";

  if (retriableHttpStatus(error)) return "shopify_api";

  const name = errorName(error);
  if (name && /SessionNotFound|InvalidOAuth|Http401|Unauthorized/i.test(name)) {
    return "auth";
  }

  return "unknown";
}

export type SafeError = {
  kind: AppErrorKind;
  /** 可以直接呈现给商家的英文文案。 */
  message: string;
  /** 只写日志的诊断文本，不含密钥。 */
  detail: string;
};

/** 把任意抛出的值折成「可安全下发 + 可诊断」的两段结构。 */
export function toSafeError(error: unknown): SafeError {
  const kind = classifyAppError(error);
  const detail = describeError(error);

  // AppError 的 message 由服务层撰写，本来就是给商家看的话，直接透出，
  // 不要再被通用文案覆盖掉（否则「重新授权」和「这家店已卸载」会糊成一句）。
  if (error instanceof AppError)
    return { kind, message: error.message, detail };

  if (kind === "validation") {
    return { kind, message: (error as Error).message, detail };
  }

  const messageByKind: Record<Exclude<AppErrorKind, "validation">, string> = {
    auth: AUTH_REQUIRED_MESSAGE,
    database: DATABASE_UNAVAILABLE_MESSAGE,
    shopify_api: SHOPIFY_API_UNAVAILABLE_MESSAGE,
    unknown: UNKNOWN_ERROR_MESSAGE,
  };
  return { kind, message: messageByKind[kind], detail };
}

/** 把抛出值压成一行日志文本，避免多行堆栈把台账 error 字段撑爆。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = prismaErrorCode(error);
    return [error.name, code, error.message]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 500);
  }
  if (typeof error === "string") return error.slice(0, 500);
  if (error === undefined) return "thrown value was undefined";
  if (error === null) return "thrown value was null";
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return `unserializable ${typeof error}`;
  }
}

/**
 * 跨 SSR→hydration 边界唯一可靠的载荷标记。
 *
 * 背景：React Router 序列化「抛出的 Error」时只保留 { message, stack }，生产环境
 * 更会把它统一替换成 "Unexpected Server Error"（见 sanitizeError），原型、name、
 * Prisma code、AppError 的 instanceof 全部丢失。于是客户端 ErrorBoundary 只能重新
 * 分类 → 退化成 unknown，覆盖掉服务端本已算对的 cause，还顺带触发 hydration 文本不匹配。
 * 而「抛出的 Response」其 JSON body 会被当作 ErrorResponse.data 原样带到客户端，
 * 所有 serverMode 都成立。所以我们把折好的安全错误塞进 Response，让两端渲染同一份数据。
 */
export const APP_SAFE_ERROR_FLAG = "__appSafeError";

export type SafeErrorPayload = {
  kind: AppErrorKind;
  message: string;
  status: number;
};

/** 把一个服务端错误折成「可安全下发、可跨 hydration」的 5xx Response。 */
export function toSafeErrorResponse(error: unknown): Response {
  const safe = toSafeError(error);
  // database / shopify_api 是可重试的暂时不可用，用 503；其余按服务端缺陷 500。
  const status =
    safe.kind === "database" || safe.kind === "shopify_api" ? 503 : 500;
  const payload: { [APP_SAFE_ERROR_FLAG]: SafeErrorPayload } = {
    [APP_SAFE_ERROR_FLAG]: { kind: safe.kind, message: safe.message, status },
  };
  return Response.json(payload, { status });
}

/** 从 useRouteError 的值里取出我们折进去的安全错误；不是就返回 null。 */
export function readSafeErrorPayload(error: unknown): SafeErrorPayload | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const flagged = (data as Record<string, unknown>)[APP_SAFE_ERROR_FLAG];
  if (typeof flagged !== "object" || flagged === null) return null;
  const { kind, message, status } = flagged as Partial<SafeErrorPayload>;
  if (typeof message !== "string") return null;
  const safeKind: AppErrorKind =
    kind === "validation" ||
    kind === "auth" ||
    kind === "database" ||
    kind === "shopify_api" ||
    kind === "unknown"
      ? kind
      : "unknown";
  return {
    kind: safeKind,
    message,
    status: typeof status === "number" ? status : 500,
  };
}

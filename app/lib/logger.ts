/**
 * 零依赖结构化日志（P1-5）。
 *
 * 刻意不引 pino/Sentry——「不无必要引入新基础设施」是红线。这里只做一件真正值钱的事：
 * 把散落的 `console.*` 折成**一行一个 JSON**，带稳定的 `ts/level/msg` 与调用方绑定的上下文
 * （最主要的是 `shop` 这条租户轴，其次可选 `requestId`）。日志平台按 JSON 行天然可解析、可按 shop 过滤。
 *
 * 安全边界（P4-11）：logger 自带键名黑名单兜底脱敏——命中 secret/token/密码/认证头/API key/
 * 客户联系方式等敏感键名的值一律折成 `[redacted]`，深浅嵌套都拦。但这只是最后一道网：
 * **调用方仍应决定不传什么**，不要把真实密钥当日志字段使。Error 一律只取其 message 落地，
 * 避免堆栈里夹带的对象图被整个 stringify。
 */

export type LogLevel = "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

/** 命中即折敏的键名子串（对小写化后的键做包含判定）；`secretsEncrypted` 由 secret 子串覆盖。 */
export const SECRET_KEY_PATTERNS: readonly string[] = [
  "secret",
  "token",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "passwd",
  "client_credentials",
  "credentials",
  "email",
  "phone",
];

export const REDACTED_PLACEHOLDER = "[redacted]";

/** 键名是否命中黑名单：小写化 + 子串包含（accessToken / SHOPIFY_API_KEY / secretsEncrypted 都能拦）。 */
export function isSensitiveKey(
  key: string,
  patterns: readonly string[] = SECRET_KEY_PATTERNS,
): boolean {
  const normalized = key.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

/**
 * 深度折敏：命中敏感键的值（含整个子树）折成占位串；返回新对象，不改入参。
 * 纯函数单独导出，供单测与其它需要落日志/落审计的场景复用。
 */
export function redactContext<T>(
  value: T,
  patterns: readonly string[] = SECRET_KEY_PATTERNS,
): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) =>
          isSensitiveKey(k, patterns)
            ? [k, REDACTED_PLACEHOLDER]
            : [k, walk(v)],
        ),
      );
    }
    return node;
  };
  return walk(value) as T;
}

/** 单条日志的输入；`time` 便于测试注入，运行期默认取当前时刻。 */
export type LogInput = {
  level: LogLevel;
  message: string;
  context?: LogContext;
  time?: Date;
};

/** 把 Error 折成可读且可序列化的形态；其余值原样交给 JSON.stringify。 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

/**
 * 纯格式化：产出一行 JSON 字符串，键序稳定（ts → level → msg → 其余上下文按插入序）。
 * 单独成函数、不碰 console，是为了能在 node:test 里断言输出形状。
 */
export function formatLogEntry(input: LogInput): string {
  const { level, message, context = {}, time = new Date() } = input;
  const entry: LogContext = { ts: time.toISOString(), level, msg: message };
  for (const [key, value] of Object.entries(context)) {
    if (key === "ts" || key === "level" || key === "msg") continue; // 保留字不可被上下文覆盖
    if (isSensitiveKey(key)) {
      entry[key] = REDACTED_PLACEHOLDER; // 顶层敏感键整值折掉，不再往里 walk
      continue;
    }
    // 非敏感键：先 Error → 可序列化形状，再对子树里的敏感键折敏。
    entry[key] = redactContext(normalizeValue(value));
  }
  return JSON.stringify(entry);
}

export type Logger = {
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  /** 派生一个带附加默认上下文（如某个请求）的子 logger。 */
  child: (extra: LogContext) => Logger;
};

/**
 * 造一个绑定了基础上下文（通常是 `{ shop }`）的 logger。
 * info 走 stdout，warn/error 走 stderr，方便编排层按流分级采集。
 */
export function createLogger(base: LogContext = {}): Logger {
  const emit = (level: LogLevel, message: string, context?: LogContext) => {
    const line = formatLogEntry({
      level,
      message,
      context: { ...base, ...context },
    });
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

/** 关联 ID：优先复用上游传入的 x-request-id，否则自造一个，贯穿一次请求/任务。 */
export function newRequestId(incoming?: string | null): string {
  const trimmed = incoming?.trim();
  if (trimmed) return trimmed;
  return crypto.randomUUID();
}

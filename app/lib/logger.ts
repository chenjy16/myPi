/**
 * 零依赖结构化日志（P1-5）。
 *
 * 刻意不引 pino/Sentry——「不无必要引入新基础设施」是红线。这里只做一件真正值钱的事：
 * 把散落的 `console.*` 折成**一行一个 JSON**，带稳定的 `ts/level/msg` 与调用方绑定的上下文
 * （最主要的是 `shop` 这条租户轴，其次可选 `requestId`）。日志平台按 JSON 行天然可解析、可按 shop 过滤。
 *
 * 安全边界：logger 只负责序列化，不判断敏感与否——**调用方决定传什么**。绝不要把 token / 密钥塞进 context。
 * Error 一律只取其 message 落地，避免堆栈里夹带的对象图被整个 stringify。
 */

export type LogLevel = "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

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
    entry[key] = normalizeValue(value);
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

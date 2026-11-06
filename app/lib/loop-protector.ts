// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：循环保护裁决（PRD §24 / P2-13）。不自取时钟、不碰 DB——
// 时间窗命中数、级联深度、去重状态都由调用方（P2-13b app/automation-loop.server.ts）算好传入，
// 本模块只输出确定性裁决 allow | throttle | block，保证「相同输入 ⇒ 相同结论」可回放。
//
// 可靠性分级（PRD §24 的诚实口径）：
// - 可靠：事件指纹去重、自动化级限次、级联深度上限（判定只依赖传入计数，引擎闭环后必收敛）；
// - 降风险：来源过滤（auto: 前缀 tag）只能降低自触发概率，**不假设 Shopify 回传 requestSource**（OQ-7）；
// - 不保证：跨店铺/人工快速操作引发的回环不在本机制承诺范围内。

export const DEFAULT_MAX_CASCADE_DEPTH = 3;
export const DEFAULT_DEDUP_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_COUNT = 5;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 300_000;

/**
 * 运维可调的防循环参数（P4-16）：从 env 读取，非法/缺省回退到安全默认，绝不产生 NaN 或越界。
 * 纯函数（env 注入）便于脱库单测；调用方（automation-loop.server makeLoopGuard）喂 process.env。
 * 上界护栏：深度≤10、去重窗≤1h、限次窗≤1h、限次数≤100——防误配把引擎锁死或放开成无界。
 */
export type LoopConfig = {
  maxCascadeDepth: number;
  dedupWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitCount: number;
};

function positiveIntEnv(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function parseLoopConfig(env: Record<string, string | undefined> = process.env): LoopConfig {
  return {
    maxCascadeDepth: positiveIntEnv(env.LOOP_MAX_CASCADE_DEPTH, DEFAULT_MAX_CASCADE_DEPTH, 10),
    dedupWindowMs: positiveIntEnv(env.LOOP_DEDUP_WINDOW_MS, DEFAULT_DEDUP_WINDOW_MS, 3_600_000),
    rateLimitWindowMs: positiveIntEnv(
      env.LOOP_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      3_600_000,
    ),
    rateLimitCount: positiveIntEnv(env.LOOP_RATE_LIMIT_COUNT, DEFAULT_RATE_LIMIT_COUNT, 100),
  };
}

/** 裁决结果：block=永久跳过本次（记 loop-blocked）；throttle=窗内限流跳过（可自愈）。 */
export type LoopDecision = "allow" | "throttle" | "block";

export type LoopVerdict =
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "throttle"; reason: string };

export type LoopCheckInput = {
  automationId: string;
  entityType: string;
  entityId: string;
  /** 参与指纹的关键字段快照（条件白名单字段即可，别把整个 data 塞进来）。 */
  keyFields: Record<string, unknown>;
  /** 由 ExecutionLog 链传播来的级联深度；根事件为 0。 */
  cascadeDepth: number;
  /** 同指纹在上一次执行后、去重窗内出现的次数（db 计数传入）。 */
  duplicateCountInWindow: number;
  /** 同 entityId 在限次窗内已执行次数（db 计数传入）。 */
  executionsInWindow: number;
  /** 本自动化若执行，将新写入的 tag（用于 auto: 来源标记的回路识别）。 */
  plannedTag?: string;
  /** 事件已携带的 tag 集合（Order/Customer tags 归一后的数组）。 */
  eventTags?: readonly string[];
  maxCascadeDepth?: number;
  dedupWindowMs?: number;
  rateLimitCount?: number;
  rateLimitWindowMs?: number;
  now?: Date;
};

export type FingerprintInput = Pick<
  LoopCheckInput,
  "automationId" | "entityType" | "entityId" | "keyFields"
> & { now?: Date; dedupWindowMs?: number };

/**
 * 事件指纹：automationId+entityType+entityId+关键字段hash，窗格按 dedupWindowMs 对齐
 * （now 落入哪个窗格就编进指纹——跨窗格自动视为新事件，窗内重复自动同指纹）。
 * 纯字符串 hash（FNV-1a 变体）：不依赖 crypto，DB/日志可安全落库，跨进程确定性一致。
 */
export function eventFingerprint(input: FingerprintInput): string {
  const windowMs = input.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const nowMs = (input.now ?? new Date()).getTime();
  const bucket = Math.floor(nowMs / windowMs);
  const payload = [
    input.automationId,
    input.entityType,
    input.entityId,
    stableStringify(input.keyFields),
  ].join("|");
  return `${bucket.toString(36)}:${hashString(payload)}`;
}

/** 对象稳定序列化：键排序后拼接，防 {a,b} 与 {b,a} 判成两个指纹。 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${k}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(",")}}`;
}

/** FNV-1a 32bit；输出定长 base36，够用且无依赖（指纹只防碰撞概率，不做安全用途）。 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** auto: 前缀是本应用打标（P2-07）的来源标记；带它的事件说明回路已经形成。 */
export const AUTO_TAG_PREFIX = "auto:";

export function hasAutoSourceTag(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.toLowerCase().startsWith(AUTO_TAG_PREFIX));
}

/**
 * 唯一裁决入口，判定顺序即优先级：
 * 1) 级联深度超限 → block（回流链必须掐断，人工介入前不再执行）；
 * 2) 同指纹窗内重复 → block（重复投递/自触发同事件，跳过且记原因）；
 * 3) 计划打的 tag 已挂在事件上 → block（幂等+回路双保险：效果已存在，重跑只会加深链路）；
 * 4) auto: 来源标记命中 → throttle（降风险层：疑似自触发，窗内先压）；
 * 5) 同实体窗内执行次数超限 → throttle（限流窗过后自然恢复）。
 */
export function checkLoopProtection(input: LoopCheckInput): LoopVerdict {
  const maxDepth = input.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH;
  const limitCount = input.rateLimitCount ?? DEFAULT_RATE_LIMIT_COUNT;

  if (input.cascadeDepth > maxDepth)
    return {
      decision: "block",
      reason: `cascade depth ${input.cascadeDepth} exceeds max ${maxDepth} (automation ${input.automationId})`,
    };

  if (input.duplicateCountInWindow > 0)
    return {
      decision: "block",
      reason: `duplicate event fingerprint already handled within dedup window (automation ${input.automationId}, entity ${input.entityId})`,
    };

  if (
    input.plannedTag &&
    hasAutoSourceTag(input.eventTags) &&
    (input.eventTags ?? []).some(
      (t) => t.toLowerCase() === input.plannedTag!.toLowerCase(),
    )
  )
    return {
      decision: "block",
      reason: `planned tag “${input.plannedTag}” already present on event; skip to avoid feedback loop`,
    };

  if (hasAutoSourceTag(input.eventTags))
    return {
      decision: "throttle",
      reason: `event carries ${AUTO_TAG_PREFIX} source tag; rate-limiting suspected self-trigger (automation ${input.automationId})`,
    };

  if (input.executionsInWindow >= limitCount)
    return {
      decision: "throttle",
      reason: `automation ${input.automationId} hit rate limit: ${input.executionsInWindow} runs within ${input.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS}ms for entity ${input.entityId}`,
    };

  return { decision: "allow" };
}

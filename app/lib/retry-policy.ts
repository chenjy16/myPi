// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：确定性重试规则（PRD §25 / P2-15）。错误分类沿用 AppError kind：
// shopify_api（限流/瞬时）可重试；validation/auth 是「重试也不会变好」的确定性失败，直接终态；
// 超限进死信（FAILED 待人工补偿），绝不无限重投把 Shopify 侧打成噪声。
// 退避算术对齐 V1 shopify-throttle 的 5s 封顶语义（V-12），叠加按尝试序号的指数增长；
// 抖动由调用方注入随机函数——本模块不自取随机源，保证单测确定性与可回放。
import type { AppErrorKind } from "./app-error.ts";

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 可重试的错误类别；unknown 保守起见也不重试——分类不明的失败重试可能重复副作用。 */
export const RETRYABLE_KINDS: readonly AppErrorKind[] = ["shopify_api"];

export function isRetryableKind(kind: AppErrorKind): boolean {
  return RETRYABLE_KINDS.includes(kind);
}

export function maxAttempts(): number {
  const configured = Number(process.env.EXECUTION_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_ATTEMPTS;
  return Math.min(configured, 10);
}

/** 退避封顶（毫秒），与 shopify-throttle 同口径，默认 5s。 */
export function backoffCapMs(): number {
  const configured = Number(process.env.EXECUTION_BACKOFF_CAP_MS ?? 5_000);
  if (!Number.isFinite(configured) || configured <= 0) return 5_000;
  return Math.min(configured, 30_000);
}

/**
 * 第 attempt 次失败后的等待（attempt 从 1 起）：base 500ms 指数翻倍、封顶 cap，
 * 抖动系数由调用方给（0..1 之间的确定性输入 ⇒ 确定性输出，便于回放与测试）。
 */
export function backoffDelayMs(
  attempt: number,
  jitter: number = 0,
): number {
  const base = 500;
  const raw = base * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(raw, backoffCapMs());
  const boundedJitter = Math.min(Math.max(jitter, 0), 1);
  return Math.min(Math.round(capped * (1 + boundedJitter)), backoffCapMs());
}

export type RetryDecision =
  | { action: "retry"; attempt: number; delayMs: number }
  | { action: "dead_letter"; reason: "not_retryable" | "attempts_exhausted" };

/**
 * 唯一的重试裁决入口：执行编排（P2-16）只消费这里的结论，不得自行计数。
 * attemptsDone = 已执行完的尝试次数（含首次）。
 */
export function decideRetry(
  kind: AppErrorKind,
  attemptsDone: number,
  jitter: number = 0,
): RetryDecision {
  if (!isRetryableKind(kind))
    return { action: "dead_letter", reason: "not_retryable" };
  if (attemptsDone >= maxAttempts())
    return { action: "dead_letter", reason: "attempts_exhausted" };
  return {
    action: "retry",
    attempt: attemptsDone + 1,
    delayMs: backoffDelayMs(attemptsDone, jitter),
  };
}

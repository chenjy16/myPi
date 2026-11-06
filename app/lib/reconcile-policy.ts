// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 execution-queue.ts 同一约定）。
// 漏投对账纯核（P4-13）：Shopify 偶发丢投会让「实体已变更、但自动化从未触发」 silently 漏掉。
// 对账 = 用 Admin API 拉时间窗内真实变更，比对已落账的执行/投递，把「确有变更却无人处理」的补回队列。
//
// 幂等三层，绝不因为对账把一次变更跑两遍：
//  1) 合成投递键 reconcile:<topic>:<entityId>:<changedAt> 落 WebhookDelivery —— 同一变更跨多轮对账只补一次；
//  2) 复用 enqueueStandardEvent 的 activeKey 锁 —— 同指纹不双入队；
//  3) ExecutionLog 已按该实体在变更时刻之后落过执行 → 视为已处理，根本不进补投集合。
// 本模块只做「该不该补」的纯判定，Admin 拉取/落库都在 reconcile.server.ts 绑定面。
import type { StandardEvent } from "./event-normalizer.ts";

export const RECONCILE_KEY_PREFIX = "reconcile:";

export type ReconcileConfig = {
  /** 生产默认关（PRD P6 Safe by Default）：显式 RECONCILE_ENABLED=true 才跑。 */
  enabled: boolean;
  /** 对账节奏（分钟）：worker cron 用它推默认回看窗。 */
  intervalMinutes: number;
  /** 每轮回看的时间窗（分钟）：应 ≥ interval，留重叠才不会漏；重叠部分靠合成键去重。 */
  lookbackMinutes: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** env → 配置。缺省：关、每 30 分钟一轮、回看 60 分钟（两轮重叠防边界漏投）。 */
export function parseReconcileConfig(env: NodeJS.ProcessEnv = process.env): ReconcileConfig {
  const intervalMinutes = positiveInt(env.RECONCILE_INTERVAL_MINUTES, 30);
  // 回看窗默认给 interval 的两倍，覆盖一次调度抖动；显式配置则尊重配置值。
  const lookbackMinutes = positiveInt(env.RECONCILE_LOOKBACK_MINUTES, intervalMinutes * 2);
  return {
    enabled: env.RECONCILE_ENABLED === "true",
    intervalMinutes,
    lookbackMinutes: Math.max(lookbackMinutes, intervalMinutes),
  };
}

/** 本轮对账时间窗 [since, until]：until 用注入时钟，since = until − lookback。不自取时钟。 */
export function reconcileWindow(
  now: Date,
  lookbackMinutes: number,
): { since: Date; until: Date } {
  return {
    since: new Date(now.getTime() - lookbackMinutes * 60_000),
    until: now,
  };
}

/** 一次待判定的实体变更：已归一的标准化事件 + 该变更在 Shopify 侧的更新时间。 */
export type ReconcileDelta = {
  event: StandardEvent;
  /** 实体 updatedAt（Admin API 拉回）；参与合成键，精确到变更而非「今天碰过」。 */
  changedAt: Date;
};

/** 确定性合成投递键：同一 (topic, entityId, changedAt) 恒定，跨轮对账据此去重。 */
export function reconcileDedupeKey(delta: ReconcileDelta): string | null {
  const { entityId, topic } = delta.event;
  if (!entityId) return null; // 无实体无法定位变更，也不该被补
  return `${RECONCILE_KEY_PREFIX}${topic}:${entityId}:${delta.changedAt.toISOString()}`;
}

/** 是否对账合成的投递键（扫描 WebhookDelivery 时据此挑出「往轮已补过」的键）。 */
export function isReconcileWebhookId(webhookId: string): boolean {
  return webhookId.startsWith(RECONCILE_KEY_PREFIX);
}

export type PlanRequeueInput = {
  deltas: readonly ReconcileDelta[];
  /** 往轮对账已登记的合成键集合（来自 WebhookDelivery，经 isReconcileWebhookId 过滤）。 */
  priorReconcileKeys: ReadonlySet<string>;
  /** 已落执行的实体 → 最晚执行时间（来自 ExecutionLog：entityRef → max(createdAt)）。 */
  handledByEntity: ReadonlyMap<string, Date>;
};

/**
 * 该补哪些变更：跳过「往轮已补过」与「已有执行覆盖到该变更时刻」两类，其余进补投集合。
 * 判定顺序刻意先看合成键（幂等硬保证），再看执行覆盖（省掉无谓补投）。
 */
export function planRequeue(input: PlanRequeueInput): ReconcileDelta[] {
  const missing: ReconcileDelta[] = [];
  for (const delta of input.deltas) {
    const key = reconcileDedupeKey(delta);
    if (key === null) continue;
    if (input.priorReconcileKeys.has(key)) continue;
    const entityId = delta.event.entityId;
    if (entityId) {
      const handledAt = input.handledByEntity.get(entityId);
      // 执行发生在变更同刻或之后 → 这次变更已被自动化处理，无需补。
      if (handledAt && handledAt.getTime() >= delta.changedAt.getTime()) continue;
    }
    missing.push(delta);
  }
  return missing;
}

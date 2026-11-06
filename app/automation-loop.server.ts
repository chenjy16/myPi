// 防循环的计数面（P2-13b）+ 级联深度传播（P2-14）。客户端注入（同 matcher：本模块不 import db，由调用方喂真库）。
// 纯裁决逻辑（优先级/指纹/hash）唯一在 lib/loop-protector；这里只负责把「窗内重复数 / 窗内执行数」
// 从 ExecutionLog 数出来，再喂给纯 checkLoopProtection。可注入假客户端脱库测试。
import type { PrismaClient } from "@prisma/client";
import {
  checkLoopProtection,
  eventFingerprint,
  parseLoopConfig,
  type LoopCheckInput,
  type LoopVerdict,
} from "./lib/loop-protector.ts";

export type LoopCountClient = Pick<PrismaClient, "executionLog">;

export type LoopGuardConfig = {
  shopId: string;
  dedupWindowMs?: number;
  rateLimitWindowMs?: number;
};

/**
 * 造一个带 db 计数的守卫：先数同事件指纹的去重窗内重复数、同实体限次窗内执行数，
 * 再交给纯裁决函数按优先级（深度>重复>计划tag>auto前缀>限次）定 allow/throttle/block。
 */
export function makeLoopGuard(
  client: LoopCountClient,
  config: LoopGuardConfig,
): (input: LoopCheckInput) => Promise<LoopVerdict> {
  const loopConfig = parseLoopConfig();
  const dedupWindowMs = config.dedupWindowMs ?? loopConfig.dedupWindowMs;
  const rateLimitWindowMs = config.rateLimitWindowMs ?? loopConfig.rateLimitWindowMs;
  return async (input: LoopCheckInput): Promise<LoopVerdict> => {
    const now = input.now ?? new Date();
    const fingerprint = eventFingerprint({
      automationId: input.automationId,
      entityType: input.entityType,
      entityId: input.entityId,
      keyFields: input.keyFields,
      now,
      dedupWindowMs,
    });
    const windowStart = new Date(now.getTime() - rateLimitWindowMs);
    const [duplicateCountInWindow, executionsInWindow] = await Promise.all([
      // 同指纹（同去重窗格）已落过账即视为重复——指纹本身按窗格编码，跨窗自动视为新事件。
      // shopId 同步入 where（P4-03）：指纹含 automationId 本已隐含租户，这里把边界做成显式。
      client.executionLog.count({
        where: { dedupeKey: fingerprint, shopId: config.shopId },
      }),
      // 限次：同店同自动化同实体在限次窗内的历史执行次数（本次尚未落账，故只数既往）。
      client.executionLog.count({
        where: {
          shopId: config.shopId,
          automationId: input.automationId,
          entityRef: input.entityId,
          createdAt: { gte: windowStart },
        },
      }),
    ]);
    return checkLoopProtection({
      ...input,
      maxCascadeDepth: input.maxCascadeDepth ?? loopConfig.maxCascadeDepth,
      rateLimitCount: input.rateLimitCount ?? loopConfig.rateLimitCount,
      dedupWindowMs,
      rateLimitWindowMs,
      duplicateCountInWindow,
      executionsInWindow,
    });
  };
}

/**
 * 级联深度传播（P2-14）：认领事件时若能关联到「刚刚改动了同一实体」的父执行，
 * 则子深度 = 父深度 + 1；关联不到（根事件 / 超窗）视为 0。用 entityId + 时间窗做启发式关联，
 * 不假设 Shopify 回传来源（OQ-7）；SKIPPED 执行不构成链路，排除在外。
 */
export async function resolveCascadeDepth(
  client: LoopCountClient,
  query: {
    shopId: string;
    entityId: string | null;
    now?: Date;
    windowMs?: number;
  },
): Promise<number> {
  if (!query.entityId) return 0;
  const now = query.now ?? new Date();
  const since = new Date(
    now.getTime() - (query.windowMs ?? parseLoopConfig().rateLimitWindowMs),
  );
  const parent = await client.executionLog.findFirst({
    where: {
      shopId: query.shopId,
      entityRef: query.entityId,
      createdAt: { gte: since },
      status: { not: "SKIPPED" },
    },
    orderBy: { createdAt: "desc" },
    select: { cascadeDepth: true },
  });
  return parent ? parent.cascadeDepth + 1 : 0;
}

// Ingestion→Engine 全链路消费glue（P2-12）：worker 认领一条事件后走这里，替换 Phase 1 的 no-op stub。
// 链路：topic→trigger 反查 → 域名解析为 Shop 租户 id（Automation/ExecutionLog 都挂在 Shop.id 上）
// → 匹配当前生效版本（P2-02）→ 逐条 executeAutomation（P2-11）。多条命中各自独立执行、独立落账。
// 仍受 worker 侧 AUTOMATION_EXECUTION_ENABLED 门控制（未开时不调用本函数，保持 Safe by Default）。
import db from "../db.server";
import { resolveShopFromSession } from "../shop-directory.server";
import { matchAutomations } from "../automation-matcher.server";
import { triggerForTopic } from "../lib/trigger-registry.ts";
import { makeLoopGuard, resolveCascadeDepth } from "../automation-loop.server";
import { trackEvent } from "../analytics.server";
import { executionEventForOutcome } from "../lib/execution-metrics.ts";
import {
  runAutomation,
  type AutomationRunOutcome,
  type EngineDeps,
} from "../lib/automation-engine.ts";
import type { StandardEvent } from "../lib/event-normalizer.ts";

/**
 * 处理一条已认领事件：命中并驱动所有匹配的自动化。
 * 返回每条自动化的落库结果（未匹配到关心该 topic 的自动化时为空数组）。
 */
export async function processClaimedEvent(
  event: StandardEvent,
  binding: Omit<EngineDeps, "client">,
): Promise<AutomationRunOutcome[]> {
  const trigger = triggerForTopic(event.topic);
  if (!trigger) return []; // 该 topic 不在自动化触发白名单，直接放行不产生任何副作用

  const shop = await resolveShopFromSession(event.shopDomain);
  const matches = await matchAutomations(db, shop.id, trigger.type);

  // 防循环（P2-13b）：默认注入带 db 计数的守卫（调用方可覆盖）；级联深度（P2-14）：
  // 能关联到刚改过同实体的父执行则 +1，否则视为根事件 0。
  const loopGuard = binding.loopGuard ?? makeLoopGuard(db, { shopId: shop.id });
  const cascadeDepth = await resolveCascadeDepth(db, {
    shopId: shop.id,
    entityId: event.entityId,
  });

  const outcomes: AutomationRunOutcome[] = [];
  for (const match of matches) {
    outcomes.push(
      await runAutomation(
        { ...binding, client: db, loopGuard },
        { shopId: shop.id, event, match, cascadeDepth },
      ),
    );
  }

  // 执行维度埋点（P4-20）：fire-and-forget，shop 域名维度、无 PII；采集失败绝不影响执行闭环。
  for (const outcome of outcomes) {
    const metric = executionEventForOutcome(outcome);
    if (metric) trackEvent(event.shopDomain, metric.type, metric.props);
  }

  return outcomes;
}

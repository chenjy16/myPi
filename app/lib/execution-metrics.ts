// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：把引擎执行结果映射为 shop 维度、无 PII 的运行态势事件（P4-20）。
// 采集点在 automation-engine/consume.server.ts（引擎收尾）、automation-ingest.server.ts（投递去重）、
// reconcile.server.ts（对账补投）；本模块只做「结果→事件」的确定性映射，不碰 DB、不写埋点。
import type { AutomationRunOutcome } from "./automation-engine.ts";
import type { AnalyticsEventType } from "./analytics.ts";

export type ExecutionMetric = {
  type: AnalyticsEventType;
  props?: Record<string, unknown>;
};

/**
 * 一条已认领事件驱动的所有自动化结果 → 应旁路记录的执行维度事件。
 * awaiting_confirmation 优先于成功/失败：它是运维最该看见的「卡住等确认」信号
 * （aggregateStatus 会把挂起步骤折进 SKIPPED/PARTIAL，只看终态会漏掉堆积）。
 */
export function executionEventForOutcome(
  outcome: AutomationRunOutcome,
): ExecutionMetric | null {
  switch (outcome.status) {
    case "conditions-skipped":
      return { type: "execution_skipped", props: { reason: "conditions" } };
    case "duplicate-skipped":
      return { type: "execution_skipped", props: { reason: "dedupe" } };
    case "loop-blocked":
      return { type: "execution_loop_blocked" };
    case "completed": {
      if (outcome.awaitingConfirmation) {
        return {
          type: "execution_awaiting_confirmation",
          props: { executionStatus: outcome.executionStatus },
        };
      }
      switch (outcome.executionStatus) {
        case "SUCCESS":
          return { type: "execution_succeeded" };
        case "FAILED":
          return { type: "execution_failed" };
        case "PARTIAL_SUCCESS":
          return { type: "execution_partial" };
        case "RETRYING":
          return { type: "execution_retried" };
        case "SKIPPED":
          return { type: "execution_skipped", props: { reason: "all-skipped" } };
        default:
          // RUNNING 不该出现在终态；宁缺毋滥，不虚报。
          return null;
      }
    }
  }
}

// 重试/确认/UNKNOWN 校正的真实库绑定面（P2-16/17）：逻辑全在 lib/automation-retry，本文件只注入 Prisma。
import db from "../db.server";
import {
  retryExecution as retryCore,
  confirmStep as confirmCore,
  correctUnknownStep as correctCore,
  type RetryDeps,
  type RetryOutcome,
  type ConfirmOutcome,
  type CorrectOutcome,
} from "../lib/automation-retry.ts";

/** 整任务/仅失败步重试：新建子执行，原记录不动。shopId 必传（P4-03 租户硬边界）；写/出站依赖由调用方注入。 */
export function retryAutomationExecution(
  input: { shopId: string; executionId: string; failedOnly?: boolean },
  binding: Omit<RetryDeps, "client">,
): Promise<RetryOutcome> {
  return retryCore({ ...binding, client: db }, input);
}

/** 商家确认高风险步：以 confirmed=true 复驱本步，操作者记 merchant。 */
export function confirmAutomationStep(
  input: { shopId: string; stepId: string; actor?: string },
  binding: Omit<RetryDeps, "client">,
): Promise<ConfirmOutcome> {
  return confirmCore({ ...binding, client: db }, input);
}

/** UNKNOWN 回读校正：只读判定，判定不了保持待人工，绝不重发。 */
export function correctUnknownAutomationStep(
  input: { shopId: string; stepId: string },
  binding: Omit<RetryDeps, "client">,
): Promise<CorrectOutcome> {
  return correctCore({ ...binding, client: db }, input);
}

export type {
  RetryOutcome,
  ConfirmOutcome,
  CorrectOutcome,
} from "../lib/automation-retry.ts";

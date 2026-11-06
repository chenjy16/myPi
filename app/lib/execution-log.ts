// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// ExecutionLog / ExecutionStep 落库原语：父子里程碑、部分成功、去重落账、可确认态。
// 只依赖注入的 executionLog / executionStep 代理，可喂假客户端测试，也可喂真实 Prisma。
import type { PrismaClient } from "@prisma/client";
import { isUniqueViolation } from "./sync-job-policy.ts";

export type ExecutionClient = Pick<
  PrismaClient,
  "executionLog" | "executionStep"
>;

/** 执行终态/中间态（DB 层是 String，取值以本联合为准，PRD §16/§25.2）。 */
export type ExecutionStatus =
  | "SUCCESS"
  | "FAILED"
  | "PARTIAL_SUCCESS"
  | "SKIPPED"
  | "RETRYING"
  /// 在途态：日志已建、步骤正逐步执行；finalizeStatus 会改写为终态。
  | "RUNNING";

/** 单步状态；AWAITING_CONFIRMATION 为需人工确认的高风险步骤挂起态（PRD §20.1）。 */
export type StepStatus =
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | "UNKNOWN"
  | "PENDING"
  | "AWAITING_CONFIRMATION";

export type NewExecutionLog = {
  shopId: string;
  automationId: string;
  automationVersion: number;
  triggerType: string;
  status: ExecutionStatus;
  entityRef?: string | null;
  dedupeKey?: string | null;
  cascadeDepth?: number;
  conditionResult?: unknown;
  payload?: unknown;
  parentExecutionId?: string | null;
};

export type NewStep = {
  executionId: string;
  order: number;
  actionId: string;
  status: StepStatus;
  result?: unknown;
  errorText?: string | null;
};

/**
 * 新建一次执行记录。给了 dedupeKey 且撞唯一约束（P2002）说明同一事件已落过账，
 * 返回 null 让上层跳过，而不是重复执行。
 */
export async function createExecutionLog(
  client: ExecutionClient,
  input: NewExecutionLog,
): Promise<{ id: string } | null> {
  try {
    const log = await client.executionLog.create({
      data: {
        shopId: input.shopId,
        automationId: input.automationId,
        automationVersion: input.automationVersion,
        triggerType: input.triggerType,
        status: input.status,
        entityRef: input.entityRef ?? null,
        dedupeKey: input.dedupeKey ?? null,
        cascadeDepth: input.cascadeDepth ?? 0,
        conditionResult: (input.conditionResult ?? undefined) as never,
        payload: (input.payload ?? undefined) as never,
        parentExecutionId: input.parentExecutionId ?? null,
      },
      select: { id: true },
    });
    return log;
  } catch (error) {
    if (input.dedupeKey && isUniqueViolation(error)) return null;
    throw error;
  }
}

/** 追加一个步骤（父执行 Cascade 删时随之清理）。 */
export async function appendStep(
  client: ExecutionClient,
  step: NewStep,
): Promise<{ id: string }> {
  return client.executionStep.create({
    data: {
      executionId: step.executionId,
      order: step.order,
      actionId: step.actionId,
      status: step.status,
      result: (step.result ?? undefined) as never,
      errorText: step.errorText ?? null,
    },
    select: { id: true },
  });
}

/**
 * 回写某步骤的执行结果。执行器需要先建 PENDING 行拿到 ExecutionStep.id
 * （email 去重键 / webhook 幂等键都用它），跑完再落终态——两段式写。
 */
export async function updateStep(
  client: ExecutionClient,
  stepId: string,
  patch: { status: StepStatus; result?: unknown; errorText?: string | null },
): Promise<void> {
  await client.executionStep.update({
    where: { id: stepId },
    data: {
      status: patch.status,
      result: (patch.result ?? undefined) as never,
      errorText: patch.errorText ?? null,
    },
  });
}

/**
 * 按各步骤聚合出执行终态并回写 ExecutionLog.status。纯规则、可单测：
 * - 有 FAILED/UNKNOWN：存在成功→PARTIAL_SUCCESS，否则 FAILED
 * - 否则有 AWAITING/PENDING：存在成功→PARTIAL_SUCCESS（部分完成待确认），否则 SKIPPED
 * - 全 SUCCESS/SKIPPED：有成功→SUCCESS，否则 SKIPPED
 * - 无步骤：SKIPPED
 */
export function aggregateStatus(steps: readonly { status: StepStatus }[]): ExecutionStatus {
  if (steps.length === 0) return "SKIPPED";
  const hasSuccess = steps.some((s) => s.status === "SUCCESS");
  const hasFailure = steps.some(
    (s) => s.status === "FAILED" || s.status === "UNKNOWN",
  );
  const hasPending = steps.some(
    (s) => s.status === "AWAITING_CONFIRMATION" || s.status === "PENDING",
  );
  if (hasFailure) return hasSuccess ? "PARTIAL_SUCCESS" : "FAILED";
  if (hasPending) return hasSuccess ? "PARTIAL_SUCCESS" : "SKIPPED";
  return hasSuccess ? "SUCCESS" : "SKIPPED";
}

/** 读取某执行的全部步骤，聚合后回写终态并返回。 */
export async function finalizeStatus(
  client: ExecutionClient,
  executionId: string,
): Promise<ExecutionStatus> {
  const steps = await client.executionStep.findMany({
    where: { executionId },
    select: { status: true },
    orderBy: { order: "asc" },
  });
  const status = aggregateStatus(
    steps as unknown as { status: StepStatus }[],
  );
  await client.executionLog.update({
    where: { id: executionId },
    data: { status },
  });
  return status;
}

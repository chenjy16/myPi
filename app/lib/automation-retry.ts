// 重试编排 + 高风险确认 + UNKNOWN 校正（P2-16/17）。客户端与写/出站依赖全部注入，可喂假客户端脱库测。
// 三条铁律：
//  1) 重试「新建子 ExecutionLog（parentExecutionId）」，绝不改原始记录；failedOnly 只重跑 FAILED/UNKNOWN 步，
//     SUCCESS 步复制结果不再发（防重复 Mutation）；AWAITING 步保持挂起（重试不等于授权）。
//  2) confirmStep 才把 AWAITING_CONFIRMATION 步骤以 confirmed=true 复驱执行，操作者记 merchant。
//  3) UNKNOWN（超时≠失败）先回读校正：可确证已生效才转 SUCCESS；确证不了绝不自动重发（防重复打标/邮件）。
import type { PrismaClient } from "@prisma/client";
import type { StandardEvent } from "./event-normalizer.ts";
import type { CompiledPlan } from "./automation-compiler.ts";
import {
  appendStep,
  createExecutionLog,
  finalizeStatus,
  updateStep,
  type NewExecutionLog,
  type StepStatus,
} from "./execution-log.ts";
import { executeStep, type StepDeps, type StepOutcome } from "../automation/action-executor.server.ts";
import { correctTagsStep } from "../automation/actions/tags.server.ts";
import { assertShopScope } from "./shop-scope.ts";

export type RetryClient = Pick<
  PrismaClient,
  "executionLog" | "executionStep" | "automationVersion"
>;

export type RetryDeps = {
  client: RetryClient;
  admin: StepDeps["admin"];
  requestSource?: string;
  sentStepIds?: Set<string>;
  email?: StepDeps["email"];
  webhook?: StepDeps["webhook"];
};

type LogRow = {
  id: string;
  shopId: string;
  automationId: string;
  automationVersion: number;
  triggerType: string;
  entityRef: string | null;
  cascadeDepth: number;
  payload: unknown;
};
type StepRow = {
  id: string;
  order: number;
  actionId: string;
  status: string;
  result: unknown;
  executionId: string;
};

/** 从落账的脱敏快照重建可重放的标准事件（重试/确认只重跑步骤，不再重判条件）。 */
function eventFromLog(log: LogRow): StandardEvent {
  const snapshot = (log.payload ?? {}) as Record<string, unknown>;
  const data = (snapshot.data ?? {}) as Record<string, unknown>;
  return {
    shopDomain: typeof snapshot.shopDomain === "string" ? snapshot.shopDomain : "",
    topic: typeof snapshot.topic === "string" ? snapshot.topic : log.triggerType,
    entityType: typeof snapshot.entityType === "string" ? snapshot.entityType : "",
    entityId:
      typeof snapshot.entityId === "string"
        ? snapshot.entityId
        : (log.entityRef ?? null),
    occurredAt:
      typeof snapshot.occurredAt === "string"
        ? new Date(snapshot.occurredAt)
        : new Date(),
    data,
  };
}

async function loadPlan(
  client: RetryClient,
  log: LogRow,
): Promise<CompiledPlan> {
  const version = await client.automationVersion.findUnique({
    where: {
      automationId_version: {
        automationId: log.automationId,
        version: log.automationVersion,
      },
    },
    select: { definition: true },
  });
  if (!version) throw new Error(`Automation version not found: ${log.automationId}@${log.automationVersion}`);
  return version.definition as unknown as CompiledPlan;
}

export type RetryOutcome =
  | { status: "not_found" }
  | { status: "no_child"; reason: string }
  | { status: "retried"; childExecutionId: string; executionStatus: string };

/**
 * 整任务重试 / 仅重试失败步骤：新建子执行，原记录不动。
 * failedOnly=true 时 SUCCESS/SKIPPED 步骤复制结果不重发；FAILED/UNKNOWN 步骤重跑；AWAITING 维持挂起。
 */
export async function retryExecution(
  deps: RetryDeps,
  input: { shopId: string; executionId: string; failedOnly?: boolean },
): Promise<RetryOutcome> {
  const originalRow = (await deps.client.executionLog.findUnique({
    where: { id: input.executionId },
  })) as LogRow | null;
  // 租户硬边界（P4-03）：findUnique 不带租户，取回后立即断言归属；跨店一律视同不存在。
  let original: LogRow;
  try {
    original = assertShopScope(input.shopId, originalRow);
  } catch {
    return { status: "not_found" };
  }

  const steps = (await deps.client.executionStep.findMany({
    where: { executionId: input.executionId },
    orderBy: { order: "asc" },
  })) as unknown as StepRow[];
  if (steps.length === 0) {
    return { status: "no_child", reason: "original execution has no steps to retry" };
  }

  const plan = await loadPlan(deps.client, original);

  // dedupeKey=null：重试是对已处理事件的显式再驱动，绕过唯一去重（且 Postgres 允许多个 null）
  const child = await createExecutionLog(deps.client, {
    shopId: original.shopId,
    automationId: original.automationId,
    automationVersion: original.automationVersion,
    triggerType: original.triggerType,
    status: "RUNNING",
    entityRef: original.entityRef,
    dedupeKey: null,
    cascadeDepth: original.cascadeDepth,
    payload: original.payload ?? undefined,
    parentExecutionId: original.id,
  } satisfies NewExecutionLog);
  if (!child) return { status: "no_child", reason: "child log create refused" };

  const event = eventFromLog(original);
  const stepDeps: StepDeps = {
    stepId: "",
    admin: deps.admin,
    requestSource: deps.requestSource,
    sentStepIds: deps.sentStepIds,
    email: deps.email,
    webhook: deps.webhook,
  };

  for (const prior of steps) {
    const planAction = plan.actions[prior.order];
    if (!planAction) continue;
    const copyable =
      input.failedOnly &&
      (prior.status === "SUCCESS" || prior.status === "SKIPPED");
    const awaiting = prior.status === "AWAITING_CONFIRMATION";

    if (copyable) {
      // 已成功/已跳过：复制结果，绝不重发（防重复 Mutation）
      await appendStep(deps.client, {
        executionId: child.id,
        order: prior.order,
        actionId: prior.actionId,
        status: prior.status as StepStatus,
        result: prior.result ?? undefined,
      });
      continue;
    }
    if (awaiting) {
      // 待确认步：重试不代替授权，原样挂起
      await appendStep(deps.client, {
        executionId: child.id,
        order: prior.order,
        actionId: prior.actionId,
        status: "AWAITING_CONFIRMATION",
      });
      continue;
    }
    // FAILED / UNKNOWN（或 failedOnly=false 的全量）：重跑
    const row = await appendStep(deps.client, {
      executionId: child.id,
      order: prior.order,
      actionId: planAction.actionId,
      status: "PENDING",
    });
    stepDeps.stepId = row.id;
    const outcome = await executeStep(planAction, event, stepDeps);
    await updateStep(deps.client, row.id, {
      status: outcome.status,
      result: outcome.result,
      errorText: outcome.errorText ?? null,
    });
  }

  const executionStatus = await finalizeStatus(deps.client, child.id);
  return { status: "retried", childExecutionId: child.id, executionStatus };
}

export type ConfirmOutcome =
  | { status: "not_found" }
  | { status: "not_awaiting"; currentStatus: string }
  | { status: "confirmed"; stepStatus: StepStatus; executionStatus: string };

/** 商家确认高风险步骤：以 confirmed=true 复驱本步执行，操作者记入来源注释；确认前该步零 Mutation。 */
export async function confirmStep(
  deps: RetryDeps,
  input: { shopId: string; stepId: string; actor?: string },
): Promise<ConfirmOutcome> {
  const actor = input.actor ?? "merchant";
  const step = (await deps.client.executionStep.findUnique({
    where: { id: input.stepId },
  })) as StepRow | null;
  if (!step) return { status: "not_found" };
  // 先断言步所属执行的租户归属，再暴露步骤状态（跨店连「是否在等确认」都不可见）。
  const logRow = (await deps.client.executionLog.findUnique({
    where: { id: step.executionId },
  })) as LogRow | null;
  let log: LogRow;
  try {
    log = assertShopScope(input.shopId, logRow);
  } catch {
    return { status: "not_found" };
  }
  if (step.status !== "AWAITING_CONFIRMATION") {
    return { status: "not_awaiting", currentStatus: step.status };
  }

  const plan = await loadPlan(deps.client, log);
  const planAction = plan.actions[step.order];
  if (!planAction) return { status: "not_awaiting", currentStatus: step.status };

  const event = eventFromLog(log);
  const outcome: StepOutcome = await executeStep(
    planAction,
    event,
    {
      stepId: step.id,
      admin: deps.admin,
      requestSource: `${deps.requestSource ?? "automation"}:confirm:${actor}`,
      sentStepIds: deps.sentStepIds,
      email: deps.email,
      webhook: deps.webhook,
    },
    { confirmed: true },
  );
  await updateStep(deps.client, step.id, {
    status: outcome.status,
    result: outcome.result,
    errorText: outcome.errorText ?? null,
  });
  const executionStatus = await finalizeStatus(deps.client, log.id);
  return { status: "confirmed", stepStatus: outcome.status, executionStatus };
}

export type CorrectOutcome =
  | { status: "not_found" }
  | { status: "not_unknown"; currentStatus: string }
  | { status: "applied"; stepStatus: StepStatus; executionStatus: string }
  | { status: "indeterminate"; reason: string };

/**
 * UNKNOWN（超时≠失败）回读校正（P2-17）：仅只读判定，绝不重发。
 * tags 动作可回读 Shopify 现状：确证已生效→SUCCESS；判定不了（回读不到/出站动作）→保持 UNKNOWN 待人工。
 */
export async function correctUnknownStep(
  deps: RetryDeps,
  input: { shopId: string; stepId: string },
): Promise<CorrectOutcome> {
  const step = (await deps.client.executionStep.findUnique({
    where: { id: input.stepId },
  })) as StepRow | null;
  if (!step) return { status: "not_found" };
  // 同 confirmStep：先断言执行归属，再暴露步骤状态（跨店连「是否 UNKNOWN」都不可见）。
  const logRow = (await deps.client.executionLog.findUnique({
    where: { id: step.executionId },
  })) as LogRow | null;
  let log: LogRow;
  try {
    log = assertShopScope(input.shopId, logRow);
  } catch {
    return { status: "not_found" };
  }
  if (step.status !== "UNKNOWN") {
    return { status: "not_unknown", currentStatus: step.status };
  }

  const plan = await loadPlan(deps.client, log);
  const planAction = plan.actions[step.order];
  if (!planAction) {
    return { status: "indeterminate", reason: "compiled action missing for step order" };
  }

  const event = eventFromLog(log);

  // 仅 tags 动作有可回读的幂等现状，能据 Shopify 当前状态定态；其余一律不自动重发。
  if (planAction.actionId === "tags.add" || planAction.actionId === "tags.remove") {
    const verdict = await correctTagsStep(
      deps.admin,
      planAction,
      event,
      deps.requestSource,
    );
    if (verdict === "applied") {
      await updateStep(deps.client, step.id, {
        status: "SUCCESS",
        result: { correctedBy: "readback", actionId: planAction.actionId },
      });
      const executionStatus = await finalizeStatus(deps.client, log.id);
      return { status: "applied", stepStatus: "SUCCESS", executionStatus };
    }
    if (verdict === "not_applied") {
      // 回读到尚未生效：超时常因请求仍在途，绝不因此刻未生效就重发（防重复打标）。
      return {
        status: "indeterminate",
        reason: "readback shows tag not yet applied; keeping UNKNOWN for manual (no auto-resend)",
      };
    }
    return { status: "indeterminate", reason: "readback unreadable (target missing); keeping UNKNOWN" };
  }

  // email/webhook/product.updateStatus 等无法靠回读安全确证 → 保持 UNKNOWN 待人工，不重发。
  return {
    status: "indeterminate",
    reason: `action ${planAction.actionId} cannot be verified by readback; keeping UNKNOWN for manual`,
  };
}

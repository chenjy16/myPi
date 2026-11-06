// 引擎编排核心（P2-11）：单条已匹配自动化的一次执行——evaluate→(loop)→steps→log 落库。
// 只依赖注入的 ExecutionClient（executionLog/executionStep）与 executeStep 的写/出站依赖，
// 可喂假客户端脱库测试，也可由 execute.server.ts 喂真实 Prisma。
// 顺序铁律（PRD §16/§25.2）：条件不满足只落 SKIPPED 不排步骤；防循环前置在执行前；dedupeKey 唯一撞库即跳过。
import type { StandardEvent } from "./event-normalizer.ts";
import { evaluateConditions, type EvaluationResult } from "./condition-evaluator.ts";
import { fieldWhitelist } from "./trigger-registry.ts";
import {
  checkLoopProtection,
  eventFingerprint,
  type LoopCheckInput,
  type LoopVerdict,
} from "./loop-protector.ts";
import {
  appendStep,
  createExecutionLog,
  finalizeStatus,
  updateStep,
  type ExecutionClient,
  type ExecutionStatus,
} from "./execution-log.ts";
import type { CompiledPlan } from "./automation-compiler.ts";
import { executeStep, type StepDeps } from "../automation/action-executor.server.ts";

export type MatchedPlan = {
  automationId: string;
  version: number;
  plan: CompiledPlan;
};

export type LoopGuard = (input: LoopCheckInput) => LoopVerdict | Promise<LoopVerdict>;

export type EngineDeps = {
  client: ExecutionClient;
  admin: StepDeps["admin"];
  requestSource?: string;
  sentStepIds?: Set<string>;
  email?: StepDeps["email"];
  webhook?: StepDeps["webhook"];
  /** 防循环前置：P2-13b 注入带 db 计数的实现；缺省用纯 checkLoopProtection（无历史=首次）。 */
  loopGuard?: LoopGuard;
  now?: Date;
};

export type RunInput = {
  shopId: string;
  event: StandardEvent;
  match: MatchedPlan;
  parentExecutionId?: string | null;
  cascadeDepth?: number;
};

export type AutomationRunOutcome =
  | { status: "conditions-skipped"; executionId: string | null; evaluation: EvaluationResult }
  | { status: "loop-blocked"; executionId: string | null; reason: string }
  | { status: "duplicate-skipped" }
  | {
      status: "completed";
      executionId: string;
      executionStatus: ExecutionStatus;
      /** 是否有步骤处于 AWAITING_CONFIRMATION（高风险动作待人工确认）；供执行维度埋点，aggregateStatus 会把它折进 SKIPPED/PARTIAL。 */
      awaitingConfirmation: boolean;
    };

/** 条件白名单字段从安全事件子集取值——绝不把整个 raw body 塞进指纹/负载。 */
function pickWhitelist(
  event: StandardEvent,
  whitelist: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of whitelist) {
    if (key in event.data) out[key] = event.data[key];
  }
  return out;
}

/** 脱敏事件快照（供复现判定，仅定位字段 + 白名单值，不含非必要 PII）。 */
function safeSnapshot(
  event: StandardEvent,
  whitelist: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    shopDomain: event.shopDomain,
    topic: event.topic,
    entityType: event.entityType,
    entityId: event.entityId,
    occurredAt: event.occurredAt.toISOString(),
    data: pickWhitelist(event, whitelist),
  };
}

/** 本自动化若执行将新打的 tag（供 auto: 回路识别，取第一个 tags.add 步骤）。 */
function extractPlannedTag(plan: CompiledPlan): string | undefined {
  const step = plan.actions.find(
    (a) => a.actionId === "tags.add" && typeof a.params.tag === "string",
  );
  return step ? (step.params.tag as string) : undefined;
}

export async function runAutomation(
  deps: EngineDeps,
  input: RunInput,
): Promise<AutomationRunOutcome> {
  const now = deps.now ?? new Date();
  const { match, event } = input;
  const plan = match.plan;
  const triggerType = plan.triggerType;
  const whitelist = fieldWhitelist(triggerType);
  const cascadeDepth = input.cascadeDepth ?? 0;
  const keyFields = pickWhitelist(event, whitelist);
  const dedupeKey = eventFingerprint({
    automationId: match.automationId,
    entityType: event.entityType,
    entityId: event.entityId ?? "",
    keyFields,
    now,
  });

  // 1) 条件求值：false 只落 SKIPPED + 逐条明细，不排任何步骤（P2-04）
  const evaluation = evaluateConditions(plan.conditions, event, whitelist);
  if (!evaluation.result) {
    const log = await createExecutionLog(deps.client, {
      shopId: input.shopId,
      automationId: match.automationId,
      automationVersion: match.version,
      triggerType,
      status: "SKIPPED",
      entityRef: event.entityId,
      dedupeKey,
      cascadeDepth,
      conditionResult: evaluation,
      payload: safeSnapshot(event, whitelist),
      parentExecutionId: input.parentExecutionId ?? null,
    });
    return { status: "conditions-skipped", executionId: log?.id ?? null, evaluation };
  }

  // 2) 防循环前置（仅在能定位实体时按指纹判定；无实体不臆测重复）
  if (event.entityId) {
    const loopInput: LoopCheckInput = {
      automationId: match.automationId,
      entityType: event.entityType,
      entityId: event.entityId,
      keyFields,
      cascadeDepth,
      // 纯默认：无历史；db 版由注入的 loopGuard 自行回填真实计数
      duplicateCountInWindow: 0,
      executionsInWindow: 0,
      plannedTag: extractPlannedTag(plan),
      now,
    };
    const verdict = deps.loopGuard
      ? await deps.loopGuard(loopInput)
      : checkLoopProtection(loopInput);
    if (verdict.decision === "block") {
      // loop-blocked 记 SKIPPED（非 FAILED），原因进 conditionResult 供排障
      const log = await createExecutionLog(deps.client, {
        shopId: input.shopId,
        automationId: match.automationId,
        automationVersion: match.version,
        triggerType,
        status: "SKIPPED",
        entityRef: event.entityId,
        dedupeKey,
        cascadeDepth,
        conditionResult: { loopBlocked: verdict.reason, evaluation },
        payload: safeSnapshot(event, whitelist),
        parentExecutionId: input.parentExecutionId ?? null,
      });
      return { status: "loop-blocked", executionId: log?.id ?? null, reason: verdict.reason };
    }
  }

  // 3) 建执行日志（RUNNING 在途态）；dedupeKey 撞唯一索引说明同事件已落账 → 跳过（可靠去重）
  const created = await createExecutionLog(deps.client, {
    shopId: input.shopId,
    automationId: match.automationId,
    automationVersion: match.version,
    triggerType,
    status: "RUNNING",
    entityRef: event.entityId,
    dedupeKey,
    cascadeDepth,
    conditionResult: evaluation,
    payload: safeSnapshot(event, whitelist),
    parentExecutionId: input.parentExecutionId ?? null,
  });
  if (!created) return { status: "duplicate-skipped" };

  // 4) 按定义顺序逐步执行；每步先建 PENDING 拿 id，跑完回写终态；步骤间互不回滚（PRD §25.2）
  const stepDeps: StepDeps = {
    stepId: "",
    admin: deps.admin,
    requestSource: deps.requestSource,
    sentStepIds: deps.sentStepIds,
    email: deps.email,
    webhook: deps.webhook,
  };
  let awaitingConfirmation = false;
  for (let order = 0; order < plan.actions.length; order += 1) {
    const step = plan.actions[order];
    const row = await appendStep(deps.client, {
      executionId: created.id,
      order,
      actionId: step.actionId,
      status: "PENDING",
    });
    stepDeps.stepId = row.id; // email 去重 / webhook 幂等键 = 本步 ExecutionStep.id
    const outcome = await executeStep(step, event, stepDeps);
    if (outcome.status === "AWAITING_CONFIRMATION") awaitingConfirmation = true;
    await updateStep(deps.client, row.id, {
      status: outcome.status,
      result: outcome.result,
      errorText: outcome.errorText ?? null,
    });
  }

  // 5) 聚合终态回写
  const executionStatus = await finalizeStatus(deps.client, created.id);
  return {
    status: "completed",
    executionId: created.id,
    executionStatus,
    awaitingConfirmation,
  };
}

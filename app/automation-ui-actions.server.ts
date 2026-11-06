// 意图式动作处理（P3-14/15）：确认高风险步、整任务/仅失败步重试。
// 全部依赖注入（client / admin / 解密密钥），可喂假客户端脱库单测；路由 action 传真实 db + admin。
// 三条不变量：
//  1) 一切写之前先按 shopId 校验执行归属（引擎 core 用 findUnique 不带租户，这里补上收口）。
//  2) 重试裁决沿用 decideRetry：validation/auth 是「重试也不会变好」的确定性失败 → dead_letter 禁用并给原因；
//     仅当存在 FAILED/UNKNOWN 步且分类可重试才驱动引擎新建子执行（原记录不动）。
//  3) 出站依赖（email/webhook）经 resolveStepBindings 按本店 Integration 注入；未配置干净失败，绝不伪造。
import type { PrismaClient } from "@prisma/client";
import {
  retryExecution,
  confirmStep,
  type RetryDeps,
} from "./lib/automation-retry.ts";
import { resolveStepBindings } from "./lib/action-bindings.ts";
import { getExecutionDetail, type ExecutionDetail } from "./lib/activity.ts";
import { decideRetry } from "./lib/retry-policy.ts";
import type { AppErrorKind } from "./lib/app-error.ts";
import type { CompiledPlan } from "./lib/automation-compiler.ts";

/** 确认/重试/绑定解析/归属校验所需的全部读表面（真实 db 满足此形状）。 */
export type UiActionsClient = Pick<
  PrismaClient,
  "executionLog" | "executionStep" | "automationVersion" | "integration"
>;

export type UiActionsDeps = {
  client: UiActionsClient;
  admin: RetryDeps["admin"];
  requestSource?: string;
  /** 跨重试携带的发信去重集合。 */
  sentStepIds?: Set<string>;
  /** 解密 webhook 签名密钥（缺省取 env）；脱库单测显式注入。 */
  keyHex?: string;
};

export type IntentResult =
  | {
      ok: true;
      kind: "confirmed" | "retried";
      message: string;
      executionStatus?: string;
      childExecutionId?: string;
    }
  | { ok: false; message: string };

export type RetryEligibility = {
  executionId: string;
  allowed: boolean;
  /** 禁用时给商家可读原因（dead_letter / 无失败步）。 */
  reason?: string;
  hasAwaitingStep: boolean;
  hasRetryableFailure: boolean;
  attemptsDone: number;
};

const NOT_FOUND: IntentResult = {
  ok: false,
  message: "We couldn't find that run for this store.",
};

/** 从冻结版本取回编译计划（供绑定解析）；缺版本返回 null，交由引擎自行裁决。 */
async function loadPlan(
  client: UiActionsClient,
  log: { automationId: string; automationVersion: number },
): Promise<CompiledPlan | null> {
  const version = await client.automationVersion.findUnique({
    where: {
      automationId_version: {
        automationId: log.automationId,
        version: log.automationVersion,
      },
    },
    select: { definition: true },
  });
  if (!version) return null;
  return version.definition as unknown as CompiledPlan;
}

/** 把某次失败步骤的可读错误归到 AppErrorKind（沿用引擎口径：validation/auth 不可重试）。 */
export function classifyStepFailure(errorText: string | null): AppErrorKind {
  const t = (errorText ?? "").toLowerCase();
  if (/(auth|permission|not authorized|unauthorized|token|scope|forbidden)/.test(t))
    return "auth";
  if (/(not configured|no \S+ in step|invalid|not executable|cannot resolve)/.test(t))
    return "validation";
  return "shopify_api";
}

/**
 * 判定一次执行能否由商家发起重试：是否存在 FAILED/UNKNOWN 步、其错误分类经 decideRetry 是否放行、
 * 尝试次数是否已耗尽。只读，不产生任何 Mutation。
 */
export async function evaluateRetryEligibility(
  deps: Pick<UiActionsDeps, "client">,
  shopId: string,
  executionId: string,
): Promise<RetryEligibility | null> {
  const detail = await getExecutionDetail(deps.client, shopId, executionId);
  if (!detail) return null;

  const failedSteps = detail.steps.filter(
    (s) => s.status === "FAILED" || s.status === "UNKNOWN",
  );
  const hasAwaitingStep = detail.steps.some(
    (s) => s.status === "AWAITING_CONFIRMATION",
  );
  const attemptsDone = 1 + detail.children.length;

  if (failedSteps.length === 0) {
    return {
      executionId,
      allowed: false,
      reason: "There are no failed steps to retry for this run.",
      hasAwaitingStep,
      hasRetryableFailure: false,
      attemptsDone,
    };
  }

  // 取最"阻断"的分类：auth > validation > shopify_api。
  const kinds = failedSteps.map((s) => classifyStepFailure(s.errorText));
  const blocking: AppErrorKind = kinds.includes("auth")
    ? "auth"
    : kinds.includes("validation")
      ? "validation"
      : "shopify_api";

  const decision = decideRetry(blocking, attemptsDone);
  if (decision.action === "dead_letter") {
    return {
      executionId,
      allowed: false,
      reason:
        decision.reason === "attempts_exhausted"
          ? "This run has already been retried the maximum number of times. Please review it manually."
          : "Retrying won't help here — the step failed for a reason that needs a fix first (for example, a missing integration or a rejected request).",
      hasAwaitingStep,
      hasRetryableFailure: false,
      attemptsDone,
    };
  }

  return {
    executionId,
    allowed: true,
    hasAwaitingStep,
    hasRetryableFailure: true,
    attemptsDone,
  };
}

/** 组装引擎复驱所需的依赖（合并 admin + 本店 Integration 出站绑定）。 */
async function buildRetryDeps(
  deps: UiActionsDeps,
  plan: CompiledPlan | null,
  shopId: string,
): Promise<RetryDeps> {
  const base: RetryDeps = {
    client: deps.client,
    admin: deps.admin,
    requestSource: deps.requestSource,
    sentStepIds: deps.sentStepIds,
  };
  if (!plan) return base;
  const bindings = await resolveStepBindings(deps.client, shopId, plan, {
    keyHex: deps.keyHex,
  });
  return { ...base, email: bindings.email, webhook: bindings.webhook };
}

/**
 * 商家确认高风险步骤（P3-14）。确认前该步保持 AWAITING、零 Mutation；
 * 本函数只在归属校验通过后复驱本步，操作者记 merchant。
 */
export async function confirmStepAction(
  deps: UiActionsDeps,
  input: { shopId: string; stepId: string },
): Promise<IntentResult> {
  const step = await deps.client.executionStep.findUnique({
    where: { id: input.stepId },
    select: { executionId: true },
  });
  if (!step) return NOT_FOUND;
  // 归属收口：step 所属执行必须属于当前店铺，否则视为不可见。
  const log = await deps.client.executionLog.findFirst({
    where: { id: step.executionId, shopId: input.shopId },
  });
  if (!log) return NOT_FOUND;

  const plan = await loadPlan(deps.client, log);
  const retryDeps = await buildRetryDeps(deps, plan, input.shopId);
  const outcome = await confirmStep(retryDeps, {
    shopId: input.shopId,
    stepId: input.stepId,
    actor: "merchant",
  });

  if (outcome.status === "not_found") return NOT_FOUND;
  if (outcome.status === "not_awaiting") {
    return {
      ok: false,
      message: "This step no longer needs confirmation, so nothing was changed.",
    };
  }
  return {
    ok: true,
    kind: "confirmed",
    message: "Confirmed. The step has been carried out.",
    executionStatus: outcome.executionStatus,
  };
}

/**
 * 整任务 / 仅失败步重试（P3-15）。先过 decideRetry 裁决，不可重试即禁用带原因、绝不新建；
 * 放行时由引擎新建子执行（原记录保留）。failedOnly=true 时成功步复制结果不重发。
 */
export async function retryExecutionAction(
  deps: UiActionsDeps,
  input: { shopId: string; executionId: string; failedOnly: boolean },
): Promise<IntentResult> {
  const eligibility = await evaluateRetryEligibility(
    { client: deps.client },
    input.shopId,
    input.executionId,
  );
  if (!eligibility) return NOT_FOUND;
  if (!eligibility.allowed) {
    return { ok: false, message: eligibility.reason ?? "This run can't be retried." };
  }

  const detail = await getExecutionDetail(
    deps.client,
    input.shopId,
    input.executionId,
  );
  if (!detail) return NOT_FOUND;
  const plan = await loadPlan(deps.client, {
    automationId: detail.automationId,
    automationVersion: detail.automationVersion,
  });
  const retryDeps = await buildRetryDeps(deps, plan, input.shopId);
  const outcome = await retryExecution(retryDeps, {
    shopId: input.shopId,
    executionId: input.executionId,
    failedOnly: input.failedOnly,
  });

  if (outcome.status === "not_found") return NOT_FOUND;
  if (outcome.status === "no_child") {
    return { ok: false, message: `Nothing was retried: ${outcome.reason}.` };
  }
  return {
    ok: true,
    kind: "retried",
    message: input.failedOnly
      ? "Started a new run that retries only the failed steps. The original run is kept."
      : "Started a new run. The original run is kept.",
    executionStatus: outcome.executionStatus,
    childExecutionId: outcome.childExecutionId,
  };
}

export type { ExecutionDetail };

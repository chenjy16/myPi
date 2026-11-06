// Email 执行器（P2-09）：定义出站发信契约 + 可注入 provider。
// 真实 provider 未定（OQ-8/D-5）→ Phase 2 用注入 stub，Phase 3 接 Resend/SendGrid。
// 铁律：未接线时明确返回「未配置」错误而非静默成功；以 ExecutionStep.id 去重防重复发信；
// 失败折进步骤 FAILED（返回 errorText），绝不 crash（对齐引擎「失败标记不抛出」口径）。
import type { StandardEvent } from "../../lib/event-normalizer.ts";
import type { CompiledActionStep } from "../../lib/automation-compiler.ts";

export type EmailSendArgs = {
  integrationRef: string;
  to: string | null;
  template: string;
  vars: Record<string, unknown>;
  /** ExecutionStep.id：provider 侧据此去重（重试不重复发信）。 */
  dedupeKey: string;
};

export type EmailProvider = (args: EmailSendArgs) => Promise<void>;

export type EmailContext = {
  integrationRef: string;
  /** 未注入 = 服务未接线；sendEmail 明确报「未配置」，不静默。 */
  provider?: EmailProvider;
  /** 进程内 ExecutionStep.id 去重集合（引擎按执行注入）。 */
  sentStepIds: Set<string>;
  stepId: string;
};

export type ActionExecResult = {
  success: boolean;
  data?: Record<string, unknown>;
  errorText?: string;
};

/** 核心服务接口：具体 provider 由上层注入；未配置即明确失败（验收：email 未接线时非静默）。 */
export async function sendEmail(
  args: EmailSendArgs,
  provider?: EmailProvider,
): Promise<void> {
  if (!provider) {
    throw new Error(
      "Email service is not configured yet. Connect an email integration to send.",
    );
  }
  await provider(args);
}

/** vars 声明的是要注入的上下文字段名，值从事件安全字段集补齐（缺失即 undefined）。 */
function collectVars(
  step: CompiledActionStep,
  event: StandardEvent,
): Record<string, unknown> {
  const names = step.params.vars;
  const out: Record<string, unknown> = {};
  if (Array.isArray(names)) {
    for (const name of names) {
      if (typeof name === "string") out[name] = event.data[name];
    }
  }
  return out;
}

export async function executeEmailSend(
  step: CompiledActionStep,
  event: StandardEvent,
  ctx: EmailContext,
): Promise<ActionExecResult> {
  const template =
    typeof step.params.template === "string" && step.params.template
      ? step.params.template
      : null;
  if (!template) {
    return { success: false, errorText: "Send email: no template in step params." };
  }
  // ExecutionStep.id 去重：同一步骤重放（如重试恢复）不重复发信
  if (ctx.sentStepIds.has(ctx.stepId)) {
    return { success: true, data: { idempotent: true, template } };
  }
  const to =
    typeof step.params.to === "string" && step.params.to ? step.params.to : null;
  try {
    await sendEmail(
      {
        integrationRef: ctx.integrationRef,
        to,
        template,
        vars: collectVars(step, event),
        dedupeKey: ctx.stepId,
      },
      ctx.provider,
    );
    ctx.sentStepIds.add(ctx.stepId);
    return { success: true, data: { sent: true, template, to } };
  } catch (error) {
    return { success: false, errorText: readableError(error) };
  }
}

/** 商家可读错误：只透安全摘要，原始堆栈永不外泄（P3 口径）。 */
function readableError(error: unknown): string {
  if (error instanceof Error && "kind" in error) {
    const appError = error as Error & { kind: string; detail?: string };
    return appError.detail
      ? `${appError.message} (${appError.detail})`.slice(0, 500)
      : appError.message.slice(0, 500);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

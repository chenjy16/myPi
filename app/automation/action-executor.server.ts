// 步骤级执行调度（P2-10）：按编译步骤的 confirmation 裁决分派，高风险先挂起不擅自动作。
// 铁律（验收 E2E 场景 H）：confirmation=required 且未经确认 → 只落 AWAITING_CONFIRMATION，
// 绝不调用任何写封装/Mutation/网络（零副作用）。auto 才按 actionId 分派到对应执行器。
// 确认后的执行由 P2-16 confirmStep 以 confirmed=true 复驱本函数，走同一分派表。
import { adminGraphqlWrite } from "../lib/admin-graphql.server.ts";
import { toGid } from "../lib/shopify-id.ts";
import type { StepStatus } from "../lib/execution-log.ts";
import type { StandardEvent } from "../lib/event-normalizer.ts";
import type { CompiledActionStep } from "../lib/automation-compiler.ts";
import {
  executeTagsAdd,
  executeTagsRemove,
  type ActionExecResult,
  type ExecutorContext,
} from "./actions/tags.server.ts";
import { executeEmailSend, type EmailProvider } from "./actions/email.server.ts";
import { executeWebhookSend } from "./actions/outbound-webhook.server.ts";

export type StepOutcome = {
  status: StepStatus;
  result?: Record<string, unknown>;
  errorText?: string;
};

export type StepDeps = {
  /** ExecutionStep.id：email 去重键 / webhook 幂等键。 */
  stepId: string;
  admin: ExecutorContext["admin"];
  requestSource?: string;
  /** 引擎跨重试携带的发信去重集合。 */
  sentStepIds?: Set<string>;
  email?: { integrationRef: string; provider?: EmailProvider };
  webhook?: {
    endpointUrl: string;
    secret?: string | null;
    resolveAddresses?: (hostname: string) => Promise<string[]>;
    fetchImpl?: typeof fetch;
  };
};

export type ExecuteStepOptions = {
  /** P2-16 确认后复驱：绕过挂起门直接执行（已获商家授权）。 */
  confirmed?: boolean;
};

export async function executeStep(
  step: CompiledActionStep,
  event: StandardEvent,
  deps: StepDeps,
  options: ExecuteStepOptions = {},
): Promise<StepOutcome> {
  // 确认门：required 且未确认 → 挂起，零 Mutation（先于任何分派，杜绝副作用泄漏）
  if (step.confirmation === "required" && !options.confirmed) {
    return { status: "AWAITING_CONFIRMATION" };
  }

  switch (step.actionId) {
    case "tags.add":
      return toOutcome(
        await executeTagsAdd(step, event, { admin: deps.admin, requestSource: deps.requestSource }),
      );
    case "tags.remove":
      return toOutcome(
        await executeTagsRemove(step, event, {
          admin: deps.admin,
          requestSource: deps.requestSource,
        }),
      );
    case "email.send":
      return toOutcome(
        await executeEmailSend(step, event, {
          integrationRef: deps.email?.integrationRef ?? "",
          provider: deps.email?.provider,
          sentStepIds: deps.sentStepIds ?? new Set<string>(),
          stepId: deps.stepId,
        }),
      );
    case "webhook.send":
      return toOutcome(
        await executeWebhookSend(step, event, {
          endpointUrl: deps.webhook?.endpointUrl ?? "",
          secret: deps.webhook?.secret,
          resolveAddresses: deps.webhook?.resolveAddresses,
          fetchImpl: deps.webhook?.fetchImpl,
          idempotencyKey: deps.stepId,
        }),
      );
    case "product.updateStatus":
      return toOutcome(await executeProductStatus(step, event, deps));
    default:
      // 编译期（P2-18）已拦未知动作；运行期兜底为不可达动作标 FAILED，绝不静默放行。
      return {
        status: "FAILED",
        errorText: `Action is not executable: ${step.actionId}.`,
      };
  }
}

const PRODUCT_STATUS_MUTATION = `mutation MypiProductStatus($id: ID!, $status: ProductStatus!) {
  productUpdate(id: $id, product: { status: $status }) {
    product { id }
    userErrors { field message }
  }
}`;

/** 商品改状态（high）：确认后执行；幂等（同状态重写无副作用，V-11）。 */
async function executeProductStatus(
  step: CompiledActionStep,
  event: StandardEvent,
  deps: StepDeps,
): Promise<ActionExecResult> {
  const status = step.params.status;
  if (typeof status !== "string" || status === "") {
    return { success: false, errorText: "Update status: no product status in step params." };
  }
  const gid = toGid(event.entityId, "Product");
  if (!gid) {
    return {
      success: false,
      errorText: "Update status: cannot resolve a Product target from the event.",
    };
  }
  try {
    await adminGraphqlWrite(deps.admin, PRODUCT_STATUS_MUTATION, {
      variables: { id: gid, status },
      requestSource: deps.requestSource,
    });
    return { success: true, data: { status, product: gid } };
  } catch (error) {
    return { success: false, errorText: readableError(error) };
  }
}

function toOutcome(result: ActionExecResult): StepOutcome {
  return result.success
    ? { status: "SUCCESS", result: result.data }
    : { status: "FAILED", errorText: result.errorText };
}

function readableError(error: unknown): string {
  if (error instanceof Error && "kind" in error) {
    const appError = error as Error & { kind: string; detail?: string };
    return appError.detail
      ? `${appError.message} (${appError.detail})`.slice(0, 500)
      : appError.message.slice(0, 500);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

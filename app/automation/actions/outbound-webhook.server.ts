// 出站 Webhook 执行器（P2-09）：postToUrl 先过 SSRF 守卫再发 HTTPS。
// 地址判定唯一走 P2-09a 纯 ssrf-guard；DNS 解析 / fetch 全可注入（Phase 2 不触真实网络，测试给假解析）。
// 防 DNS Rebinding：解析出的每一批 IP 都回到 assertResolvedAddresses 过一遍，任一命中内网/保留段即拒。
// 携带幂等键 header（ExecutionStep.id），接收方据此去重；两者均 low 风险（自动执行）。
import { promises as dns } from "node:dns";
import {
  assertResolvedAddresses,
  validateOutboundUrl,
} from "../../lib/ssrf-guard.ts";
import type { StandardEvent } from "../../lib/event-normalizer.ts";
import type { CompiledActionStep } from "../../lib/automation-compiler.ts";

export type WebhookContext = {
  /** 目标端点，来自 Integration.config（P1-16 解密取 secret；接线延后由上层提供 URL）。 */
  endpointUrl: string;
  /** 可选签名/鉴权密钥；未提供则不带签名头。 */
  secret?: string | null;
  /** 解析器：默认走 node dns（A+AAAA）；测试注入固定 IP 以覆盖守卫分支。 */
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  /** ExecutionStep.id 作幂等键（接收方负责去重）。 */
  idempotencyKey: string;
};

export type ActionExecResult = {
  success: boolean;
  data?: Record<string, unknown>;
  errorText?: string;
};

async function defaultResolve(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/** 仅 https + SSRF 形状校验 + 解析后逐 IP 判定；带幂等键 header。任何拒绝都抛可读错误。 */
export async function postToUrl(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  ctx: Pick<WebhookContext, "resolveAddresses" | "fetchImpl" | "secret">,
): Promise<void> {
  const verdict = validateOutboundUrl(url);
  if (!verdict.ok) {
    throw new Error(`Blocked by SSRF guard: ${verdict.reason}`);
  }
  const resolve = ctx.resolveAddresses ?? defaultResolve;
  const ips = await resolve(verdict.hostname);
  const check = assertResolvedAddresses(ips);
  if (!check.ok) {
    throw new Error(`Blocked by SSRF guard: ${check.reason}`);
  }
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "user-agent": "mypi-automation/2.0",
  };
  if (ctx.secret) headers["x-mypi-signature"] = ctx.secret;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Endpoint responded HTTP ${response.status}.`);
  }
}

/** 只投递安全结构化负载（事件定位字段），绝不转储原始 body（PII 边界，对齐 P2-05 白名单）。 */
function buildPayload(step: CompiledActionStep, event: StandardEvent): Record<string, unknown> {
  return {
    automation: { shopDomain: event.shopDomain, topic: event.topic },
    entity: { type: event.entityType, id: event.entityId },
    occurredAt: event.occurredAt.toISOString(),
    actionId: step.actionId,
  };
}

export async function executeWebhookSend(
  step: CompiledActionStep,
  event: StandardEvent,
  ctx: WebhookContext,
): Promise<ActionExecResult> {
  const integrationId =
    typeof step.params.integrationId === "string" && step.params.integrationId
      ? step.params.integrationId
      : null;
  if (!integrationId) {
    return { success: false, errorText: "Send webhook: no integrationId in step params." };
  }
  // 端点未配置 = 明确失败非静默（对齐 email 口径）
  if (!ctx.endpointUrl) {
    return {
      success: false,
      errorText:
        "Outbound webhook endpoint is not configured yet. Connect a webhook integration first.",
    };
  }
  try {
    await postToUrl(ctx.endpointUrl, buildPayload(step, event), ctx.idempotencyKey, {
      resolveAddresses: ctx.resolveAddresses,
      fetchImpl: ctx.fetchImpl,
      secret: ctx.secret,
    });
    return { success: true, data: { delivered: true, integrationId } };
  } catch (error) {
    return { success: false, errorText: readableError(error) };
  }
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

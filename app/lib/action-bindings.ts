// 带扩展名是故意的：本模块要能被 `node --test` 直接加载。
// 步骤绑定解析（P3-14/15，供确认/重试复驱执行）：把冻结计划里的 email.send / webhook.send
// 步骤映射到店铺已配置的 Integration，解密注入执行依赖（StepDeps 形状）。
// 红线：明文密钥只在此处从密文解出并直接交给执行器，绝不回显给页面；tags 类动作只需 admin，
// 不读任何 Integration；未配置的出站步留空，由 P2-09 执行器按「not configured」干净失败（诚实边界）。
import type { Integration, PrismaClient } from "@prisma/client";
import { decryptSecret } from "./crypto-box.ts";
import type { CompiledPlan } from "./automation-compiler.ts";

/** 只需读 Integration 归属店铺的连接配置。 */
export type ActionBindingsClient = Pick<PrismaClient, "integration">;

/** email.send 步的执行绑定（integrationRef 必填；真实 provider 接线留 Phase 4）。 */
export type EmailBinding = { integrationRef: string };

/** webhook.send 步的执行绑定；endpointUrl 来自 Integration.config，secret 由密文解出。 */
export type WebhookBinding = { endpointUrl: string; secret: string | null };

export type StepBindings = {
  email?: EmailBinding;
  webhook?: WebhookBinding;
};

export type ResolveBindingsDeps = {
  /** 解密密钥（缺省取 env）；脱库单测显式注入。 */
  keyHex?: string;
};

function configOf(row: Integration): Record<string, unknown> {
  return (row.config ?? {}) as Record<string, unknown>;
}

/** 计划里是否含某动作步骤。 */
function hasAction(plan: CompiledPlan, actionId: string): boolean {
  return plan.actions.some((a) => a.actionId === actionId);
}

/** 取计划中 webhook.send 步骤引用的第一个 integrationId（引擎按单绑定复驱）。 */
function webhookIntegrationId(plan: CompiledPlan): string | null {
  for (const a of plan.actions) {
    if (a.actionId === "webhook.send") {
      const id = a.params.integrationId;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/**
 * 依计划解析执行/重试/确认所需的出站绑定。只读、按 shopId 收口（跨店 Integration 查不到即留空）。
 * 无 email/webhook 步骤时对应绑定省略，调用方注入 admin 即可跑通打标类自动化。
 */
export async function resolveStepBindings(
  client: ActionBindingsClient,
  shopId: string,
  plan: CompiledPlan,
  deps: ResolveBindingsDeps = {},
): Promise<StepBindings> {
  const out: StepBindings = {};

  if (hasAction(plan, "email.send")) {
    const email = await client.integration.findFirst({
      where: { shopId, kind: "EMAIL" },
      orderBy: { createdAt: "desc" },
    });
    // 未配置 EMAIL 集成 → 不注入，执行器按「not configured」干净失败（不伪造发信）。
    if (email) out.email = { integrationRef: email.id };
  }

  const integrationId = webhookIntegrationId(plan);
  if (integrationId) {
    // 归属校验：只认本店 Integration，跨店 id 查不到 → 留空干净失败。
    const hook = await client.integration.findFirst({
      where: { id: integrationId, shopId, kind: "CUSTOM_WEBHOOK" },
    });
    if (hook) {
      const config = configOf(hook);
      const endpointUrl = typeof config.url === "string" ? config.url : "";
      const secret = hook.secretsEncrypted
        ? decryptSecret(hook.secretsEncrypted, deps.keyHex)
        : null;
      out.webhook = { endpointUrl, secret };
    }
  }

  return out;
}

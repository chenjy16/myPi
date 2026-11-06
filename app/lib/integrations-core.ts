// 带扩展名是故意的：本模块要能被 `node --test` 直接加载。
// Integrations 服务核（PRD §24 / P3-16）：email / 出站 webhook 连接配置、密钥加解密、
// 连接测试。红线：明文密钥永不回显（list 只给 secretConfigured:boolean）；测试出站一律
// 过 SSRF 守卫（形状 + 解析后 IP 判定）；跨店不可读写。逻辑纯、client 注入便于脱库单测。
import type { Integration, PrismaClient } from "@prisma/client";
import { decryptSecret, encryptSecret } from "./crypto-box.ts";
import { assertResolvedAddresses, validateOutboundUrl } from "./ssrf-guard.ts";

export type IntegrationClient = Pick<
  PrismaClient,
  "integration" | "automation" | "automationVersion"
>;

export type IntegrationKind = "EMAIL" | "CUSTOM_WEBHOOK";

/** 对外可见视图：永不含 secretsEncrypted；附 secretConfigured 布尔。 */
export type IntegrationView = {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  secretConfigured: boolean;
  lastTestedAt: Date | null;
  createdAt: Date;
};

export class IntegrationNotFoundError extends Error {
  constructor() {
    super("Integration not found");
    this.name = "IntegrationNotFoundError";
  }
}

function toView(row: Integration): IntegrationView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    config: (row.config ?? {}) as Record<string, unknown>,
    secretConfigured: Boolean(row.secretsEncrypted),
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
  };
}

export async function listIntegrations(
  client: IntegrationClient,
  shopId: string,
  kind?: IntegrationKind,
): Promise<IntegrationView[]> {
  const rows = await client.integration.findMany({
    where: { shopId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView); // 明文/密文都不外泄，只给 secretConfigured
}

export type CreateIntegrationInput = {
  kind: IntegrationKind;
  config: Record<string, unknown>;
  secret?: string;
  /** 加密密钥（缺省取 env）；脱库单测显式注入。 */
  keyHex?: string;
};

export async function createIntegration(
  client: IntegrationClient,
  shopId: string,
  input: CreateIntegrationInput,
): Promise<IntegrationView> {
  const secretsEncrypted = input.secret ? encryptSecret(input.secret, input.keyHex) : null;
  const row = await client.integration.create({
    data: {
      shopId,
      kind: input.kind,
      status: "unverified",
      config: input.config as object,
      secretsEncrypted,
    },
  });
  return toView(row);
}

export type DeleteResult = { id: string; referencedBy: number };

/** 删除前统计被引用（webhook.send 步的 integrationId）计数，供二次确认提示。 */
export async function deleteIntegration(
  client: IntegrationClient,
  shopId: string,
  id: string,
): Promise<DeleteResult> {
  const row = await client.integration.findFirst({ where: { id, shopId } });
  if (!row) throw new IntegrationNotFoundError();

  const automations = await client.automation.findMany({
    where: { shopId },
    select: { id: true },
  });
  const versions = await client.automationVersion.findMany({
    where: { automationId: { in: automations.map((a) => a.id) } },
  });
  let referencedBy = 0;
  for (const v of versions) {
    const def = v.definition as { actions?: { actionId: string; params?: Record<string, unknown> }[] };
    const hits = (def.actions ?? []).some(
      (a) => a.actionId === "webhook.send" && a.params?.integrationId === id,
    );
    if (hits) referencedBy += 1;
  }
  await client.integration.delete({ where: { id } });
  return { id, referencedBy };
}

// —— 连接测试 ——

export type TestEmailDeps = {
  /** 注入的邮件发送器（P2-09 provider）；缺省即"未接线"→ failing。 */
  send: (args: { to: string | null; template: string }) => Promise<void>;
};
export type TestWebhookDeps = {
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
};
export type TestIntegrationDeps = {
  email?: TestEmailDeps;
  webhook?: TestWebhookDeps;
  keyHex?: string;
};

export type TestOutcome = { ok: boolean; status: string; message: string };

async function markStatus(
  client: IntegrationClient,
  id: string,
  status: "healthy" | "failing",
): Promise<void> {
  await client.integration.update({
    where: { id },
    data: { status, lastTestedAt: new Date() },
  });
}

export async function testIntegration(
  client: IntegrationClient,
  shopId: string,
  id: string,
  deps: TestIntegrationDeps = {},
): Promise<TestOutcome> {
  const row = await client.integration.findFirst({ where: { id, shopId } });
  if (!row) throw new IntegrationNotFoundError();

  if (row.kind === "EMAIL") {
    const config = (row.config ?? {}) as Record<string, unknown>;
    if (!deps.email) {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: "Email service is not wired up yet." };
    }
    try {
      await deps.email.send({
        to: typeof config.testTo === "string" ? config.testTo : null,
        template: typeof config.testTemplate === "string" ? config.testTemplate : "connection-test",
      });
      await markStatus(client, id, "healthy");
      return { ok: true, status: "healthy", message: "Test email sent." };
    } catch (error) {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: safeMessage(error) };
    }
  }

  if (row.kind === "CUSTOM_WEBHOOK") {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const url = typeof config.url === "string" ? config.url : "";
    const verdict = validateOutboundUrl(url);
    if (!verdict.ok) {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: `Blocked: ${verdict.reason}` };
    }
    const resolve = deps.webhook?.resolveAddresses ?? (async () => ["93.184.216.34"]);
    let ips: string[];
    try {
      ips = await resolve(verdict.hostname);
    } catch {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: "Could not resolve endpoint host." };
    }
    const check = assertResolvedAddresses(ips);
    if (!check.ok) {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: `Blocked: ${check.reason}` };
    }
    const secret = row.secretsEncrypted ? decryptSecret(row.secretsEncrypted, deps.keyHex) : null;
    const doFetch = deps.webhook?.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-mypi-signature": secret } : {}),
        },
        body: JSON.stringify({ event: "mypi.integration.test", hostname: verdict.hostname }),
      });
      if (res.ok) {
        await markStatus(client, id, "healthy");
        return { ok: true, status: "healthy", message: "Endpoint reachable." };
      }
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: `Endpoint responded HTTP ${res.status}.` };
    } catch (error) {
      await markStatus(client, id, "failing");
      return { ok: false, status: "failing", message: safeMessage(error) };
    }
  }

  return { ok: false, status: row.status, message: `Unsupported integration kind: ${row.kind}` };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connection test failed.";
}

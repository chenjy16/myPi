import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIntegration,
  listIntegrations,
  deleteIntegration,
  testIntegration,
  IntegrationNotFoundError,
  type IntegrationClient,
} from "../app/lib/integrations-core.ts";
import { decryptSecret } from "../app/lib/crypto-box.ts";

// P3-16 服务测（脱库）：secret 加密往返可用且页面值无明文；SSRF 拦内网；跨店隔离。

const KEY_HEX = "0".repeat(64); // 测试密钥（64 hex）；真机走 env。

type IRow = Record<string, unknown> & { id: string; shopId: string };

function makeFakeDb() {
  const integrations: IRow[] = [];
  const automations: IRow[] = [];
  const versions: { id: string; automationId: string; definition: unknown }[] = [];
  let seq = 0;

  const inList = (val: unknown, cond: unknown) =>
    cond && typeof cond === "object" && "in" in (cond as object)
      ? (cond as { in: unknown[] }).in.includes(val)
      : val === cond;

  const client = {
    integration: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row: IRow = {
          id: `int-${++seq}`,
          shopId: data.shopId as string,
          kind: data.kind as string,
          status: (data.status as string) ?? "unverified",
          config: data.config,
          secretsEncrypted: data.secretsEncrypted ?? null,
          lastTestedAt: null,
          createdAt: new Date(),
        };
        integrations.push(row);
        return { ...row };
      },
      async findMany({ where }: { where?: Record<string, unknown> }) {
        return integrations
          .filter((r) => (!where?.shopId || r.shopId === where.shopId) && (!where?.kind || r.kind === where.kind))
          .map((r) => ({ ...r }));
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        const r = integrations.find(
          (x) => (!where?.id || x.id === where.id) && (!where?.shopId || x.shopId === where.shopId),
        );
        return r ? { ...r } : null;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const r = integrations.find((x) => x.id === where.id);
        if (!r) throw new Error("update: not found");
        Object.assign(r, data);
        return { ...r };
      },
      async delete({ where }: { where: { id: string } }) {
        const idx = integrations.findIndex((x) => x.id === where.id);
        const [removed] = integrations.splice(idx, 1);
        return removed;
      },
    },
    automation: {
      async findMany({ where }: { where?: Record<string, unknown> }) {
        return automations
          .filter((a) => !where?.shopId || a.shopId === where.shopId)
          .map((a) => ({ id: a.id }));
      },
    },
    automationVersion: {
      async findMany({ where }: { where?: Record<string, unknown> }) {
        const inIds = (where?.automationId as { in: string[] } | undefined)?.in ?? [];
        return versions.filter((v) => inList(v.automationId, { in: inIds }));
      },
    },
  };
  return {
    client: client as unknown as IntegrationClient,
    seed: { integrations, automations, versions },
    addAutomation: (id: string, shopId: string) => automations.push({ id, shopId }),
    addVersion: (automationId: string, definition: unknown) =>
      versions.push({ id: `v-${++seq}`, automationId, definition }),
  };
}

test("createIntegration stores ciphertext and list reveals no plaintext", async () => {
  const { client, seed } = makeFakeDb();
  const view = await createIntegration(client, "shop-1", {
    kind: "CUSTOM_WEBHOOK",
    config: { url: "https://example.com/hook" },
    secret: "super-secret-token",
    keyHex: KEY_HEX,
  });
  assert.equal(view.secretConfigured, true);
  assert.equal(JSON.stringify(view).includes("super-secret-token"), false);

  const stored = seed.integrations[0];
  assert.ok(stored.secretsEncrypted);
  assert.equal(stored.secretsEncrypted !== "super-secret-token", true);
  // 加密往返可用
  assert.equal(decryptSecret(String(stored.secretsEncrypted), KEY_HEX), "super-secret-token");

  const [listed] = await listIntegrations(client, "shop-1");
  assert.equal(listed.secretConfigured, true);
  assert.equal("secretsEncrypted" in listed, false);
  assert.equal(JSON.stringify(listed).includes("super-secret-token"), false);
});

test("testIntegration: EMAIL without a wired provider is failing, never fabricated healthy", async () => {
  const { client } = makeFakeDb();
  const created = await createIntegration(client, "shop-1", {
    kind: "EMAIL",
    config: { testTo: "ops@example.com", testTemplate: "ping" },
  });
  const outcome = await testIntegration(client, "shop-1", created.id, {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "failing");
});

test("testIntegration: EMAIL with provider success marks healthy", async () => {
  const { client } = makeFakeDb();
  let sent = false;
  const created = await createIntegration(client, "shop-1", { kind: "EMAIL", config: {} });
  const outcome = await testIntegration(client, "shop-1", created.id, {
    email: { send: async () => { sent = true; } },
  });
  assert.equal(sent, true);
  assert.equal(outcome.status, "healthy");
});

test("testIntegration: webhook resolving to a private IP is blocked by SSRF guard (no fetch)", async () => {
  const { client } = makeFakeDb();
  let fetched = false;
  const created = await createIntegration(client, "shop-1", {
    kind: "CUSTOM_WEBHOOK",
    config: { url: "https://internal.example.com/hook" },
    secret: "sig",
    keyHex: KEY_HEX,
  });
  const outcome = await testIntegration(client, "shop-1", created.id, {
    webhook: {
      resolveAddresses: async () => ["10.0.0.5"],
      fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; },
    },
  });
  assert.equal(fetched, false, "must not connect to a blocked address");
  assert.equal(outcome.status, "failing");
});

test("testIntegration: webhook to a public IP with 2xx marks healthy", async () => {
  const { client } = makeFakeDb();
  const created = await createIntegration(client, "shop-1", {
    kind: "CUSTOM_WEBHOOK",
    config: { url: "https://hooks.example.com/erp" },
    secret: "sig",
    keyHex: KEY_HEX,
  });
  const outcome = await testIntegration(client, "shop-1", created.id, {
    keyHex: KEY_HEX,
    webhook: {
      resolveAddresses: async () => ["93.184.216.34"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.equal(outcome.status, "healthy");
});

test("deleteIntegration returns reference count and is shop-scoped", async () => {
  const { client, addAutomation, addVersion } = makeFakeDb();
  const created = await createIntegration(client, "shop-1", {
    kind: "CUSTOM_WEBHOOK",
    config: { url: "https://x.example.com" },
  });
  addAutomation("a1", "shop-1");
  addVersion("a1", {
    actions: [{ actionId: "webhook.send", params: { integrationId: created.id } }],
  });
  const result = await deleteIntegration(client, "shop-1", created.id);
  assert.equal(result.referencedBy, 1);
});

test("cross-shop access to an integration is denied", async () => {
  const { client } = makeFakeDb();
  const created = await createIntegration(client, "shop-1", { kind: "EMAIL", config: {} });
  await assert.rejects(() => testIntegration(client, "shop-2", created.id, {}), IntegrationNotFoundError);
  await assert.rejects(() => deleteIntegration(client, "shop-2", created.id), IntegrationNotFoundError);
});

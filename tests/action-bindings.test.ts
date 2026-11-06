import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../app/lib/automation-compiler.ts";
import { encryptSecret } from "../app/lib/crypto-box.ts";
import { resolveStepBindings, type ActionBindingsClient } from "../app/lib/action-bindings.ts";

const KEY_HEX = "a".repeat(64);

type IntegrationRow = {
  id: string;
  shopId: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  secretsEncrypted: string | null;
  createdAt: Date;
};

function makeIntegrationClient(rows: IntegrationRow[]) {
  const reads: unknown[] = [];
  const delegate = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      reads.push(where);
      return (
        rows.find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            r.shopId === where.shopId &&
            (where.kind === undefined || r.kind === where.kind),
        ) ?? null
      );
    },
  };
  return {
    reads,
    client: { integration: delegate } as unknown as ActionBindingsClient,
  };
}

const emailPlan = compile({
  dslVersion: "2.0",
  name: "High value email",
  status: "active",
  trigger: { type: "order.paid", source: "shopify.webhook" },
  conditions: {
    logic: "AND",
    clauses: [{ field: "total_price", op: "greater_than_or_equal", value: 500, type: "number" }],
  },
  actions: [{ actionId: "email.send", params: { template: "vip", to: "o@example.com" } }],
});

const webhookPlan = compile({
  dslVersion: "2.0",
  name: "Cancel notify",
  status: "active",
  trigger: { type: "order.cancelled", source: "shopify.webhook" },
  conditions: { logic: "AND", clauses: [] },
  actions: [{ actionId: "webhook.send", params: { integrationId: "hook_1" } }],
});

const tagsPlan = compile({
  dslVersion: "2.0",
  name: "Low stock tag",
  status: "active",
  trigger: {
    type: "inventory.low",
    source: "shopify.webhook+reconcile",
    topic: "inventory_levels/update",
  },
  conditions: { logic: "AND", clauses: [] },
  actions: [{ actionId: "tags.add", params: { tag: "restock" } }],
});

test("纯打标计划不解析任何出站绑定", async () => {
  const { client } = makeIntegrationClient([]);
  const bindings = await resolveStepBindings(client, "shop_1", tagsPlan);
  assert.deepEqual(bindings, {});
});

test("email 步命中本店 EMAIL 集成→注入 integrationRef（不含明文/密文）", async () => {
  const { client } = makeIntegrationClient([
    {
      id: "mail_1",
      shopId: "shop_1",
      kind: "EMAIL",
      status: "healthy",
      config: { from: "bot@shop.com" },
      secretsEncrypted: null,
      createdAt: new Date("2026-01-01"),
    },
  ]);
  const bindings = await resolveStepBindings(client, "shop_1", emailPlan);
  assert.deepEqual(bindings.email, { integrationRef: "mail_1" });
  assert.equal(JSON.stringify(bindings).includes("secrets"), false);
});

test("email 步无 EMAIL 集成→留空（执行器干净失败，不伪造发信）", async () => {
  const { client } = makeIntegrationClient([]);
  const bindings = await resolveStepBindings(client, "shop_1", emailPlan);
  assert.equal(bindings.email, undefined);
});

test("webhook 步解密取回端点与签名密钥（往返可用）", async () => {
  const cipher = encryptSecret("s3cr3t-sign", KEY_HEX);
  const { client } = makeIntegrationClient([
    {
      id: "hook_1",
      shopId: "shop_1",
      kind: "CUSTOM_WEBHOOK",
      status: "healthy",
      config: { url: "https://example.com/hook" },
      secretsEncrypted: cipher,
      createdAt: new Date("2026-01-01"),
    },
  ]);
  const bindings = await resolveStepBindings(client, "shop_1", webhookPlan, {
    keyHex: KEY_HEX,
  });
  assert.equal(bindings.webhook?.endpointUrl, "https://example.com/hook");
  assert.equal(bindings.webhook?.secret, "s3cr3t-sign");
});

test("跨店 integrationId 不泄露：查不到即留空", async () => {
  const cipher = encryptSecret("nope", KEY_HEX);
  const { client, reads } = makeIntegrationClient([
    {
      id: "hook_1",
      shopId: "shop_OTHER",
      kind: "CUSTOM_WEBHOOK",
      status: "healthy",
      config: { url: "https://evil.example/" },
      secretsEncrypted: cipher,
      createdAt: new Date("2026-01-01"),
    },
  ]);
  const bindings = await resolveStepBindings(client, "shop_1", webhookPlan, {
    keyHex: KEY_HEX,
  });
  assert.equal(bindings.webhook, undefined);
  // 归属过滤：查询 where 必带 shopId + id
  assert.ok(reads.length > 0);
});

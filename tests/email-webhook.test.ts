import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeEmailSend,
  sendEmail,
  type EmailProvider,
} from "../app/automation/actions/email.server.ts";
import {
  executeWebhookSend,
  postToUrl,
  type WebhookContext,
} from "../app/automation/actions/outbound-webhook.server.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";
import type { CompiledActionStep } from "../app/lib/automation-compiler.ts";

function makeStep(params: Record<string, unknown>, actionId = "email.send"): CompiledActionStep {
  return {
    actionId,
    target: null,
    params,
    riskLevel: "low",
    confirmation: "auto",
  };
}

function makeEvent(fields: Record<string, unknown> = {}): StandardEvent {
  return {
    shopDomain: "store.myshopify.com",
    topic: "inventory_levels/update",
    entityType: "ProductVariant",
    entityId: "gid://shopify/ProductVariant/9",
    occurredAt: new Date("2026-11-05T00:00:00.000Z"),
    data: fields,
  };
}

// ---------- email ----------

test("email 未接线：明确「未配置」错误，绝不静默成功", async () => {
  const result = await executeEmailSend(
    makeStep({ template: "low_stock" }),
    makeEvent(),
    { integrationRef: "int_1", sentStepIds: new Set(), stepId: "step_1" },
  );
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /not configured/);
});

test("email sendEmail 核心接口：无 provider 直接抛可读错误", async () => {
  await assert.rejects(
    sendEmail(
      { integrationRef: "i", to: null, template: "t", vars: {}, dedupeKey: "k" },
      undefined,
    ),
    /not configured/,
  );
});

test("email stub provider：真实发信一次，携带 ExecutionStep.id 去重键与补齐 vars", async () => {
  const seen: { dedupeKey: string; vars: Record<string, unknown>; to: string | null }[] = [];
  const provider: EmailProvider = async (args) => {
    seen.push({ dedupeKey: args.dedupeKey, vars: args.vars, to: args.to });
  };
  const sentStepIds = new Set<string>();
  const result = await executeEmailSend(
    makeStep({ template: "low_stock", to: "ops@store.com", vars: ["sku", "available"] }),
    makeEvent({ sku: "ABC", available: 2 }),
    { integrationRef: "int_1", provider, sentStepIds, stepId: "step_7" },
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.sent, true);
  assert.deepEqual(seen, [
    { dedupeKey: "step_7", vars: { sku: "ABC", available: 2 }, to: "ops@store.com" },
  ]);
  assert.equal(sentStepIds.has("step_7"), true);
});

test("email：同 ExecutionStep.id 重放→幂等，provider 不再被调用", async () => {
  let calls = 0;
  const provider: EmailProvider = async () => {
    calls += 1;
  };
  const sentStepIds = new Set(["step_7"]); // 已发过
  const result = await executeEmailSend(
    makeStep({ template: "low_stock", vars: ["sku"] }),
    makeEvent({ sku: "ABC" }),
    { integrationRef: "int_1", provider, sentStepIds, stepId: "step_7" },
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.idempotent, true);
  assert.equal(calls, 0);
});

test("email provider 抛错→折成 FAILED errorText，不 crash", async () => {
  const provider: EmailProvider = async () => {
    throw new Error("SMTP relay rejected sender");
  };
  const result = await executeEmailSend(
    makeStep({ template: "low_stock" }),
    makeEvent(),
    { integrationRef: "int_1", provider, sentStepIds: new Set(), stepId: "step_9" },
  );
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /SMTP relay rejected sender/);
});

// ---------- outbound webhook ----------

type FetchCall = { url: string; init?: { headers?: Record<string, string>; method?: string } };

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

test("webhook SSRF：非 https 直接拦，fetch 不被调用", async () => {
  let fetched = false;
  await assert.rejects(
    postToUrl("http://example.com/hook", {}, "k1", {
      fetchImpl: (async () => {
        fetched = true;
        return okResponse();
      }) as typeof fetch,
    }),
    /Only HTTPS/,
  );
  assert.equal(fetched, false);
});

test("webhook SSRF：字面内网 IP / 元数据服务地址即时拦", async () => {
  for (const url of [
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/x",
    "https://[fd00::1]/x",
  ]) {
    await assert.rejects(
      postToUrl(url, {}, "k", { resolveAddresses: async () => ["8.8.8.8"], fetchImpl: (async () => okResponse()) as typeof fetch }),
      /SSRF guard/,
      `${url} 应被拦`,
    );
  }
});

test("webhook SSRF：域名解析到内网 IP（DNS Rebinding 面）→解析后拦", async () => {
  await assert.rejects(
    postToUrl("https://evil.example.com/hook", {}, "k", {
      resolveAddresses: async () => ["8.8.8.8", "127.0.0.1"], // 多 A 记录藏一个内网
      fetchImpl: (async () => okResponse()) as typeof fetch,
    }),
    /private or reserved/,
  );
});

test("webhook SSRF：解析结果为空→拒（无目的地不发）", async () => {
  await assert.rejects(
    postToUrl("https://nosuch.example.com/hook", {}, "k", {
      resolveAddresses: async () => [],
      fetchImpl: (async () => okResponse()) as typeof fetch,
    }),
    /did not resolve/,
  );
});

test("webhook 正常投递：带 idempotency-key header 的 https POST", async () => {
  const calls: FetchCall[] = [];
  await postToUrl("https://hooks.example.com/recv", { a: 1 }, "step_42", {
    resolveAddresses: async () => ["93.184.216.34"],
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        init: {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
        },
      });
      return okResponse();
    }) as typeof fetch,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.headers?.["idempotency-key"], "step_42");
});

test("webhook 端点返回非 2xx→postToUrl 抛错", async () => {
  await assert.rejects(
    postToUrl("https://hooks.example.com/recv", {}, "k", {
      resolveAddresses: async () => ["93.184.216.34"],
      fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    }),
    /HTTP 500/,
  );
});

function webhookCtx(over: Partial<WebhookContext> = {}): WebhookContext {
  return {
    endpointUrl: "https://hooks.example.com/recv",
    idempotencyKey: "step_5",
    resolveAddresses: async () => ["93.184.216.34"],
    fetchImpl: (async () => okResponse()) as typeof fetch,
    ...over,
  };
}

test("executeWebhookSend：缺 integrationId→错误且不触碰网络", async () => {
  let fetched = false;
  const result = await executeWebhookSend(
    makeStep({}, "webhook.send"),
    makeEvent(),
    webhookCtx({
      fetchImpl: (async () => {
        fetched = true;
        return okResponse();
      }) as typeof fetch,
    }),
  );
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /no integrationId/);
  assert.equal(fetched, false);
});

test("executeWebhookSend：端点未配置→明确失败非静默", async () => {
  const result = await executeWebhookSend(
    makeStep({ integrationId: "int_2" }, "webhook.send"),
    makeEvent(),
    webhookCtx({ endpointUrl: "" }),
  );
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /not configured/);
});

test("executeWebhookSend：正常投递→delivered，负载不含原始 PII body", async () => {
  let body = "";
  const result = await executeWebhookSend(
    makeStep({ integrationId: "int_2" }, "webhook.send"),
    makeEvent({ email: "customer@secret.com", total_price: "500.00" }),
    webhookCtx({
      fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => {
        body = String(init?.body);
        return okResponse();
      }) as typeof fetch,
    }),
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.delivered, true);
  assert.doesNotMatch(body, /customer@secret\.com/, "绝不转储事件里的原始 PII 字段");
  assert.doesNotMatch(body, /500\.00/);
  assert.match(body, /ProductVariant/);
});

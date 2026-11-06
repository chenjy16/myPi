import assert from "node:assert/strict";
import { test } from "node:test";
import { executeStep } from "../app/automation/action-executor.server.ts";
import { adminGraphqlWrite } from "../app/lib/admin-graphql.server.ts";
import type { StepDeps } from "../app/automation/action-executor.server.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";
import type { CompiledActionStep } from "../app/lib/automation-compiler.ts";

// 假 admin：记录每次 graphql 调用；对 tags 读查询回空数组（→ 触发写），对写 mutation 回干净结果。
function makeAdmin() {
  const calls: { operation: string; variables?: Record<string, unknown> }[] = [];
  const rawAdmin = {
    graphql: async (
      operation: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ operation, variables: options?.variables });
      const body = operation.includes("mypiTargetTags")
        ? { data: { node: { tags: [] } } }
        : {
            data: {
              tagsAdd: { node: { id: "gid://shopify/Order/1" }, userErrors: [] },
              productUpdate: {
                product: { id: "gid://shopify/Product/5" },
                userErrors: [],
              },
            },
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return {
    admin: rawAdmin as unknown as Parameters<typeof adminGraphqlWrite>[0],
    calls,
  };
}

function step(overrides: Partial<CompiledActionStep>): CompiledActionStep {
  return {
    actionId: "tags.add",
    target: null,
    params: { tag: "vip" },
    riskLevel: "low",
    confirmation: "auto",
    ...overrides,
  };
}

const orderEvent = (): StandardEvent => ({
  shopDomain: "store.myshopify.com",
  topic: "orders/create",
  entityType: "Order",
  entityId: "gid://shopify/Order/1",
  occurredAt: new Date("2026-11-05T00:00:00.000Z"),
  data: {},
});

const productEvent = (): StandardEvent => ({
  shopDomain: "store.myshopify.com",
  topic: "products/update",
  entityType: "Product",
  entityId: "gid://shopify/Product/5",
  occurredAt: new Date("2026-11-05T00:00:00.000Z"),
  data: {},
});

test("low/auto 步骤：直接执行（tags.add 走读+写），落 SUCCESS", async () => {
  const { admin, calls } = makeAdmin();
  const deps: StepDeps = { stepId: "step_1", admin };
  const out = await executeStep(
    step({ params: { tag: "vip" } }),
    orderEvent(),
    deps,
  );
  assert.equal(out.status, "SUCCESS");
  assert.ok(calls.length >= 2, "先读现有 tags 再写 tagsAdd");
  assert.match(calls[calls.length - 1].operation, /tagsAdd/);
});

test("确认门（核心验收 E2E-H）：high/required 未确认→AWAITING_CONFIRMATION，零 Mutation", async () => {
  const { admin, calls } = makeAdmin();
  const deps: StepDeps = { stepId: "step_2", admin };
  const out = await executeStep(
    step({
      actionId: "product.updateStatus",
      params: { status: "ARCHIVED" },
      riskLevel: "high",
      confirmation: "required",
    }),
    productEvent(),
    deps,
  );
  assert.equal(out.status, "AWAITING_CONFIRMATION");
  assert.equal(calls.length, 0, "确认前绝不触碰 admin（零 Mutation）");
});

test("确认后端点复驱（P2-16 语义）：confirmed=true→绕过挂起门执行 product.updateStatus", async () => {
  const { admin, calls } = makeAdmin();
  const deps: StepDeps = { stepId: "step_3", admin };
  const out = await executeStep(
    step({
      actionId: "product.updateStatus",
      params: { status: "ARCHIVED" },
      riskLevel: "high",
      confirmation: "required",
    }),
    productEvent(),
    deps,
    { confirmed: true },
  );
  assert.equal(out.status, "SUCCESS");
  assert.equal(calls.length, 1, "改状态只发一次 productUpdate，无前置读");
  assert.match(calls[0].operation, /productUpdate/);
  assert.deepEqual(calls[0].variables, {
    id: "gid://shopify/Product/5",
    status: "ARCHIVED",
  });
});

test("email.send：provider 未接线→FAILED「未配置」，非静默（走分派表非挂起门）", async () => {
  const { admin, calls } = makeAdmin();
  const out = await executeStep(
    step({ actionId: "email.send", params: { template: "low_stock" } }),
    productEvent(),
    { stepId: "step_4", admin },
  );
  assert.equal(out.status, "FAILED");
  assert.match(out.errorText ?? "", /not configured/);
  assert.equal(calls.length, 0, "email 不经 Shopify admin");
});

test("webhook.send：端点未配置→FAILED「未配置」", async () => {
  const { admin } = makeAdmin();
  const out = await executeStep(
    step({ actionId: "webhook.send", params: { integrationId: "int_1" } }),
    productEvent(),
    { stepId: "step_5", admin },
  );
  assert.equal(out.status, "FAILED");
  assert.match(out.errorText ?? "", /not configured/);
});

test("未知/不可达动作：兜底 FAILED（编译期已拦，运行期不静默放行）", async () => {
  const { admin, calls } = makeAdmin();
  const out = await executeStep(
    step({ actionId: "order.delete", params: {} }),
    orderEvent(),
    { stepId: "step_6", admin },
  );
  assert.equal(out.status, "FAILED");
  assert.match(out.errorText ?? "", /not executable/);
  assert.equal(calls.length, 0);
});

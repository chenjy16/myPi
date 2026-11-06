import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeTagsAdd,
  executeTagsRemove,
  type ExecutorContext,
} from "../app/automation/actions/tags.server.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";
import type { CompiledActionStep } from "../app/lib/automation-compiler.ts";

// 假 admin：按 operation 内容区分「读现有 tags 的 query」与「写 mutation」，
// 如实返回 Response（adminGraphql 会解析 .data）。记录每次调用以便断言幂等/no-op 时零 Mutation。
type Call = { operation: string; variables?: Record<string, unknown> };

function makeAdmin(opts: {
  existingTags?: string[] | null; // null = node 不存在
  mutateResponse?: unknown; // 覆盖写 mutation 返回体（模拟 userErrors / scope 报错）
}) {
  const calls: Call[] = [];
  const rawAdmin = {
    graphql: async (
      operation: string,
      options?: { variables?: Record<string, unknown> },
    ): Promise<Response> => {
      calls.push({ operation, variables: options?.variables });
      let body: unknown;
      if (operation.includes("mypiTargetTags")) {
        const node =
          opts.existingTags === null ? null : { tags: opts.existingTags ?? [] };
        body = { data: { node } };
      } else {
        body =
          opts.mutateResponse ?? {
            data: {
              tagsAdd: { node: { id: "gid://shopify/Order/1" }, userErrors: [] },
              tagsRemove: {
                node: { id: "gid://shopify/Order/1" },
                userErrors: [],
              },
            },
          };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return {
    ctx: { admin: rawAdmin as unknown as ExecutorContext["admin"] } satisfies ExecutorContext,
    calls,
  };
}

function makeStep(overrides: Partial<CompiledActionStep> = {}): CompiledActionStep {
  return {
    actionId: "tags.add",
    target: null,
    params: { tag: "vip" },
    riskLevel: "low",
    confirmation: "auto",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<StandardEvent> = {}): StandardEvent {
  return {
    shopDomain: "store.myshopify.com",
    topic: "orders/create",
    entityType: "Order",
    entityId: "gid://shopify/Order/1",
    occurredAt: new Date("2026-11-05T00:00:00.000Z"),
    data: {},
    ...overrides,
  };
}

test("tags.add：目标缺该 tag 时才写 Mutation（幂等前置读）", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: ["new"] });
  const result = await executeTagsAdd(makeStep({ params: { tag: "vip" } }), makeEvent(), ctx);
  assert.equal(result.success, true);
  assert.deepEqual(result.data?.added, "vip");
  assert.equal(calls.length, 2, "先读后写共 2 次");
  assert.match(calls[1].operation, /tagsAdd/);
  assert.deepEqual(calls[1].variables, { id: "gid://shopify/Order/1", tags: ["vip"] });
});

test("tags.add：tag 已存在→幂等，零 Mutation", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: ["vip", "other"] });
  const result = await executeTagsAdd(makeStep({ params: { tag: "vip" } }), makeEvent(), ctx);
  assert.equal(result.success, true);
  assert.equal(result.data?.idempotent, true);
  assert.equal(calls.length, 1, "只读一次，绝不写");
  assert.match(calls[0].operation, /mypiTargetTags/);
});

test("tags.add：目标 node 不存在→可读错误，零 Mutation", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: null });
  const result = await executeTagsAdd(makeStep(), makeEvent(), ctx);
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /not found/);
  assert.equal(calls.length, 1);
});

test("tags.remove：tag 不存在→no-op 成功，零 Mutation", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: ["other"] });
  const result = await executeTagsRemove(
    makeStep({ actionId: "tags.remove", params: { tag: "vip" } }),
    makeEvent(),
    ctx,
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.idempotent, true);
  assert.equal(calls.length, 1);
});

test("tags.remove：tag 存在→写 tagsRemove Mutation", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: ["vip"] });
  const result = await executeTagsRemove(
    makeStep({ actionId: "tags.remove", params: { tag: "vip" } }),
    makeEvent(),
    ctx,
  );
  assert.equal(result.success, true);
  assert.equal(result.data?.removed, "vip");
  assert.equal(calls.length, 2);
  assert.match(calls[1].operation, /tagsRemove/);
});

test("resolveTarget：显式 step.target 覆盖事件 entityType（order→Order）", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: [] });
  await executeTagsAdd(
    makeStep({ target: "customer", params: { tag: "vip" } }),
    makeEvent({ entityType: "Order", entityId: "42" }),
    ctx,
  );
  // 读用 customer GID（数字 id→补全 gid），显式 target 优先
  assert.deepEqual(calls[0].variables, { id: "gid://shopify/Customer/42" });
});

test("target 越界（无实体类型）→可读错误，完全不触碰 admin", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: [] });
  const result = await executeTagsAdd(
    makeStep({ target: "warehouse" }),
    makeEvent(),
    ctx,
  );
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /cannot resolve a taggable target/);
  assert.equal(calls.length, 0);
});

test("缺 tag 名→可读错误，完全不触碰 admin", async () => {
  const { ctx, calls } = makeAdmin({ existingTags: [] });
  const result = await executeTagsAdd(makeStep({ params: {} }), makeEvent(), ctx);
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /no tag name/);
  assert.equal(calls.length, 0);
});

test("越权 scope：adminGraphql 抛 auth AppError→折成可读 errorText，不 crash", async () => {
  const { ctx } = makeAdmin({
    existingTags: [],
    mutateResponse: {
      errors: [{ message: "mypi does not have the required write_products scope" }],
    },
  });
  const result = await executeTagsAdd(makeStep(), makeEvent(), ctx);
  assert.equal(result.success, false);
  assert.ok(result.errorText && result.errorText.length > 0);
  // 安全摘要：绝不泄漏堆栈/原始对象
  assert.doesNotMatch(result.errorText ?? "", /at .*\.server\.ts/);
});

test("userErrors：写封装折成 validation→执行器捕获为可读错误，不抛", async () => {
  const { ctx } = makeAdmin({
    existingTags: [],
    mutateResponse: {
      data: { tagsAdd: { userErrors: [{ field: ["id"], message: "Resource not found" }] } },
    },
  });
  const result = await executeTagsAdd(makeStep(), makeEvent(), ctx);
  assert.equal(result.success, false);
  assert.match(result.errorText ?? "", /Resource not found/);
});

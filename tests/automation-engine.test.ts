import assert from "node:assert/strict";
import { test } from "node:test";
import { runAutomation } from "../app/lib/automation-engine.ts";
import { compile } from "../app/lib/automation-compiler.ts";
import { adminGraphqlWrite } from "../app/lib/admin-graphql.server.ts";
import type { ExecutionClient } from "../app/lib/execution-log.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

// ---- 假 Prisma 客户端：如实实现 executionLog/executionStep 的 create/update/findMany + dedupeKey 唯一索引 ----
type Row = Record<string, unknown>;
function makeEngineClient() {
  const logs = new Map<string, Row>();
  const steps = new Map<string, Row>();
  const dedupe = new Set<string>();
  let seq = 0;
  const id = (p: string) => `${p}_${(seq += 1)}`;

  const client = {
    executionLog: {
      create: async (args: { data: Row }) => {
        const key = args.data.dedupeKey as string | null;
        if (key) {
          if (dedupe.has(key)) throw { code: "P2002" }; // 撞 @unique：模拟 Prisma 唯一约束错误
          dedupe.add(key);
        }
        const newId = id("exec");
        logs.set(newId, { id: newId, ...args.data });
        return { id: newId };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const row = logs.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return { id: args.where.id };
      },
    },
    executionStep: {
      create: async (args: { data: Row }) => {
        const newId = id("step");
        steps.set(newId, { id: newId, ...args.data });
        return { id: newId };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const row = steps.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return { id: args.where.id };
      },
      findMany: async (args: { where: { executionId: string } }) =>
        [...steps.values()]
          .filter((s) => s.executionId === args.where.executionId)
          .sort((a, b) => (a.order as number) - (b.order as number)),
    },
  } as unknown as ExecutionClient;

  return { client, logs, steps };
}

// ---- 假 admin：tags 读查询回空数组（→触发写），写 mutation 回干净结果 ----
function makeAdmin() {
  const calls: string[] = [];
  const rawAdmin = {
    graphql: async (operation: string): Promise<Response> => {
      calls.push(operation);
      const body = operation.includes("mypiTargetTags")
        ? { data: { node: { tags: [] } } }
        : {
            data: {
              tagsAdd: { node: { id: "gid://shopify/Product/5" }, userErrors: [] },
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

const NOW = new Date("2026-11-05T10:00:00.000Z");

function inventoryEvent(data: Record<string, unknown>): StandardEvent {
  return {
    shopDomain: "store.myshopify.com",
    topic: "inventory_levels/update",
    entityType: "Product",
    entityId: "gid://shopify/Product/5",
    occurredAt: NOW,
    data,
  };
}

const planA = compile({
  dslVersion: "2.0",
  name: "Restock tag",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
  conditions: { logic: "AND", clauses: [{ field: "available", op: "less_than_or_equal", value: 5, type: "number" }] },
  actions: [{ actionId: "tags.add", params: { tag: "restock" } }],
});

const planSkip = compile({
  dslVersion: "2.0",
  name: "Critical stock tag",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
  conditions: { logic: "AND", clauses: [{ field: "available", op: "less_than_or_equal", value: 0, type: "number" }] },
  actions: [{ actionId: "tags.add", params: { tag: "critical" } }],
});

const planPartial = compile({
  dslVersion: "2.0",
  name: "Restock then archive",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
  conditions: { logic: "AND", clauses: [{ field: "available", op: "less_than_or_equal", value: 5, type: "number" }] },
  actions: [
    { actionId: "tags.add", params: { tag: "restock" } },
    { actionId: "product.updateStatus", params: { status: "ARCHIVED" } },
  ],
});

test("路径 A 全成功：RUNNING 建日志→tags.add 成功→finalize SUCCESS", async () => {
  const { client, logs, steps } = makeEngineClient();
  const { admin } = makeAdmin();
  const outcome = await runAutomation(
    { client, admin, now: NOW },
    { shopId: "shop_1", event: inventoryEvent({ available: 2 }), match: { automationId: "auto_1", version: 3, plan: planA } },
  );
  assert.equal(outcome.status, "completed");
  const log = [...logs.values()][0];
  assert.equal(log.status, "SUCCESS");
  assert.equal(log.automationVersion, 3);
  assert.equal(steps.size, 1);
  const [step] = [...steps.values()];
  assert.equal(step.status, "SUCCESS");
  assert.equal(step.actionId, "tags.add");
});

test("路径 B 条件不满足：只落 SKIPPED + 明细，绝不排步骤（零 Mutation）", async () => {
  const { client, logs, steps } = makeEngineClient();
  const { admin, calls } = makeAdmin();
  const outcome = await runAutomation(
    { client, admin, now: NOW },
    { shopId: "shop_1", event: inventoryEvent({ available: 5 }), match: { automationId: "auto_skip", version: 1, plan: planSkip } },
  );
  assert.equal(outcome.status, "conditions-skipped");
  assert.equal(steps.size, 0, "条件不满足不排任何步骤");
  assert.equal(calls.length, 0, "完全不触碰 admin");
  const log = [...logs.values()][0];
  assert.equal(log.status, "SKIPPED");
  assert.ok(log.conditionResult, "逐条明细入档");
});

test("路径 C 部分成功：tags.add 成功 + 高风险改状态挂起→PARTIAL_SUCCESS", async () => {
  const { client, logs, steps } = makeEngineClient();
  const { admin } = makeAdmin();
  const outcome = await runAutomation(
    { client, admin, now: NOW },
    { shopId: "shop_1", event: inventoryEvent({ available: 2 }), match: { automationId: "auto_c", version: 1, plan: planPartial } },
  );
  assert.equal(outcome.status, "completed");
  const log = [...logs.values()][0];
  assert.equal(log.status, "PARTIAL_SUCCESS");
  const ordered = [...steps.values()].sort((a, b) => (a.order as number) - (b.order as number));
  assert.equal(ordered[0].status, "SUCCESS"); // tags.add
  assert.equal(ordered[1].status, "AWAITING_CONFIRMATION"); // product.updateStatus 高风险挂起
});

test("可靠去重：同事件指纹重复执行第二次撞唯一索引→duplicate-skipped，不重复落账", async () => {
  const { client, logs } = makeEngineClient();
  const { admin } = makeAdmin();
  const deps = { client, admin, now: NOW };
  const input = {
    shopId: "shop_1",
    event: inventoryEvent({ available: 2 }),
    match: { automationId: "auto_1", version: 3, plan: planA },
  };
  const first = await runAutomation(deps, input);
  const second = await runAutomation(deps, input);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "duplicate-skipped");
  assert.equal([...logs.values()].filter((l) => l.status !== "SKIPPED").length, 1, "RUNNING 日志只落一条");
});

test("防循环 block 前置：注入 loopGuard 判 block→记 SKIPPED(loopBlocked)，零步骤零 Mutation", async () => {
  const { client, logs, steps } = makeEngineClient();
  const { admin, calls } = makeAdmin();
  const outcome = await runAutomation(
    {
      client,
      admin,
      now: NOW,
      loopGuard: () => ({ decision: "block", reason: "cascade depth 5 exceeds max 3" }),
    },
    { shopId: "shop_1", event: inventoryEvent({ available: 2 }), match: { automationId: "auto_loop", version: 1, plan: planA } },
  );
  assert.equal(outcome.status, "loop-blocked");
  assert.equal(steps.size, 0);
  assert.equal(calls.length, 0);
  const cond = [...logs.values()][0].conditionResult as Record<string, unknown>;
  assert.match(String(cond.loopBlocked), /cascade depth/);
});

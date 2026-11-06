import assert from "node:assert/strict";
import { test } from "node:test";
import {
  retryExecution,
  confirmStep,
  correctUnknownStep,
} from "../app/lib/automation-retry.ts";
import { compile } from "../app/lib/automation-compiler.ts";
import { adminGraphqlWrite } from "../app/lib/admin-graphql.server.ts";
import type { RetryClient } from "../app/lib/automation-retry.ts";

const NOW = new Date("2026-11-05T10:00:00.000Z");

// ---- 假 admin：可按场景返回 node.tags；分别记录「读」与「写(Mutation)」调用，供零重发断言 ----
function makeAdmin(existingTags: string[]) {
  const calls: string[] = [];
  const mutations: string[] = [];
  const rawAdmin = {
    graphql: async (operation: string): Promise<Response> => {
      calls.push(operation);
      if (operation.includes("mypiTargetTags")) {
        return json({ data: { node: { tags: existingTags } } });
      }
      mutations.push(operation);
      return json({
        data: {
          tagsAdd: { node: { id: "gid://shopify/Product/5" }, userErrors: [] },
          tagsRemove: { node: { id: "gid://shopify/Product/5" }, userErrors: [] },
          productUpdate: { product: { id: "gid://shopify/Product/5" }, userErrors: [] },
        },
      });
    },
  };
  return {
    admin: rawAdmin as unknown as Parameters<typeof adminGraphqlWrite>[0],
    calls,
    mutations,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---- 假 RetryClient：如实复现 executionLog/executionStep/automationVersion 的 findUnique/findMany/create/update ----
type Row = Record<string, unknown>;
function makeRetryClient(seed: {
  logs: Row[];
  steps: Row[];
  plan: ReturnType<typeof compile>;
}) {
  const logs = new Map(seed.logs.map((l) => [l.id as string, { ...l }]));
  const steps = new Map(seed.steps.map((s) => [s.id as string, { ...s }]));
  let seq = 1000;
  const id = (p: string) => `${p}_${(seq += 1)}`;
  const client = {
    executionLog: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        logs.get(where.id) ?? null,
      create: async (args: { data: Row }) => {
        const nid = id("exec");
        logs.set(nid, { id: nid, ...args.data });
        return { id: nid };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const row = logs.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    executionStep: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        steps.get(where.id) ?? null,
      findMany: async (args: { where: { executionId: string } }) =>
        [...steps.values()]
          .filter((s) => s.executionId === args.where.executionId)
          .sort((a, b) => (a.order as number) - (b.order as number)),
      create: async (args: { data: Row }) => {
        const nid = id("step");
        steps.set(nid, { id: nid, ...args.data });
        return { id: nid };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const row = steps.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    automationVersion: {
      findUnique: async () => ({ definition: seed.plan }),
    },
  } as unknown as RetryClient;
  return { client, logs, steps };
}

const payload = {
  shopDomain: "store.myshopify.com",
  topic: "inventory_levels/update",
  entityType: "Product",
  entityId: "gid://shopify/Product/5",
  occurredAt: NOW.toISOString(),
  data: { available: 2 },
};

function origLog(extra: Row = {}): Row {
  return {
    id: "exec_orig",
    shopId: "shop_1",
    automationId: "auto_1",
    automationVersion: 1,
    triggerType: "inventory.low",
    entityRef: "gid://shopify/Product/5",
    cascadeDepth: 0,
    status: "PARTIAL_SUCCESS",
    payload,
    ...extra,
  };
}

// 两步打标（均 low/auto）：用于全量 vs 仅失败步重试对照
const planTwoTags = compile({
  dslVersion: "2.0",
  name: "Two tags",
  status: "active",
  trigger: {
    type: "inventory.low",
    source: "shopify.webhook+reconcile",
    topic: "inventory_levels/update",
  },
  conditions: { logic: "AND", clauses: [] },
  actions: [
    { actionId: "tags.add", params: { tag: "restock" } },
    { actionId: "tags.add", params: { tag: "vip" } },
  ],
});

// 打标 + 高风险改状态：用于 AWAITING 保持挂起 / 确认复驱
const planTagThenArchive = compile({
  dslVersion: "2.0",
  name: "Tag then archive",
  status: "active",
  trigger: {
    type: "inventory.low",
    source: "shopify.webhook+reconcile",
    topic: "inventory_levels/update",
  },
  conditions: { logic: "AND", clauses: [] },
  actions: [
    { actionId: "tags.add", params: { tag: "restock" } },
    { actionId: "product.updateStatus", params: { status: "ARCHIVED" } },
  ],
});

test("重试·仅失败步：SUCCESS 复制不重发（零 Mutation），FAILED 重跑，新建子记录原记录不动", async () => {
  const { client, logs, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { added: "restock" } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "tags.add", status: "FAILED", result: null },
    ],
    plan: planTwoTags,
  });
  const { admin, mutations } = makeAdmin([]); // 读回空→重跑步触发一次写

  const outcome = await retryExecution({ client, admin }, {
    shopId: "shop_1",
    executionId: "exec_orig",
    failedOnly: true,
  });

  assert.equal(outcome.status, "retried");
  if (outcome.status !== "retried") return;
  assert.equal(outcome.executionStatus, "SUCCESS");

  // 原始记录不被改写
  assert.equal(logs.get("exec_orig")!.status, "PARTIAL_SUCCESS");
  // 子记录：parentExecutionId 指向原记录，dedupeKey=null（绕过唯一去重）
  const child = [...logs.values()].find((l) => l.id !== "exec_orig")!;
  assert.equal(child.parentExecutionId, "exec_orig");
  assert.equal(child.dedupeKey, null);

  // 仅重跑 1 步 → 恰好 1 次 tagsAdd Mutation（复制步零 Mutation，防重复打标）
  assert.equal(mutations.length, 1);
  const childSteps = [...steps.values()]
    .filter((s) => s.executionId === child.id)
    .sort((a, b) => (a.order as number) - (b.order as number));
  assert.equal(childSteps[0].status, "SUCCESS");
  assert.deepEqual(childSteps[0].result, { added: "restock" }); // 结果被复制
  assert.equal(childSteps[1].status, "SUCCESS");
});

test("重试·全量：failedOnly=false 两步都重跑→2 次 Mutation", async () => {
  const { client } = makeRetryClient({
    logs: [origLog()],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { added: "restock" } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "tags.add", status: "FAILED", result: null },
    ],
    plan: planTwoTags,
  });
  const { admin, mutations } = makeAdmin([]);
  const outcome = await retryExecution({ client, admin }, { shopId: "shop_1", executionId: "exec_orig" });
  assert.equal(outcome.status, "retried");
  assert.equal(mutations.length, 2, "全量重试两步都重发");
});

test("重试·待确认步保持挂起（重试不代替授权，零 Mutation）", async () => {
  const { client, logs, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { added: "restock" } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "product.updateStatus", status: "AWAITING_CONFIRMATION", result: null },
    ],
    plan: planTagThenArchive,
  });
  const { admin, mutations } = makeAdmin([]);
  const outcome = await retryExecution({ client, admin }, { shopId: "shop_1", executionId: "exec_orig", failedOnly: true });
  assert.equal(outcome.status, "retried");
  const child = [...logs.values()].find((l) => l.id !== "exec_orig")!;
  const childSteps = [...steps.values()].filter((s) => s.executionId === child.id);
  const awaiting = childSteps.find((s) => s.order === 1)!;
  assert.equal(awaiting.status, "AWAITING_CONFIRMATION", "挂起步原样保留，不代跑");
  assert.equal(mutations.length, 0, "复制 SUCCESS + 保持 AWAITING → 零写");
});

test("确认·confirmStep 把 AWAITING 高风险步复驱→SUCCESS（写操作者=merchant）", async () => {
  const { client, logs, steps } = makeRetryClient({
    logs: [origLog({ status: "PARTIAL_SUCCESS" })],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { added: "restock" } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "product.updateStatus", status: "AWAITING_CONFIRMATION", result: null },
    ],
    plan: planTagThenArchive,
  });
  const { admin, calls } = makeAdmin([]);
  const outcome = await confirmStep({ client, admin, requestSource: "automation" }, { shopId: "shop_1", stepId: "step_1" });

  assert.equal(outcome.status, "confirmed");
  if (outcome.status !== "confirmed") return;
  assert.equal(outcome.stepStatus, "SUCCESS");
  assert.equal(outcome.executionStatus, "SUCCESS");
  assert.equal(steps.get("step_1")!.status, "SUCCESS");
  assert.equal(logs.get("exec_orig")!.status, "SUCCESS");
  // 来源注释记录确认动作与操作者（sanitise 后冒号→下划线，仍含 confirm 段）
  assert.ok(calls.some((op) => op.includes("confirm")), "来源注释含 confirm");
});

test("确认·非挂起步不动（幂等守卫）", async () => {
  const { client } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: {} }],
    plan: planTwoTags,
  });
  const { admin, calls } = makeAdmin([]);
  const outcome = await confirmStep({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(outcome.status, "not_awaiting");
  assert.equal(calls.length, 0, "已终态步骤绝不复驱");
});

test("UNKNOWN·tags 回读确证已生效→SUCCESS（只读，零 Mutation）", async () => {
  const { client, logs, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "UNKNOWN", result: null }],
    plan: planTwoTags,
  });
  const { admin, calls, mutations } = makeAdmin(["restock"]); // 现状已含目标 tag
  const outcome = await correctUnknownStep({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(outcome.status, "applied");
  if (outcome.status !== "applied") return;
  assert.equal(steps.get("step_0")!.status, "SUCCESS");
  assert.equal((steps.get("step_0")!.result as Row).correctedBy, "readback");
  assert.ok(calls.some((op) => op.includes("mypiTargetTags")), "发起回读");
  assert.equal(mutations.length, 0, "校正只读，绝不重发");
  assert.equal(logs.get("exec_orig")!.status, "SUCCESS");
});

test("UNKNOWN·tags 回读显示未生效→保持 UNKNOWN，不自动重发（防重复打标）", async () => {
  const { client, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "UNKNOWN", result: null }],
    plan: planTwoTags,
  });
  const { admin, mutations } = makeAdmin([]); // 现状不含目标 tag
  const outcome = await correctUnknownStep({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(outcome.status, "indeterminate");
  assert.equal(steps.get("step_0")!.status, "UNKNOWN", "判定不了交人工，状态不动");
  assert.equal(mutations.length, 0, "未生效也不即刻重发（超时可能在途）");
});

test("UNKNOWN·出站动作不可回读→保持 UNKNOWN 且不触碰 admin（绝不重发邮件/webhook）", async () => {
  const planEmail = compile({
    dslVersion: "2.0",
    name: "Email",
    status: "active",
    trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
    conditions: { logic: "AND", clauses: [] },
    actions: [{ actionId: "email.send", params: { template: "low-stock", to: "buyer@example.com" } }],
  });
  const { client, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "email.send", status: "UNKNOWN", result: null }],
    plan: planEmail,
  });
  const { admin, calls } = makeAdmin(["anything"]);
  const outcome = await correctUnknownStep({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(outcome.status, "indeterminate");
  assert.equal(steps.get("step_0")!.status, "UNKNOWN");
  assert.equal(calls.length, 0, "email 无法回读，直接判待人工，零网络");
});

test("UNKNOWN·非 UNKNOWN 步骤直接短路", async () => {
  const { client } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: {} }],
    plan: planTwoTags,
  });
  const { admin, calls } = makeAdmin([]);
  const outcome = await correctUnknownStep({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(outcome.status, "not_unknown");
  assert.equal(calls.length, 0);
});

// —— P4-03/04 跨租户渗透：拿别店 id 发起重试/确认/校正，一律视同不存在且零网络副作用 ——

test("跨店·retryExecution 用他店 executionId → not_found，零 Mutation、不落子记录", async () => {
  const { client, logs } = makeRetryClient({
    logs: [origLog()], // shop_1 的执行
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "FAILED", result: null },
    ],
    plan: planTwoTags,
  });
  const { admin, mutations } = makeAdmin([]);
  const outcome = await retryExecution({ client, admin }, {
    shopId: "shop_other", // B 店会话拿着 A 店 id 来
    executionId: "exec_orig",
  });
  assert.equal(outcome.status, "not_found");
  assert.equal(mutations.length, 0);
  assert.equal(logs.size, 1, "未新建任何子执行");
});

test("跨店·confirmStep 用他店 stepId → not_found，不暴露挂起态也不复驱", async () => {
  const { client, steps } = makeRetryClient({
    logs: [origLog()],
    steps: [
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "product.updateStatus", status: "AWAITING_CONFIRMATION", result: null },
    ],
    plan: planTagThenArchive,
  });
  const { admin, mutations } = makeAdmin([]);
  const outcome = await confirmStep({ client, admin }, {
    shopId: "shop_other",
    stepId: "step_1",
  });
  assert.equal(outcome.status, "not_found");
  assert.equal(mutations.length, 0);
  assert.equal(steps.get("step_1")!.status, "AWAITING_CONFIRMATION", "挂起态原封不动");
});

test("跨店·correctUnknownStep 用他店 stepId → not_found，零回读请求", async () => {
  const { client } = makeRetryClient({
    logs: [origLog()],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "UNKNOWN", result: null }],
    plan: planTwoTags,
  });
  const { admin, calls, mutations } = makeAdmin(["restock"]);
  const outcome = await correctUnknownStep({ client, admin }, {
    shopId: "shop_other",
    stepId: "step_0",
  });
  assert.equal(outcome.status, "not_found");
  assert.equal(calls.length, 0, "连只读回读也不发起");
  assert.equal(mutations.length, 0);
});

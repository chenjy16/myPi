import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../app/lib/automation-compiler.ts";
import { adminGraphqlWrite } from "../app/lib/admin-graphql.server.ts";
import {
  confirmStepAction,
  retryExecutionAction,
  evaluateRetryEligibility,
  classifyStepFailure,
  type UiActionsClient,
} from "../app/automation-ui-actions.server.ts";

const NOW = new Date("2026-11-05T10:00:00.000Z");
type Row = Record<string, unknown>;

// 打标(低/自动) + 改状态(高/需确认)：确认复驱只驱动已挂起的那一步。
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

// 两步打标（均低/自动）：全量 vs 仅失败步重试对照。
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

function makeAdmin(existingTags: string[] = []) {
  const mutations: string[] = [];
  const rawAdmin = {
    graphql: async (operation: string): Promise<Response> => {
      if (operation.includes("mypiTargetTags")) {
        return json({ data: { node: { tags: existingTags } } });
      }
      mutations.push(operation);
      return json({
        data: {
          tagsAdd: { node: { id: "gid://shopify/Product/5" }, userErrors: [] },
          productUpdate: { product: { id: "gid://shopify/Product/5" }, userErrors: [] },
        },
      });
    },
  };
  return {
    admin: rawAdmin as unknown as Parameters<typeof adminGraphqlWrite>[0],
    mutations,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (row[k] !== v) return false;
  }
  return true;
}

function makeClient(seed: { logs: Row[]; steps: Row[]; plan: Row[] }) {
  const logs = new Map(seed.logs.map((l) => [l.id as string, { ...l }]));
  const steps = new Map(seed.steps.map((s) => [s.id as string, { ...s }]));
  let seq = 1000;
  const nid = (p: string) => `${p}_${(seq += 1)}`;

  const client = {
    executionLog: {
      findUnique: ({ where }: { where: { id: string } }) => logs.get(where.id) ?? null,
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        for (const row of logs.values()) if (matchWhere(row, where)) return row;
        return null;
      },
      findMany: (args: { where: Record<string, unknown> }) => {
        const rows = [...logs.values()].filter((r) => matchWhere(r, args.where));
        rows.sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
        return rows;
      },
      create: (args: { data: Row }) => {
        const id = nid("exec");
        logs.set(id, { id, createdAt: NOW, ...args.data });
        return { id };
      },
      update: (args: { where: { id: string }; data: Row }) => {
        const row = logs.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    executionStep: {
      findUnique: ({ where }: { where: { id: string } }) => steps.get(where.id) ?? null,
      findMany: (args: { where: Record<string, unknown> }) => {
        const rows = [...steps.values()].filter((r) => matchWhere(r, args.where));
        rows.sort((a, b) => (a.order as number) - (b.order as number));
        return rows;
      },
      create: (args: { data: Row }) => {
        const id = nid("step");
        steps.set(id, { id, ...args.data });
        return { id };
      },
      update: (args: { where: { id: string }; data: Row }) => {
        const row = steps.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    automationVersion: {
      findUnique: () => ({ definition: seed.plan[0] ?? planTwoTags }),
    },
    integration: {
      findFirst: () => null,
    },
  };
  return {
    client: client as unknown as UiActionsClient,
    logs,
    steps,
  };
}

function payloadFor(entityId: string): Row {
  return {
    shopDomain: "store.myshopify.com",
    topic: "inventory_levels/update",
    entityType: "Product",
    entityId,
    occurredAt: NOW.toISOString(),
    data: { available: 2 },
  };
}

function baseLog(extra: Row = {}): Row {
  return {
    id: "exec_orig",
    shopId: "shop_1",
    automationId: "auto_1",
    automationVersion: 1,
    triggerType: "inventory.low",
    entityRef: "gid://shopify/Product/5",
    cascadeDepth: 0,
    status: "FAILED",
    createdAt: NOW,
    parentExecutionId: null,
    payload: payloadFor("gid://shopify/Product/5"),
    ...extra,
  };
}

test("确认前零副作用：非挂起步确认不改任何东西、不发 Mutation", async () => {
  const { client } = makeClient({
    logs: [baseLog({ status: "PARTIAL_SUCCESS" })],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { sent: true } }],
    plan: [planTagThenArchive],
  });
  const { admin, mutations } = makeAdmin();
  const res = await confirmStepAction({ client, admin }, { shopId: "shop_1", stepId: "step_0" });
  assert.equal(res.ok, false);
  assert.equal(mutations.length, 0, "非挂起步不得产生 Mutation");
});

test("确认复驱挂起的改状态步：恰好一次 Mutation、步骤转终态", async () => {
  const { client, steps } = makeClient({
    logs: [baseLog({ status: "PARTIAL_SUCCESS" })],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { sent: true } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "product.updateStatus", status: "AWAITING_CONFIRMATION", result: null },
    ],
    plan: [planTagThenArchive],
  });
  const { admin, mutations } = makeAdmin();
  const res = await confirmStepAction({ client, admin }, { shopId: "shop_1", stepId: "step_1" });
  assert.equal(res.ok, true);
  assert.equal(mutations.length, 1, "只复驱被确认的一步");
  assert.equal(steps.get("step_1")?.status, "SUCCESS");
});

test("仅重跑失败步：成功步复制不重发（一次 Mutation），新建子记录原记录不动", async () => {
  const { client, logs } = makeClient({
    logs: [baseLog({ status: "PARTIAL_SUCCESS" })],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: { added: "restock" } },
      { id: "step_1", executionId: "exec_orig", order: 1, actionId: "tags.add", status: "FAILED", result: null, errorText: "Shopify API temporarily unavailable." },
    ],
    plan: [planTwoTags],
  });
  const originalStatusBefore = logs.get("exec_orig")?.status;
  const { admin, mutations } = makeAdmin();
  const res = await retryExecutionAction(
    { client, admin },
    { shopId: "shop_1", executionId: "exec_orig", failedOnly: true },
  );
  assert.equal(res.ok, true);
  assert.equal(mutations.length, 1, "成功步不重发，仅失败步重跑一次");
  assert.equal(logs.get("exec_orig")?.status, originalStatusBefore, "原记录状态不动");
  assert.ok(res.ok && res.childExecutionId, "应生成子执行");
  assert.equal(logs.get(res.childExecutionId!)?.parentExecutionId, "exec_orig");
});

test("不可重试（validation）：dead_letter 禁用带原因，且不新建子记录", async () => {
  const { client, logs } = makeClient({
    logs: [baseLog({ status: "FAILED" })],
    steps: [
      { id: "step_0", executionId: "exec_orig", order: 0, actionId: "email.send", status: "FAILED", result: null, errorText: "Email service is not configured yet." },
    ],
    plan: [planTwoTags],
  });
  const logsBefore = logs.size;
  const { admin, mutations } = makeAdmin();
  const res = await retryExecutionAction(
    { client, admin },
    { shopId: "shop_1", executionId: "exec_orig", failedOnly: false },
  );
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.message.length > 0, "禁用必须给原因");
  assert.equal(mutations.length, 0, "禁用时绝不驱动引擎");
  assert.equal(logs.size, logsBefore, "禁用时不新建任何执行记录");
});

test("重试裁决：validation/auth 判 dead_letter，瞬时 shopify_api 判可重试", () => {
  assert.equal(classifyStepFailure("Email service is not configured yet."), "validation");
  assert.equal(classifyStepFailure("This action is not executable: x."), "validation");
  assert.equal(classifyStepFailure("Not authorized to modify tags."), "auth");
  assert.equal(classifyStepFailure("Shopify API temporarily unavailable."), "shopify_api");
});

test("重试资格：无失败步 → 禁用；有可重试失败 → 放行", async () => {
  const none = makeClient({
    logs: [baseLog({ status: "SUCCESS" })],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "SUCCESS", result: {} }],
    plan: [planTwoTags],
  });
  const el1 = await evaluateRetryEligibility({ client: none.client }, "shop_1", "exec_orig");
  assert.equal(el1?.allowed, false);

  const some = makeClient({
    logs: [baseLog({ status: "FAILED" })],
    steps: [{ id: "step_0", executionId: "exec_orig", order: 0, actionId: "tags.add", status: "FAILED", result: null, errorText: "Shopify API temporarily unavailable." }],
    plan: [planTwoTags],
  });
  const el2 = await evaluateRetryEligibility({ client: some.client }, "shop_1", "exec_orig");
  assert.equal(el2?.allowed, true);
});

test("租户隔离：跨店执行不可见，确认/重试一律拒绝且零 Mutation", async () => {
  const { client, logs } = makeClient({
    logs: [baseLog({ shopId: "shop_OTHER" })],
    steps: [{ id: "step_1", executionId: "exec_orig", order: 1, actionId: "product.updateStatus", status: "AWAITING_CONFIRMATION", result: null }],
    plan: [planTagThenArchive],
  });
  const logsBefore = logs.size;
  const { admin, mutations } = makeAdmin();
  const retry = await retryExecutionAction(
    { client, admin },
    { shopId: "shop_1", executionId: "exec_orig", failedOnly: false },
  );
  assert.equal(retry.ok, false);
  const confirm = await confirmStepAction({ client, admin }, { shopId: "shop_1", stepId: "step_1" });
  assert.equal(confirm.ok, false);
  assert.equal(mutations.length, 0);
  assert.equal(logs.size, logsBefore, "跨店不改任何数据");
});

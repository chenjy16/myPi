import assert from "node:assert/strict";
import { test } from "node:test";
import {
  referencesCustomerId,
  structureReferencesCustomer,
  maskCustomerReferences,
  findCustomerExecutionRecords,
  redactCustomerReferences,
  REDACTED,
  type ComplianceClient,
} from "../app/lib/customer-compliance.ts";

const GID = "gid://shopify/Customer/";
test("referencesCustomerId：客户 GID 精确命中，数字前缀不误伤（12 ≠ 123）", () => {
  assert.ok(referencesCustomerId(`${GID}12`, 12));
  assert.ok(referencesCustomerId(`${GID}123`, "123"));
  assert.ok(!referencesCustomerId(`${GID}123`, "12"), "边界：更长的 id 不算引用了 12");
  assert.ok(!referencesCustomerId(`${GID}1`, "12"));
});

test("referencesCustomerId：独立整串的数值 id 也算引用；嵌入更长文本则不算", () => {
  assert.ok(referencesCustomerId("12", "12"));
  assert.ok(!referencesCustomerId("order-12", "12"));
  assert.ok(referencesCustomerId(12, "12", "customerId"));
  assert.ok(referencesCustomerId(12, "12", "id"));
  assert.ok(!referencesCustomerId(12, "12", "quantity"), "无关键名的数值不判引用");
});

test("structureReferencesCustomer：嵌套结构任一层命中即 true", () => {
  const node = {
    topic: "customers/create",
    data: { lines: [{ target: `${GID}77` }] },
  };
  assert.ok(structureReferencesCustomer(node, "77"));
  assert.ok(!structureReferencesCustomer(node, "78"));
  assert.ok(!structureReferencesCustomer(null, "77"));
});

test("maskCustomerReferences：折掉客户标识、保留其余字段，且不改入参", () => {
  const original = {
    entityId: `${GID}77`,
    topic: "customers/create",
    data: { tags: ["vip"], customerId: 77 },
  };
  const frozenCopy = structuredClone(original);
  const masked = maskCustomerReferences(original, "77") as typeof original & {
    data: { customerId: unknown };
  };
  assert.equal(masked.entityId, `${GID}${REDACTED}`);
  assert.equal(masked.data.customerId, REDACTED);
  assert.deepEqual(masked.data.tags, ["vip"], "非客户标识字段原样保留");
  assert.deepEqual(original, frozenCopy, "纯函数：绝不原地改入参");
});

// —— 假 ComplianceClient：如实复现 findMany/update 形状 ——

type Row = Record<string, unknown>;
function makeClient(seed: { logs: Row[]; steps: Row[] }) {
  const logs = new Map(seed.logs.map((row) => [row.id as string, { ...row }]));
  const steps = new Map(seed.steps.map((row) => [row.id as string, { ...row }]));
  const updates: { model: string; id: string; data: Row }[] = [];
  const client = {
    executionLog: {
      findMany: async ({ where }: { where: { shopId?: string } }) =>
        [...logs.values()].filter(
          (row) => where.shopId === undefined || row.shopId === where.shopId,
        ),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        updates.push({ model: "executionLog", id: where.id, data });
        Object.assign(logs.get(where.id) ?? {}, data);
      },
    },
    executionStep: {
      findMany: async ({ where }: { where: { executionId: string } }) =>
        [...steps.values()].filter((s) => s.executionId === where.executionId),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        updates.push({ model: "executionStep", id: where.id, data });
        Object.assign(steps.get(where.id) ?? {}, data);
      },
    },
  } as unknown as ComplianceClient;
  return { client, logs, steps, updates };
}

test("findCustomerExecutionRecords：只返回引用该客户的本店执行，且步骤结果已掩蔽", async () => {
  const { client } = makeClient({
    logs: [
      {
        id: "exec_hit",
        shopId: "shop_1",
        automationId: "auto_1",
        triggerType: "customer.created",
        status: "SUCCESS",
        createdAt: new Date("2026-11-01"),
        entityRef: `${GID}77`,
        payload: { entityId: `${GID}77` },
      },
      {
        id: "exec_miss",
        shopId: "shop_1",
        automationId: "auto_2",
        triggerType: "inventory.low",
        status: "SUCCESS",
        createdAt: new Date("2026-11-02"),
        entityRef: "gid://shopify/Product/5",
        payload: { data: { available: 1 } },
      },
      {
        // 他店同样引用 77：本店收口绝不带出
        id: "exec_other_shop",
        shopId: "shop_2",
        automationId: "auto_9",
        triggerType: "customer.created",
        status: "SUCCESS",
        createdAt: new Date("2026-11-03"),
        entityRef: `${GID}77`,
        payload: {},
      },
    ],
    steps: [
      {
        id: "step_hit",
        executionId: "exec_hit",
        order: 0,
        actionId: "tags.add",
        status: "SUCCESS",
        result: { node: `${GID}77` },
        errorText: null,
      },
    ],
  });

  const records = await findCustomerExecutionRecords(client, "shop_1", "77");
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "exec_hit");
  assert.deepEqual(
    (records[0].steps[0].result as { node: string }).node,
    `${GID}${REDACTED}`,
  );
});

test("redactCustomerReferences：命中行掩蔽落库（payload/entityRef/step result），未命中行零写", async () => {
  const { client, logs, steps, updates } = makeClient({
    logs: [
      {
        id: "exec_hit",
        shopId: "shop_1",
        automationId: "auto_1",
        triggerType: "customer.created",
        status: "SUCCESS",
        createdAt: new Date("2026-11-01"),
        entityRef: `${GID}77`,
        payload: { entityId: `${GID}77`, topic: "customers/create" },
      },
      {
        id: "exec_miss",
        shopId: "shop_1",
        automationId: "auto_2",
        triggerType: "inventory.low",
        status: "SUCCESS",
        createdAt: new Date("2026-11-02"),
        entityRef: "gid://shopify/Product/5",
        payload: { data: { available: 1 } },
      },
    ],
    steps: [
      {
        id: "step_hit",
        executionId: "exec_hit",
        order: 0,
        actionId: "tags.add",
        status: "SUCCESS",
        result: { node: `${GID}77`, tag: "vip" },
        errorText: null,
      },
    ],
  });

  const outcome = await redactCustomerReferences(client, "shop_1", ["77"]);
  assert.deepEqual(outcome, {
    executionsScanned: 2,
    logsMasked: 1,
    stepsMasked: 1,
  });
  const hit = logs.get("exec_hit")!;
  assert.equal(hit.entityRef, REDACTED);
  assert.equal((hit.payload as { entityId: string }).entityId, `${GID}${REDACTED}`);
  assert.equal(
    (hit.payload as { topic: string }).topic,
    "customers/create",
    "非标识字段保留（时间线仍可读）",
  );
  assert.equal(
    (steps.get("step_hit")!.result as { node: string }).node,
    `${GID}${REDACTED}`,
  );
  assert.equal(
    (steps.get("step_hit")!.result as { tag: string }).tag,
    "vip",
  );
  assert.equal(logs.get("exec_miss")!.entityRef, "gid://shopify/Product/5");
  assert.ok(
    updates.every((u) => u.id !== "exec_miss"),
    "未命中的执行零写入",
  );
});

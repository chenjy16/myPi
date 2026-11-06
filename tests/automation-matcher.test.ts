import assert from "node:assert/strict";
import { test } from "node:test";
import { matchAutomations } from "../app/automation-matcher.server.ts";
import { compile } from "../app/lib/automation-compiler.ts";

const plan = compile({
  dslVersion: "2.0",
  name: "Tag new orders",
  status: "active",
  trigger: { type: "order.created", source: "shopify.webhook", topic: "orders/create" },
  actions: [{ actionId: "tags.add", params: { tag: "new" } }],
});
const inventoryPlan = compile({
  dslVersion: "2.0",
  name: "Low stock mail",
  status: "active",
  trigger: { type: "inventory.low", source: "shopify.webhook+reconcile", topic: "inventory_levels/update" },
  actions: [{ actionId: "email.send", params: { template: "low_stock" } }],
});

type AutomationRow = { id: string; currentVersionId: string | null };
type SeededRow = AutomationRow & { shopId: string; status: string };
type VersionRow = { id: string; automationId: string; version: number; definition: unknown };

function fakeClient(automations: SeededRow[], versions: VersionRow[]) {
  const calls: { where: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      automation: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ where: args.where });
          // 如实执行 shopId+status+currentVersionId 非空过滤：跨店行不得漏进结果
          const shopId = args.where.shopId as string;
          const status = args.where.status as string;
          return automations.filter(
            (a) => a.shopId === shopId && a.status === status && a.currentVersionId !== null,
          );
        },
      },
      automationVersion: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          calls.push({ where: args.where });
          const inIds = (args.where.id as { in: string[] }).in;
          return versions.filter((v) => inIds.includes(v.id));
        },
      },
    },
  };
}

test("active + 编译版本命中：返回 automationId/version/plan", async () => {
  const { client } = fakeClient(
    [{ id: "auto_1", shopId: "shop_A", status: "active", currentVersionId: "v1" }],
    [{ id: "v1", automationId: "auto_1", version: 3, definition: plan }],
  );
  const matched = await matchAutomations(client, "shop_A", "order.created");
  assert.deepEqual(matched, [{ automationId: "auto_1", version: 3, plan }]);
});

test("多租户铁律：where 必带 shopId；跨店行即便假想泄漏也按归属校验拒掉", async () => {
  const { client, calls } = fakeClient(
    [
      { id: "auto_A", shopId: "shop_A", status: "active", currentVersionId: "vA" },
      { id: "auto_B", shopId: "shop_B", status: "active", currentVersionId: "vB" },
    ],
    [
      { id: "vA", automationId: "auto_A", version: 1, definition: plan },
      { id: "vB", automationId: "auto_B", version: 1, definition: plan },
    ],
  );
  const matched = await matchAutomations(client, "shop_A", "order.created");
  assert.deepEqual(matched.map((m) => m.automationId), ["auto_A"]);
  assert.equal(calls[0].where.shopId, "shop_A");
  await assert.rejects(matchAutomations(client, "", "order.created"), /shopId/);
});

test("paused / deleted / 无当前版本：一律不命中", async () => {
  const { client } = fakeClient(
    [
      { id: "auto_paused", shopId: "shop_A", status: "paused", currentVersionId: "v1" },
      { id: "auto_deleted", shopId: "shop_A", status: "deleted", currentVersionId: "v1" },
      { id: "auto_nover", shopId: "shop_A", status: "active", currentVersionId: null },
    ],
    [{ id: "v1", automationId: "auto_paused", version: 1, definition: plan }],
  );
  assert.deepEqual(await matchAutomations(client, "shop_A", "order.created"), []);
});

test("trigger 类型不符不命中；多条同类命中各自独立返回（不合并）", async () => {
  const { client } = fakeClient(
    [
      { id: "auto_2", shopId: "shop_A", status: "active", currentVersionId: "v2" },
      { id: "auto_1", shopId: "shop_A", status: "active", currentVersionId: "v1" },
    ],
    [
      { id: "v1", automationId: "auto_1", version: 1, definition: plan },
      { id: "v2", automationId: "auto_2", version: 2, definition: plan },
    ],
  );
  assert.deepEqual(await matchAutomations(client, "shop_A", "inventory.low"), []);
  const matched = await matchAutomations(client, "shop_A", "order.created");
  assert.deepEqual(matched.map((m) => m.automationId), ["auto_1", "auto_2"]); // id 稳定排序
});

test("带病数据跳过：悬空版本指针 / 版本反指他人 / 原始 DSL（非编译产物）", async () => {
  const { client } = fakeClient(
    [
      { id: "auto_dangling", shopId: "shop_A", status: "active", currentVersionId: "missing" },
      { id: "auto_misdirect", shopId: "shop_A", status: "active", currentVersionId: "vX" },
      { id: "auto_rawdsl", shopId: "shop_A", status: "active", currentVersionId: "vR" },
      { id: "auto_ok", shopId: "shop_A", status: "active", currentVersionId: "v1" },
    ],
    [
      { id: "vX", automationId: "someone_else", version: 1, definition: plan },
      { id: "vR", automationId: "auto_rawdsl", version: 1, definition: { dslVersion: "2.0", name: "raw" } },
      { id: "v1", automationId: "auto_ok", version: 1, definition: inventoryPlan },
    ],
  );
  const matched = await matchAutomations(client, "shop_A", "inventory.low");
  assert.deepEqual(matched.map((m) => m.automationId), ["auto_ok"]);
});

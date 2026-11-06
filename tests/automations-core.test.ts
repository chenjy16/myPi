import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFromTemplate,
  updateParams,
  getAutomation,
  listAutomations,
  setActive,
  pause,
  softDelete,
  buildPlanFromTemplate,
  AutomationNotFoundError,
  AutomationValidationError,
  type AutomationClient,
} from "../app/lib/automations-core.ts";
import { getTemplate } from "../app/lib/template-catalog.ts";

// P3-04 服务测（脱库）：假 client 如实复现 Prisma 的归属过滤 / 版本递增 / 唯一约束行为，
// 锁死三条红线：跨店不可读写；编辑生成新 version 且旧版保留；非法定义被拒不写库。

type Row = Record<string, unknown> & { id: string; shopId?: string };

function cuid(n: number) {
  return `id-${n}`;
}

function makeFakeDb() {
  const automations: Row[] = [];
  const versions: Row[] = [];
  const logs: Row[] = [];
  let seq = 0;

  const attach = (row: Row, include?: { versions?: boolean; logs?: unknown }) => {
    const out: Row = { ...row };
    if (include?.versions)
      out.versions = versions
        .filter((v) => v.automationId === row.id)
        .sort((a, b) => (a.version as number) - (b.version as number))
        .map((v) => ({ ...v }));
    if (include?.logs)
      out.logs = logs
        .filter((l) => l.automationId === row.id)
        .sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
        .map((l) => ({ ...l }));
    return out;
  };

  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (key === "status" && cond && typeof cond === "object" && "not" in cond) {
        if (row.status === (cond as { not: unknown }).not) return false;
      } else if (row[key] !== cond) {
        return false;
      }
    }
    return true;
  };

  const client = {
    automation: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row: Row = {
          id: cuid(++seq),
          shopId: data.shopId as string,
          name: data.name as string,
          status: (data.status as string) ?? "paused",
          currentVersionId: (data.currentVersionId as string) ?? null,
          updatedAt: new Date(),
        };
        automations.push(row);
        return { ...row };
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const row = automations.find((a) => a.id === where.id);
        if (!row) throw new Error("update: not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      async findFirst({ where, include }: { where?: Record<string, unknown>; include?: { versions?: boolean; logs?: unknown } }) {
        const row = automations.find((a) => matches(a, where));
        return row ? attach(row, include) : null;
      },
      async findMany({ where, include }: { where?: Record<string, unknown>; include?: { versions?: boolean; logs?: unknown } }) {
        return automations
          .filter((a) => matches(a, where))
          .map((a) => attach(a, include));
      },
    },
    automationVersion: {
      async create({ data }: { data: Record<string, unknown> }) {
        const clash = versions.some(
          (v) => v.automationId === data.automationId && v.version === data.version,
        );
        if (clash) throw new Error("unique: (automationId, version)");
        const row: Row = {
          id: cuid(++seq),
          automationId: data.automationId as string,
          version: data.version as number,
          definition: data.definition,
          templateId: (data.templateId as string) ?? null,
          templateVersion: (data.templateVersion as string) ?? null,
          createdAt: new Date(),
        };
        versions.push(row);
        return { ...row };
      },
      async findFirst({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { version: string } }) {
        const list = versions.filter((v) => matches(v, where));
        if (orderBy?.version === "desc") list.sort((a, b) => (b.version as number) - (a.version as number));
        return list[0] ? { ...list[0] } : null;
      },
    },
    executionLog: {
      async findMany({ where }: { where?: Record<string, unknown> }) {
        return logs.filter((l) => matches(l, where)).map((l) => ({ ...l }));
      },
    },
  };

  return {
    client: client as unknown as AutomationClient,
    seed: { automations, versions, logs },
    addAutomation: (row: Row) => automations.push(row),
    addVersion: (row: Row) => versions.push(row),
    addLog: (row: Row) => logs.push(row),
  };
}

test("createFromTemplate freezes compiled plan and wires currentVersionId", async () => {
  const { client, seed } = makeFakeDb();
  const created = await createFromTemplate(client, "shop-1", {
    templateId: "T1-vip-tag",
    params: { amount: 800, tag: "Gold" },
    name: "VIP Gold tagging",
  });
  assert.equal(created.status, "active");
  assert.equal(created.name, "VIP Gold tagging");
  assert.ok(created.currentVersionId);
  assert.equal(seed.versions.length, 1);
  const plan = seed.versions[0].definition as { triggerType: string; actions: { actionId: string; params: Record<string, unknown> }[] };
  assert.equal(plan.triggerType, "order.paid");
  assert.equal(plan.actions[0].actionId, "tags.add");
  assert.equal(plan.actions[0].params.tag, "Gold");
});

test("cross-shop reads are denied (tenant isolation)", async () => {
  const { client } = makeFakeDb();
  const created = await createFromTemplate(client, "shop-1", { templateId: "T4-low-stock" });
  await assert.rejects(
    () => getAutomation(client, "shop-2", created.id),
    AutomationNotFoundError,
  );
});

test("updateParams creates version 2 and keeps version 1 (no overwrite)", async () => {
  const { client, seed } = makeFakeDb();
  const created = await createFromTemplate(client, "shop-1", {
    templateId: "T1-vip-tag",
    params: { amount: 500 },
  });
  const v1Id = created.currentVersionId;
  const updated = await updateParams(client, "shop-1", created.id, { amount: 999, tag: "Plat" });
  assert.equal(seed.versions.length, 2);
  const v2 = seed.versions.find((v) => v.version === 2)!;
  const v1 = seed.versions.find((v) => v.version === 1)!;
  assert.equal(v2.id, updated.currentVersionId);
  assert.notEqual(v2.id, v1Id);
  // 旧版原样保留（历史执行可回放）
  assert.equal(v1.version, 1);
  const plan2 = v2.definition as { actions: { params: Record<string, unknown> }[] };
  assert.equal(plan2.actions[0].params.tag, "Plat");
});

test("updateParams on a non-template automation is rejected and adds no version", async () => {
  const { client, addAutomation, addVersion, seed } = makeFakeDb();
  addAutomation({ id: "a-custom", shopId: "shop-1", name: "Custom", status: "active", currentVersionId: "ver-custom" });
  addVersion({ id: "ver-custom", automationId: "a-custom", version: 1, templateId: null, definition: {} });
  await assert.rejects(
    () => updateParams(client, "shop-1", "a-custom", { amount: 1 }),
    AutomationValidationError,
  );
  assert.equal(seed.versions.length, 1);
});

test("setActive / pause / softDelete are shop-scoped and softDelete hides from list", async () => {
  const { client } = makeFakeDb();
  const created = await createFromTemplate(client, "shop-1", { templateId: "T4-low-stock" });
  await pause(client, "shop-1", created.id);
  const paused = await getAutomation(client, "shop-1", created.id);
  assert.equal(paused.status, "paused");
  await setActive(client, "shop-1", created.id);
  // 跨店启停被拒
  await assert.rejects(() => setActive(client, "shop-9", created.id), AutomationNotFoundError);
  await softDelete(client, "shop-1", created.id);
  const list = await listAutomations(client, "shop-1");
  assert.equal(list.some((a) => a.id === created.id), false);
});

test("unknown template rejects with no rows written", async () => {
  const { client, seed } = makeFakeDb();
  await assert.rejects(
    () => createFromTemplate(client, "shop-1", { templateId: "does-not-exist" }),
    AutomationValidationError,
  );
  assert.equal(seed.automations.length, 0);
  assert.equal(seed.versions.length, 0);
});

test("buildPlanFromTemplate merges defaults and yields a compilable plan", () => {
  const t = getTemplate("T4-low-stock")!;
  const plan = buildPlanFromTemplate(t, {}); // all defaults
  assert.equal(plan.triggerType, "inventory.low");
});

test("listAutomations surfaces trigger type and current version for shop rows", async () => {
  const { client } = makeFakeDb();
  await createFromTemplate(client, "shop-1", { templateId: "T1-vip-tag" });
  await createFromTemplate(client, "shop-1", { templateId: "T7-customer-segment" });
  const list = await listAutomations(client, "shop-1");
  assert.equal(list.length, 2);
  assert.ok(list.every((a) => a.currentVersion === 1));
  assert.ok(list.some((a) => a.triggerType === "order.paid"));
  assert.ok(list.some((a) => a.templateId === "T7-customer-segment"));
});

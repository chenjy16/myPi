import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRetentionDays,
  cutoffDate,
  selectPrunableExecutions,
  DEFAULT_EXECUTION_RETENTION_DAYS,
} from "../app/lib/retention-policy.ts";
import {
  pruneOldExecutions,
} from "../app/lib/execution-retention.ts";
import { REDACTED } from "../app/lib/customer-compliance.ts";

const DAY = 24 * 60 * 60 * 1000;
const GID = "gid://shopify/Customer/";

test("parseRetentionDays：合法正整数生效，非法/非正/缺省一律回退默认", () => {
  assert.equal(parseRetentionDays("90"), 90);
  assert.equal(parseRetentionDays("90.7"), 90, "向下取整，不四舍五入进位");
  assert.equal(parseRetentionDays("0"), DEFAULT_EXECUTION_RETENTION_DAYS, "0 等于全删，必须拒绝");
  assert.equal(parseRetentionDays("-5"), DEFAULT_EXECUTION_RETENTION_DAYS);
  assert.equal(parseRetentionDays("abc"), DEFAULT_EXECUTION_RETENTION_DAYS);
  assert.equal(parseRetentionDays(undefined), DEFAULT_EXECUTION_RETENTION_DAYS);
});

test("cutoffDate：now 减窗口天数，调用方注入时钟不自取", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(cutoffDate(now, 180).toISOString(), "2025-12-03T00:00:00.000Z");
  assert.equal(cutoffDate(now, 1).toISOString(), "2026-05-31T00:00:00.000Z");
});

test("selectPrunableExecutions：窗口内保留、窗口外进入删除集合，客户引用单独分类", () => {
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const rows = [
    { id: "old_plain", createdAt: new Date("2025-12-31T23:59:59Z"), entityRef: "gid://shopify/Product/1" },
    { id: "old_customer", createdAt: new Date("2025-06-01T00:00:00Z"), entityRef: `${GID}77` },
    { id: "old_payload_ref", createdAt: new Date("2025-06-02T00:00:00Z"), entityRef: null, payload: { entityId: `${GID}88` } },
    { id: "fresh", createdAt: cutoff, entityRef: `${GID}99`, payload: null },
  ];
  const { toDelete, withCustomerRef } = selectPrunableExecutions(rows, cutoff);
  assert.deepEqual(toDelete.map((r) => r.id), ["old_plain", "old_customer", "old_payload_ref"], "cutoff 当刻的行还没过期（严格小于）");
  assert.deepEqual(withCustomerRef.map((r) => r.id), ["old_customer", "old_payload_ref"]);
});

// —— 假 PruneClient：如实复现 findMany/update/deleteMany 形状 ——

function makeClient(seed: {
  logs: Record<string, unknown>[];
  steps: Record<string, unknown>[];
}) {
  const logs = new Map(seed.logs.map((row) => [row.id as string, { ...row }]));
  const steps = new Map(seed.steps.map((row) => [row.id as string, { ...row }]));
  const deletedIds: string[] = [];
  // 如实记录调用序列：「先掩蔽、后删除」的次序断言靠它取证（删除后行已不行在，不能回读 logs）。
  const ops: string[] = [];
  const client = {
    executionLog: {
      findMany: async ({ where, take }: { where: { createdAt: { lt: Date } }; take?: number }) =>
        [...logs.values()]
          .filter((row) => (row.createdAt as Date) < where.createdAt.lt)
          .slice(0, take),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        ops.push(`log:update:${where.id}`);
        Object.assign(logs.get(where.id) ?? {}, data);
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          ops.push(`log:delete:${id}`);
          logs.delete(id);
          deletedIds.push(id);
        }
        return { count: where.id.in.length };
      },
    },
    executionStep: {
      findMany: async ({ where }: { where: { executionId: string } }) =>
        [...steps.values()].filter((s) => s.executionId === where.executionId),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        ops.push(`step:update:${where.id}`);
        Object.assign(steps.get(where.id) ?? {}, data);
      },
    },
  } as unknown as Parameters<typeof pruneOldExecutions>[0];
  return { client, logs, steps, deletedIds, ops };
}

test("pruneOldExecutions：窗口外全删；含客户引用的行删除前先掩蔽 entityRef/payload/step result", async () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const { client, logs, steps, ops } = makeClient({
    logs: [
      {
        id: "old_customer",
        createdAt: new Date(now.getTime() - 200 * DAY),
        entityRef: `${GID}77`,
        payload: { entityId: `${GID}77`, topic: "customers/create" },
      },
      {
        id: "old_plain",
        createdAt: new Date(now.getTime() - 199 * DAY),
        entityRef: "gid://shopify/Product/5",
        payload: { data: { available: 1 } },
      },
      {
        id: "fresh",
        createdAt: new Date(now.getTime() - DAY),
        entityRef: `${GID}123`,
        payload: {},
      },
    ],
    steps: [
      { id: "step_1", executionId: "old_customer", result: { node: `${GID}77`, tag: "vip" } },
    ],
  });

  const result = await pruneOldExecutions(client, { now: () => now, retentionDays: 180 });
  assert.equal(result.retentionDays, 180);
  assert.equal(result.cutoff.toISOString(), new Date(now.getTime() - 180 * DAY).toISOString());
  assert.deepEqual(
    { scanned: result.scanned, masked: result.masked, deleted: result.deleted, hitBatchCap: result.hitBatchCap },
    { scanned: 2, masked: 1, deleted: 2, hitBatchCap: false },
  );
  assert.ok(!logs.has("old_customer") && !logs.has("old_plain"), "窗口外行已删");
  assert.ok(logs.has("fresh"), "窗口内行不动（哪怕带客户引用）");
  // 先掩蔽后删：日志行/步骤的 update 必须发生在该行 delete 之前，且不存「未掩蔽就被删」的客户行。
  const maskIdx = ops.indexOf("step:update:step_1");
  const deleteIdx = ops.indexOf("log:delete:old_customer");
  assert.ok(maskIdx >= 0 && deleteIdx >= 0 && maskIdx < deleteIdx, `期望掩蔽先于删除，实际序列：${ops.join(" | ")}`);
  assert.ok(ops.indexOf("log:update:old_customer") < deleteIdx, "entityRef/payload 掩蔽写入也先于删除");
  assert.equal(
    (steps.get("step_1")!.result as { node: string }).node,
    `${GID}${REDACTED}`,
    "step result 的客户 GID 已折掉",
  );
  assert.equal((steps.get("step_1")!.result as { tag: string }).tag, "vip");
});

test("pruneOldExecutions：batch 上限截断并如实上报 hitBatchCap，下一轮幂等接续", async () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const old = (n: number) => ({
    id: `old_${n}`,
    createdAt: new Date(now.getTime() - (200 + n) * DAY),
    entityRef: null,
    payload: null,
  });
  const { client, deletedIds } = makeClient({
    logs: [old(1), old(2), old(3)],
    steps: [],
  });

  const first = await pruneOldExecutions(client, { now: () => now, retentionDays: 180, batch: 2 });
  assert.equal(first.deleted, 2);
  assert.ok(first.hitBatchCap, "删满 batch → 还有积压");
  const second = await pruneOldExecutions(client, { now: () => now, retentionDays: 180, batch: 2 });
  assert.equal(second.deleted, 1);
  assert.ok(!second.hitBatchCap);
  assert.deepEqual(deletedIds.sort(), ["old_1", "old_2", "old_3"]);
});

test("pruneOldExecutions：空库零写零删，仍如实报告窗口", async () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const { client } = makeClient({ logs: [], steps: [] });
  const result = await pruneOldExecutions(client, { now: () => now, retentionDays: 30 });
  assert.deepEqual(result, {
    retentionDays: 30,
    cutoff: new Date(now.getTime() - 30 * DAY),
    scanned: 0,
    masked: 0,
    deleted: 0,
    hitBatchCap: false,
  });
});

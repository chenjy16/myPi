import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasRunningJob,
  reapStaleRunningJobs,
  withSyncJob,
  type SyncJobClient,
} from "../app/lib/sync-job-ledger.ts";
import { SyncAlreadyRunningError } from "../app/lib/sync-job-policy.ts";

/**
 * 台账编排的单测：喂一个假 dataSyncJob 代理，验证抢锁 / running→succeeded/failed /
 * 租约回收 / 撞锁分类这些「连库才看得见」的状态机逻辑。假代理如实复现 Prisma 的
 * 唯一约束抛错（P2002）与 updateMany 返回 {count} 的形状，所以这里跑的就是真实分支。
 */

type FakeArgs = {
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
};

type RecordedCall = { op: string; args: FakeArgs };

function fakeClient(
  options: {
    createError?: unknown;
    findFirstResult?: unknown;
    updateManyCount?: number;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const dataSyncJob = {
    create: async (args: FakeArgs) => {
      calls.push({ op: "create", args });
      if (options.createError) throw options.createError;
      return { id: "job-1" };
    },
    update: async (args: FakeArgs) => {
      calls.push({ op: "update", args });
      return {};
    },
    updateMany: async (args: FakeArgs) => {
      calls.push({ op: "updateMany", args });
      return { count: options.updateManyCount ?? 0 };
    },
    findFirst: async (args: FakeArgs) => {
      calls.push({ op: "findFirst", args });
      return options.findFirstResult ?? null;
    },
    findMany: async (args: FakeArgs) => {
      calls.push({ op: "findMany", args });
      return [];
    },
  };
  // 假代理只需覆盖编排真正用到的方法，边界处一次 cast 换来生产侧对真实 Prisma 的零改动绑定。
  const client = { dataSyncJob } as unknown as SyncJobClient;
  return { calls, client };
}

const baseInput = {
  shop: "acme.myshopify.com",
  jobType: "inventory-snapshot" as const,
  triggeredBy: "manual" as const,
};

test("a successful sync claims the lock then writes succeeded and releases it", async () => {
  const { calls, client } = fakeClient();

  const result = await withSyncJob(client, baseInput, async () => ({
    result: "synced",
    recordsProcessed: 7,
  }));

  assert.equal(result, "synced");
  // 抢锁行必须是 running 且占用 activeKey。
  const create = calls.find((c) => c.op === "create");
  assert.equal(create?.args.data?.status, "running");
  assert.equal(
    create?.args.data?.activeKey,
    "acme.myshopify.com:inventory-snapshot",
  );
  // 完成写回：succeeded、放锁、记处理条数。
  const update = calls.find((c) => c.op === "update");
  assert.equal(update?.args.data?.status, "succeeded");
  assert.equal(update?.args.data?.activeKey, null);
  assert.equal(update?.args.data?.recordsProcessed, 7);
});

test("reap runs before the claim so a crashed row can't lock the shop out", async () => {
  const { calls, client } = fakeClient();

  await withSyncJob(client, baseInput, async () => ({ result: 1 }));

  const reapIndex = calls.findIndex((c) => c.op === "updateMany");
  const createIndex = calls.findIndex((c) => c.op === "create");
  assert.ok(reapIndex !== -1, "expected a reap pass");
  assert.ok(reapIndex < createIndex, "reap must precede the claim");
});

test("a task that throws is recorded as failed and rethrown untouched", async () => {
  const { calls, client } = fakeClient();

  await assert.rejects(
    withSyncJob(client, baseInput, async () => {
      throw new Error("admin api exploded");
    }),
    /admin api exploded/,
  );

  const update = calls.find((c) => c.op === "update");
  assert.equal(update?.args.data?.status, "failed");
  assert.equal(update?.args.data?.activeKey, null);
  assert.match(String(update?.args.data?.error), /admin api exploded/);
});

test("a lost claim maps to SyncAlreadyRunningError and writes no completion row", async () => {
  const { calls, client } = fakeClient({ createError: { code: "P2002" } });

  await assert.rejects(
    withSyncJob(client, baseInput, async () => ({ result: "never runs" })),
    SyncAlreadyRunningError,
  );

  // 撞锁的一方从未真正建过任务，绝不能把别人在跑的行改成交集外的 failed。
  assert.equal(
    calls.filter((c) => c.op === "update").length,
    0,
    "no completion update on a lost race",
  );
});

test("reapStaleRunningJobs flips old running rows and returns the count", async () => {
  const { calls, client } = fakeClient({ updateManyCount: 3 });

  const count = await reapStaleRunningJobs(client, "acme.myshopify.com");

  assert.equal(count, 3);
  const reap = calls.find((c) => c.op === "updateMany");
  assert.equal(reap?.args.data?.status, "failed");
  assert.equal(reap?.args.data?.activeKey, null);
  assert.equal(reap?.args.where?.shop, "acme.myshopify.com");
  assert.equal(reap?.args.where?.status, "running");
});

test("hasRunningJob reports within-lease running and de-dups concurrent triggers", async () => {
  const running = fakeClient({ findFirstResult: { id: "job-x" } });
  assert.equal(
    await hasRunningJob(running.client, "acme.myshopify.com", "inventory-snapshot"),
    true,
  );

  const idle = fakeClient({ findFirstResult: null });
  assert.equal(
    await hasRunningJob(idle.client, "acme.myshopify.com", "inventory-snapshot"),
    false,
  );

  // 每次判定前都先做一次租约回收，崩溃残留不会把这家店永久锁死。
  const reapFirst = idle.calls[0];
  assert.equal(reapFirst?.op, "updateMany");
});

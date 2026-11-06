import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimNextEvent,
  completeExecutionJob,
  enqueueStandardEvent,
  reapStaleExecutionJobs,
  type ExecutionQueueClient,
} from "../app/lib/execution-queue.ts";
import {
  executionClaimKey,
  executionEventKey,
} from "../app/lib/execution-job-policy.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

/**
 * 执行队列单测（P1-09）：入队去重（activeKey 即事件锁）、queued→running 认领、
 * 租约回收、坏 payload 折 failed 后继续下一条。假代理如实复现 P2002 与 updateMany count 形状。
 */

const event: StandardEvent = {
  shopDomain: "demo.myshopify.com",
  topic: "inventory_levels/update",
  entityType: "ProductVariant",
  entityId: "gid://shopify/ProductVariant/9",
  occurredAt: new Date("2026-11-05T08:00:00Z"),
  data: { available: 1 },
};

type Row = {
  id: string;
  status: string;
  cursor: string | null;
  activeKey: string | null;
  shop: string;
  createdAt: Date;
  startedAt: Date | null;
  error?: string | null;
};

function fakeQueue(options: { seedRows?: Row[]; createConflict?: boolean } = {}) {
  const rows = new Map<string, Row>(
    (options.seedRows ?? []).map((r) => [r.id, r]),
  );
  let nextId = rows.size + 1;
  const client = {
    dataSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const claim = data.activeKey as string;
        if (options.createConflict || [...rows.values()].some((r) => r.activeKey === claim)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: Row = {
          id: `job-${nextId++}`,
          status: "queued",
          cursor: (data.cursor as string) ?? null,
          activeKey: claim,
          shop: data.shop as string,
          createdAt: new Date(),
          startedAt: null,
        };
        rows.set(row.id, row);
        return { id: row.id };
      },
      findFirst: async ({ where }: { where: { shop?: string; status?: string } }) => {
        const found = [...rows.values()]
          .filter((r) => r.shop === where.shop && r.status === where.status)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return found ? { id: found.id, cursor: found.cursor } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of rows.values()) {
          const idOk = !where.id || row.id === where.id;
          const statusOk =
            !where.status ||
            (Array.isArray(where.status)
              ? (where.status as string[]).includes(row.status)
              : row.status === where.status);
          const shopOk = !where.shop || row.shop === where.shop;
          const startedOk =
            !where.startedAt ||
            (row.startedAt !== null &&
              row.startedAt < (where.startedAt as { lt: Date }).lt);
          const createdOk =
            !where.createdAt || row.createdAt < (where.createdAt as { lt: Date }).lt;
          if (idOk && statusOk && shopOk && startedOk && createdOk) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("row not found");
        Object.assign(row, data);
        return row;
      },
    },
  } as unknown as ExecutionQueueClient;
  return { client, rows };
}

test("入队：首次成功、同 deliveryId 重复被 activeKey 挡下", async () => {
  const { client, rows } = fakeQueue();
  const first = await enqueueStandardEvent(client, event, { deliveryId: "wh-1" });
  assert.equal(first.enqueued, true);
  assert.ok(first.jobId);

  const second = await enqueueStandardEvent(client, event, { deliveryId: "wh-1" });
  assert.deepEqual(second, { jobId: null, enqueued: false, duplicate: true });
  assert.equal(rows.size, 1);
  // 事件指纹优先用 deliveryId；无则退化为组合键
  assert.equal(executionEventKey(event, "wh-1"), "d:wh-1");
  assert.ok(executionEventKey(event).startsWith("e:demo.myshopify.com:"));
  assert.ok(executionClaimKey("d:wh-1").startsWith("automation-execute:"));
});

test("认领：queued→running、payload 完整还原、放行进终态", async () => {
  const { client, rows } = fakeQueue();
  await enqueueStandardEvent(client, event, { deliveryId: "wh-2" });

  const claimed = await claimNextEvent(client, event.shopDomain, new Date());
  assert.ok(claimed);
  assert.equal(claimed.event.entityId, event.entityId);
  assert.equal(claimed.event.occurredAt.toISOString(), event.occurredAt.toISOString());
  assert.equal(claimed.event.data.available, 1);
  assert.equal(rows.get(claimed.jobId)?.status, "running");
  // 认领后锁仍在（activeKey 保留到终态才放）
  assert.ok(rows.get(claimed.jobId)?.activeKey);

  await completeExecutionJob(client, claimed.jobId, true);
  const done = rows.get(claimed.jobId);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.activeKey, null);
});

test("队列空时认领返回 null，不制造副作用", async () => {
  const { client } = fakeQueue();
  assert.equal(await claimNextEvent(client, "nobody.myshopify.com"), null);
});

test("租约回收：超时 running 折 failed 并放锁，同事件得以重新入队", async () => {
  const staleStarted = new Date(Date.now() - 11 * 60_000); // 超过默认 10 分钟租约
  const { client, rows } = fakeQueue({
    seedRows: [
      {
        id: "job-crash",
        status: "running",
        cursor: JSON.stringify(event),
        activeKey: executionClaimKey("d:wh-3"),
        shop: event.shopDomain,
        createdAt: new Date(staleStarted.getTime() - 1000),
        startedAt: staleStarted,
      },
    ],
  });
  const reaped = await reapStaleExecutionJobs(client, undefined, new Date());
  assert.equal(reaped, 1);
  assert.equal(rows.get("job-crash")?.status, "failed");
  assert.equal(rows.get("job-crash")?.activeKey, null);
});

test("从未被认领的超龄 queued 同样回收，绝不永久占住事件锁", async () => {
  const { client, rows } = fakeQueue({
    seedRows: [
      {
        id: "job-orphan",
        status: "queued",
        cursor: JSON.stringify(event),
        activeKey: executionClaimKey("d:wh-4"),
        shop: event.shopDomain,
        createdAt: new Date(Date.now() - 61 * 60_000),
        startedAt: null,
      },
    ],
  });
  const reaped = await reapStaleExecutionJobs(client, undefined, new Date());
  assert.equal(reaped, 1);
  assert.equal(rows.get("job-orphan")?.status, "failed");
});

test("坏 payload 行：认领时折 failed 放锁，并继续认领下一条好行", async () => {
  const good = enqueueSeed();
  const { client, rows } = fakeQueue({
    seedRows: [
      {
        id: "job-bad",
        status: "queued",
        cursor: "{not-json",
        activeKey: executionClaimKey("d:bad"),
        shop: "demo.myshopify.com",
        createdAt: new Date("2026-11-05T07:45:00Z"),
        startedAt: null,
      },
      good,
    ],
  });
  const claimed = await claimNextEvent(client, "demo.myshopify.com", new Date("2026-11-05T07:50:00Z"));
  assert.ok(claimed);
  assert.equal(claimed.jobId, good.id); // 跳过坏行拿到好行
  assert.equal(rows.get("job-bad")?.status, "failed");
  assert.equal(rows.get("job-bad")?.activeKey, null);
});

function enqueueSeed(): Row {
  return {
    id: "job-good",
    status: "queued",
    cursor: JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() }),
    activeKey: executionClaimKey("d:wh-5"),
    shop: "demo.myshopify.com",
    createdAt: new Date("2026-11-05T07:46:00Z"),
    startedAt: null,
  };
}

test("失败收尾：error 截断落库且放锁", async () => {
  const { client, rows } = fakeQueue();
  await enqueueStandardEvent(client, event, { deliveryId: "wh-6" });
  const claimed = await claimNextEvent(client, event.shopDomain, new Date());
  assert.ok(claimed);
  await completeExecutionJob(client, claimed.jobId, false, "x".repeat(900));
  const row = rows.get(claimed.jobId);
  assert.equal(row?.status, "failed");
  assert.equal(row?.activeKey, null);
  assert.ok((row?.error ?? "").length <= 500);
});

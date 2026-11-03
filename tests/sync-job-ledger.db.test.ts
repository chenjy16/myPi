import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { buildDatasourceUrl } from "../app/lib/db-pool-url.ts";
import {
  reapStaleRunningJobs,
  withSyncJob,
} from "../app/lib/sync-job-ledger.ts";
import { SyncAlreadyRunningError } from "../app/lib/sync-job-policy.ts";

/**
 * 一次性 Postgres 上的真·DB 集成测试（P1-6）。默认跳过，只有显式
 * MYPI_DB_INTEGRATION=1（CI 里配好临时库并 migrate deploy 后设置）才执行，
 * 因此绝不会误写共享的 dev 库。它验证的是应用代码赖以成立的两类真实约束：
 *   - DataSyncJob.activeKey 唯一索引 = 跨进程任务锁（抢锁失败即 SyncAlreadyRunningError）；
 *   - 交互式事务（P0-3 的 timeout/maxWait 口径）能整体回滚 + RecommendationAudit.requestKey 幂等。
 * 同一份 ledger 逻辑在单测里喂假客户端，这里喂真实 Prisma，两条路径共享实现。
 */

const enabled = process.env.MYPI_DB_INTEGRATION === "1";
const skipReason =
  "set MYPI_DB_INTEGRATION=1 against a throwaway DATABASE_URL (runs in CI)";
const shop = `p16-integration-${process.pid}.myshopify.com`;

let db: PrismaClient;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === "P2002";
}

before(async () => {
  if (!enabled) return;
  const url = buildDatasourceUrl();
  db = new PrismaClient(
    url ? { datasources: { db: { url } } } : undefined,
  );
  await db.$connect();
});

after(async () => {
  if (!enabled || !db) return;
  await db.dataSyncJob.deleteMany({ where: { shop } });
  await db.recommendationAudit.deleteMany({ where: { shop } });
  await db.reorderRecommendation.deleteMany({ where: { shop } });
  await db.salesDaily.deleteMany({ where: { shop } });
  await db.$disconnect();
});

test(
  "withSyncJob writes a real succeeded row and releases the lock",
  { skip: !enabled && skipReason },
  async () => {
    const out = await withSyncJob(
      db,
      { shop, jobType: "inventory-snapshot", triggeredBy: "manual" },
      async () => ({ result: "ok", recordsProcessed: 4 }),
    );
    assert.equal(out, "ok");

    const row = await db.dataSyncJob.findFirst({
      where: { shop, jobType: "inventory-snapshot", status: "succeeded" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row, "expected a persisted succeeded row");
    assert.equal(row.activeKey, null, "lock must be released on success");
    assert.equal(row.recordsProcessed, 4);
  },
);

test(
  "a live claim on the same shop+job blocks a second claim via the unique lock",
  { skip: !enabled && skipReason },
  async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSyncJob(
      db,
      { shop, jobType: "sales-daily", triggeredBy: "manual" },
      async () => {
        await gate;
        return { result: "first" };
      },
    );

    // 等第一个任务真正抢到 running 行，再让第二个撞锁。
    let claimed = false;
    for (let attempt = 0; attempt < 50 && !claimed; attempt += 1) {
      claimed = Boolean(
        await db.dataSyncJob.findFirst({
          where: { shop, jobType: "sales-daily", status: "running" },
          select: { id: true },
        }),
      );
      if (!claimed) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(claimed, "first job should have claimed the running lock row");

    await assert.rejects(
      withSyncJob(
        db,
        { shop, jobType: "sales-daily", triggeredBy: "manual" },
        async () => ({ result: "second" }),
      ),
      SyncAlreadyRunningError,
    );

    releaseFirst();
    assert.equal(await first, "first");
  },
);

test(
  "reapStaleRunningJobs flips a stale running row and frees the lock for real",
  { skip: !enabled && skipReason },
  async () => {
    const staleJobType = "webhook-incremental" as const;
    const staleKey = `${shop}:${staleJobType}`;
    await db.dataSyncJob.create({
      data: {
        shop,
        jobType: staleJobType,
        triggeredBy: "webhook",
        status: "running",
        // 远超默认 30 分钟租约，模拟进程被 OOM/部署打断后遗留的死行。
        startedAt: new Date(Date.now() - 2 * 3_600_000),
        activeKey: staleKey,
      },
    });

    const count = await reapStaleRunningJobs(db, shop, new Date());
    assert.ok(count >= 1, "at least the seeded stale row must be reaped");

    const stillRunning = await db.dataSyncJob.findFirst({
      where: { shop, status: "running" },
      select: { id: true },
    });
    assert.equal(stillRunning, null, "no running row may survive the reap");

    const freed = await db.dataSyncJob.findFirst({
      where: { shop, jobType: staleJobType, status: "failed" },
      select: { activeKey: true },
    });
    assert.ok(freed, "reaped row should be failed");
    assert.equal(freed.activeKey, null, "reap must release the lock key");
  },
);

test(
  "an interactive transaction rolls back every write when the callback throws",
  { skip: !enabled && skipReason },
  async () => {
    // 复用应用 withTransaction 的同一预算（P0-3：远程库放宽到 30s/10s）。
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await tx.salesDaily.create({
            data: {
              shop,
              variantId: "gid://shopify/ProductVariant/rollback",
              date: "2026-01-01",
              quantity: 5,
            },
          });
          throw new Error("boom mid-transaction");
        },
        { timeout: 30_000, maxWait: 10_000 },
      ),
      /boom mid-transaction/,
    );

    const persisted = await db.salesDaily.findFirst({
      where: { shop, date: "2026-01-01" },
    });
    assert.equal(
      persisted,
      null,
      "rollback must leave no salesDaily row behind",
    );
  },
);

test(
  "a duplicate requestKey is rejected by the audit unique index (idempotency)",
  { skip: !enabled && skipReason },
  async () => {
    const requestKey = `p16-${process.pid}-${Date.now()}`;
    const base = {
      shop,
      locationId: "loc-1",
      variantId: "gid://shopify/ProductVariant/idempotent",
      action: "accepted",
      toStatus: "accepted",
    };
    await db.recommendationAudit.create({
      data: { ...base, suggestedQuantity: 10, quantity: 10, requestKey },
    });

    await assert.rejects(
      db.recommendationAudit.create({
        data: { ...base, suggestedQuantity: 999, quantity: 999, requestKey },
      }),
      isUniqueViolation,
      "the same request submitted twice must collide on the unique key",
    );

    const rows = await db.recommendationAudit.findMany({
      where: { shop, requestKey },
    });
    assert.equal(rows.length, 1, "exactly one audit row per request key");
    assert.equal(rows[0]?.quantity, 10, "the first write wins");
  },
);

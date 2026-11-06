import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { buildDatasourceUrl } from "../app/lib/db-pool-url.ts";
import { reconcileShopEntities } from "../app/lib/reconcile-core.ts";
import type { ReconcileDelta } from "../app/lib/reconcile-policy.ts";
import { enqueueStandardEvent } from "../app/lib/execution-queue.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

/**
 * 漏投对账 DB 集成测试（P4-13）：一次性 Postgres 上真·验证「补触发不重复执行」。
 * 默认跳过，MYPI_DB_INTEGRATION=1（CI 配好临时库并 migrate deploy 后）才执行。
 * 口径：模拟一条投递被丢弃（无 delivery、无队列行）→ 对账补投一次；二次对账零新增；
 * 并以真实 activeKey 唯一约束证明同指纹无法两度入队（幂等第三层的落库实证）。
 */

const enabled = process.env.MYPI_DB_INTEGRATION === "1";
const skipReason =
  "set MYPI_DB_INTEGRATION=1 against a throwaway DATABASE_URL (runs in CI)";

const tag = `p413-${process.pid}`;
const shopDomain = `${tag}.myshopify.com`;
const entityId = `gid://shopify/Product/${tag}`;

let db: PrismaClient;
let shopId: string;

function productDelta(changedAt: Date): ReconcileDelta {
  const event: StandardEvent = {
    shopDomain,
    topic: "products/update",
    entityType: "Product",
    entityId,
    occurredAt: changedAt,
    data: { status: "ACTIVE" },
  };
  return { event, changedAt };
}

const changedAt = new Date(Date.now() - 5 * 60_000);
const since = new Date(changedAt.getTime() - 60 * 60_000);

before(async () => {
  if (!enabled) return;
  const url = buildDatasourceUrl();
  db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  await db.$connect();
  const shop = await db.shop.create({ data: { shop: shopDomain } });
  shopId = shop.id;
});

after(async () => {
  if (!enabled || !db) return;
  await db.dataSyncJob.deleteMany({ where: { shop: shopDomain } });
  await db.webhookDelivery.deleteMany({ where: { shop: shopDomain } });
  await db.shop.deleteMany({ where: { shop: shopDomain } });
  await db.$disconnect();
});

function t(name: string, fn: () => Promise<void>) {
  test(name, { skip: !enabled && skipReason }, fn);
}

t("投递被丢弃 → 对账补投恰好一次，二次对账零新增", async () => {
  // 前置：库里既无该实体的投递，也无队列行（模拟 webhook 丢投）
  const beforeJobs = await db.dataSyncJob.count({ where: { shop: shopDomain } });
  assert.equal(beforeJobs, 0);

  const first = await reconcileShopEntities(db, {
    shopDomain,
    shopId,
    since,
    deltas: [productDelta(changedAt)],
  });
  assert.equal(first.requeued, 1);

  const queuedAfterFirst = await db.dataSyncJob.count({
    where: { shop: shopDomain, status: "queued" },
  });
  assert.equal(queuedAfterFirst, 1, "补投落了一条待执行队列行");

  // 二次对账：往轮合成键已在投递表 → 不再补，队列仍为 1 行
  const second = await reconcileShopEntities(db, {
    shopDomain,
    shopId,
    since,
    deltas: [productDelta(changedAt)],
  });
  assert.equal(second.requeued, 0);
  assert.equal(second.skipped, 1);
  const queuedAfterSecond = await db.dataSyncJob.count({
    where: { shop: shopDomain, status: "queued" },
  });
  assert.equal(queuedAfterSecond, 1, "对账绝不把同一次变更补成两行");
});

t("同指纹二次入队被 activeKey 唯一约束挡下（幂等第三层落库实证）", async () => {
  const syntheticKey = `reconcile:products/update:${entityId}:${changedAt.toISOString()}`;
  const event = productDelta(changedAt).event;
  // 上面补投已占用该 deliveryId 的 activeKey；同 deliveryId 再入队必须判重
  const again = await enqueueStandardEvent(db, event, {
    deliveryId: syntheticKey,
    shopId,
  });
  assert.equal(again.enqueued, false);
  assert.equal(again.duplicate, true);
});

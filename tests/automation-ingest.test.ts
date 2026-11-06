import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ingestWebhook,
  type IngestClient,
} from "../app/lib/automation-ingest.ts";

/**
 * 统一接收壳单测（P1-07）：验签之后的编排——缺 webhookId 拒、首次受理并入队、
 * 重复投递去重、畸形 payload 拒但不炸、队列与投递表用同一个 deliveryId 作幂等键。
 */

const validOrderPayload = { id: 123, total_price: "99.00" };

function fakeIngestClient(options: {
  duplicateDelivery?: boolean;
  existingShops?: string[];
} = {}) {
  const deliveries = new Set<string>();
  const jobs: { cursor: string; activeKey: string }[] = [];
  const shops = new Set(options.existingShops ?? []);
  const client = {
    shop: {
      findUnique: async ({ where }: { where: { shop: string } }) =>
        shops.has(where.shop)
          ? { id: "shop-existing", shop: where.shop }
          : null,
      create: async ({ data }: { data: { shop: string } }) => {
        shops.add(data.shop);
        return { id: "shop-new", shop: data.shop };
      },
    },
    inventorySettings: { findUnique: async () => null },
    session: { findMany: async () => [] },
    webhookDelivery: {
      create: async ({ data }: { data: { webhookId: string } }) => {
        if (options.duplicateDelivery || deliveries.has(data.webhookId)) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        deliveries.add(data.webhookId);
        return { id: "delivery-1" };
      },
    },
    dataSyncJob: {
      create: async ({ data }: { data: { cursor: string; activeKey: string } }) => {
        jobs.push({ cursor: data.cursor, activeKey: data.activeKey });
        return { id: "job-1" };
      },
    },
  } as unknown as IngestClient;
  return { client, deliveries, jobs, shops };
}

const baseInput = {
  shopDomain: "demo.myshopify.com",
  topic: "orders/create",
  webhookId: "wh-100",
  payload: validOrderPayload,
};

test("合法新投递：受理、建租户、去重登记、以 deliveryId 为键入队", async () => {
  const { client, deliveries, jobs, shops } = fakeIngestClient();
  const outcome = await ingestWebhook(client, baseInput);
  assert.equal(outcome.status, "accepted");
  if (outcome.status !== "accepted") assert.fail();
  assert.equal(outcome.jobId, "job-1");
  assert.equal(outcome.event.entityId, "gid://shopify/Order/123");
  assert.ok(shops.has("demo.myshopify.com"));
  assert.ok(deliveries.has("wh-100"));
  // 队列锁键与投递 id 同源，两层幂等对齐
  assert.equal(jobs[0].activeKey, "automation-execute:d:wh-100");
});

test("缺 webhookId：直接拒绝，不碰任何库", async () => {
  const { client, deliveries, jobs } = fakeIngestClient();
  const outcome = await ingestWebhook(client, { ...baseInput, webhookId: undefined });
  assert.deepEqual(outcome, { status: "rejected", reason: "missing_webhook_id" });
  assert.equal(deliveries.size, 0);
  assert.equal(jobs.length, 0);
});

test("重复投递：duplicate 早退，绝不重复入队", async () => {
  const { client, jobs } = fakeIngestClient({ duplicateDelivery: true });
  const outcome = await ingestWebhook(client, baseInput);
  assert.deepEqual(outcome, { status: "duplicate" });
  assert.equal(jobs.length, 0);
});

test("畸形 payload：投递仍被消费（登记去重），事件拒收且不抛错", async () => {
  const { client, deliveries, jobs } = fakeIngestClient();
  const outcome = await ingestWebhook(client, {
    ...baseInput,
    payload: { note: "没有 id 的坏 payload" },
  });
  assert.deepEqual(outcome, { status: "rejected", reason: "unparsable_payload" });
  assert.ok(deliveries.has("wh-100")); // 已登记，Shopify 重投会走 duplicate 分支
  assert.equal(jobs.length, 0);
});

test("已存在的租户不重复 create", async () => {
  const { client, shops } = fakeIngestClient({ existingShops: ["demo.myshopify.com"] });
  const outcome = await ingestWebhook(client, baseInput);
  assert.equal(outcome.status, "accepted");
  assert.equal(shops.size, 1);
});

test("非唯一约束的库错误照抛，由路由侧 Safely 入口兜住 200", async () => {
  const client = {
    shop: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("db down");
      },
    },
    inventorySettings: { findUnique: async () => null },
  } as unknown as IngestClient;
  await assert.rejects(() => ingestWebhook(client, baseInput), /db down/);
});

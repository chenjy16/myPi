import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliveryTtlCutoff,
  pruneOldDeliveries,
  tryRecordDelivery,
  webhookDeliveryTtlHours,
  type WebhookDeliveryClient,
} from "../app/lib/webhook-delivery.ts";

/**
 * 投递去重单测（P1-06）：假代理如实复现 Prisma 的 P2002 抛错形状，
 * 验证「首次受理 / 重复拒收 / 缺 webhookId 拒收 / 其他错误照抛」四条分支。
 */

const baseInput = {
  shop: "demo.myshopify.com",
  shopId: "shop-1",
  webhookId: "wh-123",
  topic: "orders/create",
};

function fakeClient(options: { createError?: unknown } = {}) {
  const created: unknown[] = [];
  let deleteManyWhere: Record<string, unknown> | undefined;
  const client = {
    webhookDelivery: {
      create: async (args: { data: unknown }) => {
        if (options.createError) throw options.createError;
        created.push(args.data);
        return { id: "delivery-1" };
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        deleteManyWhere = args.where;
        return { count: 7 };
      },
    },
  } as unknown as WebhookDeliveryClient;
  return { client, created, getDeleteManyWhere: () => deleteManyWhere };
}

const p2002 = Object.assign(new Error("Unique constraint failed"), {
  code: "P2002",
});

test("首次投递落库成功，accepted:true 且写入形状正确", async () => {
  const { client, created } = fakeClient();
  const result = await tryRecordDelivery(client, baseInput);
  assert.deepEqual(result, { accepted: true, duplicate: false });
  assert.deepEqual(created, [
    {
      shop: "demo.myshopify.com",
      shopId: "shop-1",
      webhookId: "wh-123",
      topic: "orders/create",
    },
  ]);
});

test("撞 webhookId 唯一约束（P2002）判为重复投递，拒收但不抛错", async () => {
  const { client } = fakeClient({ createError: p2002 });
  const result = await tryRecordDelivery(client, baseInput);
  assert.deepEqual(result, { accepted: false, duplicate: true });
});

test("缺 webhookId 直接拒收，连库都不用", async () => {
  const { client, created } = fakeClient();
  const result = await tryRecordDelivery(client, {
    ...baseInput,
    webhookId: "",
  });
  assert.deepEqual(result, { accepted: false, duplicate: false });
  assert.equal(created.length, 0);
});

test("非 P2002 的数据库错误照抛，绝不当重复投递吞掉", async () => {
  const boom = Object.assign(new Error("connection lost"), { code: "P1001" });
  const { client } = fakeClient({ createError: boom });
  await assert.rejects(() => tryRecordDelivery(client, baseInput), /connection lost/);
});

test("shopId 缺省时写 null，不留下 undefined 洞", async () => {
  const { client, created } = fakeClient();
  await tryRecordDelivery(client, { ...baseInput, shopId: undefined });
  assert.equal((created[0] as { shopId: unknown }).shopId, null);
});

test("prune 按 receivedAt < before 删除并回传条数", async () => {
  const { client, getDeleteManyWhere } = fakeClient();
  const before = new Date("2026-11-04T00:00:00Z");
  const count = await pruneOldDeliveries(client, before);
  assert.equal(count, 7);
  assert.deepEqual(getDeleteManyWhere(), { receivedAt: { lt: before } });
});

test("TTL 窗口：默认 24h，env 覆盖生效，非法回退默认，上限 7 天", () => {
  const original = process.env.WEBHOOK_DELIVERY_TTL_HOURS;
  try {
    delete process.env.WEBHOOK_DELIVERY_TTL_HOURS;
    assert.equal(webhookDeliveryTtlHours(), 24);

    process.env.WEBHOOK_DELIVERY_TTL_HOURS = "6";
    assert.equal(webhookDeliveryTtlHours(), 6);

    process.env.WEBHOOK_DELIVERY_TTL_HOURS = "0";
    assert.equal(webhookDeliveryTtlHours(), 24);
    process.env.WEBHOOK_DELIVERY_TTL_HOURS = "not-a-number";
    assert.equal(webhookDeliveryTtlHours(), 24);

    process.env.WEBHOOK_DELIVERY_TTL_HOURS = "9999";
    assert.equal(webhookDeliveryTtlHours(), 24 * 7);
  } finally {
    if (original === undefined) delete process.env.WEBHOOK_DELIVERY_TTL_HOURS;
    else process.env.WEBHOOK_DELIVERY_TTL_HOURS = original;
  }
});

test("cutoff = now - TTL 窗口，注入时钟保证确定性", () => {
  const original = process.env.WEBHOOK_DELIVERY_TTL_HOURS;
  try {
    process.env.WEBHOOK_DELIVERY_TTL_HOURS = "24";
    const now = new Date("2026-11-05T12:00:00Z");
    assert.deepEqual(
      deliveryTtlCutoff(now),
      new Date("2026-11-04T12:00:00Z"),
    );
  } finally {
    if (original === undefined) delete process.env.WEBHOOK_DELIVERY_TTL_HOURS;
    else process.env.WEBHOOK_DELIVERY_TTL_HOURS = original;
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseReconcileConfig,
  reconcileWindow,
  reconcileDedupeKey,
  isReconcileWebhookId,
  planRequeue,
  type ReconcileDelta,
} from "../app/lib/reconcile-policy.ts";
import {
  reconcileShopEntities,
  type ReconcileClient,
} from "../app/lib/reconcile-core.ts";
import type { StandardEvent } from "../app/lib/event-normalizer.ts";

const GID = "gid://shopify/Product/";

function delta(
  entityId: string,
  changedAt: Date,
  overrides: Partial<StandardEvent> = {},
): ReconcileDelta {
  const event: StandardEvent = {
    shopDomain: "a.myshopify.com",
    topic: "products/update",
    entityType: "Product",
    entityId: `${GID}${entityId}`,
    occurredAt: changedAt,
    data: { status: "ACTIVE" },
    ...overrides,
  };
  return { event, changedAt };
}

test("parseReconcileConfig：默认关、30 分钟一轮、回看不小于轮距", () => {
  const off = parseReconcileConfig({});
  assert.deepEqual(off, { enabled: false, intervalMinutes: 30, lookbackMinutes: 60 });
  const on = parseReconcileConfig({ RECONCILE_ENABLED: "true" });
  assert.equal(on.enabled, true);
  // 轮距放大 → 回看窗至少跟着放大到 interval*2
  assert.equal(parseReconcileConfig({ RECONCILE_INTERVAL_MINUTES: "10" }).lookbackMinutes, 20);
  // 非法值回退默认，绝不产生 NaN 窗
  assert.equal(parseReconcileConfig({ RECONCILE_INTERVAL_MINUTES: "abc" }).intervalMinutes, 30);
});

test("reconcileWindow：since = now − 回看分钟，until = 注入时钟", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const { since, until } = reconcileWindow(now, 60);
  assert.equal(until.toISOString(), now.toISOString());
  assert.equal(since.toISOString(), "2026-06-01T11:00:00.000Z");
});

test("reconcileDedupeKey：同一变更恒定；无 entityId 返回 null（不可补）", () => {
  const at = new Date("2026-06-01T10:00:00Z");
  const key = reconcileDedupeKey(delta("77", at));
  assert.equal(key, `reconcile:products/update:${GID}77:${at.toISOString()}`);
  assert.equal(key, reconcileDedupeKey(delta("77", at)), "确定性：两次计算一致");
  assert.notEqual(key, reconcileDedupeKey(delta("78", at)));
  assert.equal(reconcileDedupeKey(delta("77", at, { entityId: null })), null);
  assert.ok(isReconcileWebhookId(key!));
  assert.ok(!isReconcileWebhookId("0f1c-real-shopify-id"));
});

test("planRequeue：跳过往轮已补与已被执行覆盖，保留真正漏网", () => {
  const at = new Date("2026-06-01T10:00:00Z");
  const dPrior = delta("1", at);
  const dHandled = delta("2", at);
  const dStaleExec = delta("3", at); // 执行早于变更 → 这次变更没被处理过，应补
  const dMissing = delta("4", at);
  const missing = planRequeue({
    deltas: [dPrior, dHandled, dStaleExec, dMissing],
    priorReconcileKeys: new Set([reconcileDedupeKey(dPrior)!]),
    handledByEntity: new Map<string, Date>([
      [`${GID}2`, at], // 同刻执行 → 覆盖
      [`${GID}3`, new Date(at.getTime() - 60_000)], // 早 1 分钟 → 未覆盖
    ]),
  });
  assert.deepEqual(
    missing.map((d) => d.event.entityId),
    [`${GID}3`, `${GID}4`],
  );
});

// —— 假 ReconcileClient：webhookDelivery / dataSyncJob 唯一约束如实复现 ——

function uniqueError() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function makeClient(seed: {
  deliveries?: { webhookId: string; shop: string; receivedAt: Date }[];
  logs?: { entityRef: string | null; createdAt: Date; shopId: string }[];
}) {
  const deliveries = new Map(
    (seed.deliveries ?? []).map((d) => [d.webhookId, d]),
  );
  const jobs = new Map<string, { activeKey: string; cursor: string }>();
  let jobSeq = 0;
  const client: ReconcileClient = {
    webhookDelivery: {
      findMany: async ({ where }: { where: { shop: string; receivedAt: { gte: Date } } }) =>
        [...deliveries.values()]
          .filter((d) => d.shop === where.shop && d.receivedAt >= where.receivedAt.gte)
          .map((d) => ({ webhookId: d.webhookId })),
      create: async ({ data }: { data: { webhookId: string; shop: string } }) => {
        if (deliveries.has(data.webhookId)) throw uniqueError();
        deliveries.set(data.webhookId, {
          webhookId: data.webhookId,
          shop: data.shop,
          receivedAt: new Date(),
        });
      },
    },
    executionLog: {
      findMany: async ({ where }: { where: { shopId: string; createdAt: { gte: Date } } }) =>
        (seed.logs ?? []).filter(
          (l) => l.shopId === where.shopId && l.createdAt >= where.createdAt.gte,
        ),
    },
    dataSyncJob: {
      create: async ({ data }: { data: { activeKey: string; cursor: string } }) => {
        if (jobs.has(data.activeKey)) throw uniqueError();
        const id = `job_${(jobSeq += 1)}`;
        jobs.set(data.activeKey, { activeKey: data.activeKey, cursor: data.cursor });
        return { id };
      },
    },
  } as unknown as ReconcileClient;
  return { client, deliveries, jobs };
}

const SINCE = new Date("2026-06-01T00:00:00Z");

test("reconcileShopEntities：只补漏网项，且同变更二次对账不重复入队", async () => {
  const at = new Date("2026-06-01T10:00:00Z");
  const { client, jobs, deliveries } = makeClient({ logs: [] });
  const input = {
    shopDomain: "a.myshopify.com",
    shopId: "shop_1",
    since: SINCE,
    deltas: [delta("42", at)],
  };

  const first = await reconcileShopEntities(client, input);
  assert.equal(first.requeued, 1);
  assert.deepEqual(first.requeuedKeys, [`reconcile:products/update:${GID}42:${at.toISOString()}`]);
  assert.equal(jobs.size, 1, "补投落了一条队列行");
  assert.equal(deliveries.size, 1, "合成投递键已登记");

  // 第二轮同样变更：往轮合成键已在投递表 → planRequeue 直接跳过，零新增
  const second = await reconcileShopEntities(client, input);
  assert.equal(second.requeued, 0);
  assert.equal(second.skipped, 1);
  assert.equal(jobs.size, 1, "绝不因对账把同一变更跑两遍");
});

test("reconcileShopEntities：窗内已有执行覆盖的实体不再补投", async () => {
  const at = new Date("2026-06-01T10:00:00Z");
  const { client, jobs } = makeClient({
    logs: [{ shopId: "shop_1", entityRef: `${GID}42`, createdAt: at }],
  });
  const result = await reconcileShopEntities(client, {
    shopDomain: "a.myshopify.com",
    shopId: "shop_1",
    since: SINCE,
    deltas: [delta("42", at)],
  });
  assert.equal(result.requeued, 0);
  assert.equal(jobs.size, 0);
});

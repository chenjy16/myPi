import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { buildDatasourceUrl } from "../app/lib/db-pool-url.ts";
import { compile } from "../app/lib/automation-compiler.ts";
import {
  getAutomation,
  setActive,
  softDelete,
  AutomationNotFoundError,
} from "../app/lib/automations-core.ts";
import { getExecutionDetail, listExecutions } from "../app/lib/activity.ts";
import {
  deleteIntegration,
  listIntegrations,
  IntegrationNotFoundError,
} from "../app/lib/integrations-core.ts";
import { retryExecution, confirmStep, type RetryDeps } from "../app/lib/automation-retry.ts";
import { matchAutomations } from "../app/automation-matcher.server.ts";
import {
  claimNextEvent,
  enqueueStandardEvent,
} from "../app/lib/execution-queue.ts";
import { ingestWebhook } from "../app/lib/automation-ingest.ts";

/**
 * 跨租户渗透测试（P4-04，E2E 场景 F 的自动化面）：一次性 Postgres 上真·DB 验证。
 * 默认跳过，MYPI_DB_INTEGRATION=1（CI 配好临时库并 migrate deploy 后）才执行。
 * 口径：A 店资源 id 从 B 店句柄访问——服务核心必须一律「视同不存在」，且零写、零出站；
 * HMAC 验签本身由 authenticate.webhook 在库层完成（伪造头到不了这里），
 * 本文件验证的是它之后我们自己的作用域面。
 */

const enabled = process.env.MYPI_DB_INTEGRATION === "1";
const skipReason =
  "set MYPI_DB_INTEGRATION=1 against a throwaway DATABASE_URL (runs in CI)";

const tag = `p404-${process.pid}`;
const shopADomain = `${tag}-a.myshopify.com`;
const shopBDomain = `${tag}-b.myshopify.com`;

let db: PrismaClient;
let shopAId: string;
let shopBId: string;
let autoAId: string;
let execAId: string;
let awaitingStepId: string;
let integAId: string;

/** 一个可被 matcher 消费的合法编译计划（inventory.low → 打标）。 */
const planInventoryLow = compile({
  dslVersion: "2.0",
  name: "渗透测试自动化",
  status: "active",
  trigger: {
    type: "inventory.low",
    source: "shopify.webhook+reconcile",
    topic: "inventory_levels/update",
  },
  conditions: { logic: "AND", clauses: [] },
  actions: [{ actionId: "tags.add", params: { tag: "restock" } }],
});

/** 任何一次被调用的 admin.graphql 都视为跨店副作用——直接炸给测试看。 */
function forbiddenAdmin(): RetryDeps["admin"] {
  return {
    graphql: async () => {
      throw new Error("cross-shop access must never reach Shopify");
    },
  } as unknown as RetryDeps["admin"];
}

before(async () => {
  if (!enabled) return;
  const url = buildDatasourceUrl();
  db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  await db.$connect();

  const shopA = await db.shop.create({ data: { shop: shopADomain } });
  const shopB = await db.shop.create({ data: { shop: shopBDomain } });
  shopAId = shopA.id;
  shopBId = shopB.id;

  const automation = await db.automation.create({
    data: { shopId: shopAId, name: "A 店自动化", status: "active" },
  });
  const version = await db.automationVersion.create({
    data: {
      automationId: automation.id,
      version: 1,
      definition: planInventoryLow as unknown as object,
      templateId: "T4-low-stock",
    },
  });
  await db.automation.update({
    where: { id: automation.id },
    data: { currentVersionId: version.id },
  });
  autoAId = automation.id;

  const exec = await db.executionLog.create({
    data: {
      shopId: shopAId,
      automationId: automation.id,
      automationVersion: 1,
      triggerType: "inventory.low",
      status: "PARTIAL_SUCCESS",
      entityRef: "gid://shopify/Product/900",
      payload: { topic: "inventory_levels/update" },
    },
  });
  execAId = exec.id;
  const step = await db.executionStep.create({
    data: {
      executionId: exec.id,
      order: 0,
      actionId: "product.updateStatus",
      status: "AWAITING_CONFIRMATION",
    },
  });
  awaitingStepId = step.id;

  const integration = await db.integration.create({
    data: {
      shopId: shopAId,
      kind: "CUSTOM_WEBHOOK",
      config: { url: "https://example.com/hook" },
      secretsEncrypted: "never-plaintext",
    },
  });
  integAId = integration.id;
});

after(async () => {
  if (!enabled || !db) return;
  await db.dataSyncJob.deleteMany({ where: { shop: { in: [shopADomain, shopBDomain] } } });
  await db.webhookDelivery.deleteMany({ where: { shop: { in: [shopADomain, shopBDomain] } } });
  // Shop 行 Cascade 带走 automation/version/execution/step/integration/delivery。
  await db.shop.deleteMany({ where: { shop: { in: [shopADomain, shopBDomain] } } });
  await db.$disconnect();
});

function t(name: string, fn: () => Promise<void>) {
  test(name, { skip: !enabled && skipReason }, fn);
}

t("自动化面：B 店句柄读/改/删 A 店 automation 一律视同不存在", async () => {
  await assert.rejects(
    () => getAutomation(db, shopBId, autoAId),
    AutomationNotFoundError,
  );
  await assert.rejects(() => setActive(db, shopBId, autoAId), AutomationNotFoundError);
  await assert.rejects(() => softDelete(db, shopBId, autoAId), AutomationNotFoundError);
  // A 店本体未受任何影响
  const untouched = await db.automation.findUnique({ where: { id: autoAId } });
  assert.equal(untouched?.status, "active");
});

t("执行面：B 店读 A 店执行详情为 null，列表不见 A 店记录", async () => {
  assert.equal(await getExecutionDetail(db, shopBId, execAId), null);
  const page = await listExecutions(db, shopBId);
  assert.equal(page.items.length, 0);
});

t("重试/确认：B 店拿 A 店 id → not_found 且零副作用（不落子记录、不改挂起步）", async () => {
  const admin = forbiddenAdmin();
  const retried = await retryExecution(
    { client: db, admin },
    { shopId: shopBId, executionId: execAId },
  );
  assert.deepEqual(retried, { status: "not_found" });

  const confirmed = await confirmStep(
    { client: db, admin },
    { shopId: shopBId, stepId: awaitingStepId },
  );
  assert.deepEqual(confirmed, { status: "not_found" });

  const childCount = await db.executionLog.count({
    where: { parentExecutionId: execAId },
  });
  assert.equal(childCount, 0, "跨店重试绝不能留下子执行");
  const step = await db.executionStep.findUnique({ where: { id: awaitingStepId } });
  assert.equal(step?.status, "AWAITING_CONFIRMATION");
});

t("连接面：B 店列表不见 A 店 Integration，删除/读取跨店抛 NotFound", async () => {
  const rows = await listIntegrations(db, shopBId);
  assert.equal(rows.length, 0);
  await assert.rejects(
    () => deleteIntegration(db, shopBId, integAId),
    IntegrationNotFoundError,
  );
  const stillThere = await db.integration.findUnique({ where: { id: integAId } });
  assert.ok(stillThere, "A 店连接不能被 B 店删除");
});

t("引擎匹配：B 店事件不会命中 A 店自动化", async () => {
  const matchesB = await matchAutomations(db, shopBId, "inventory.low");
  assert.equal(matchesB.length, 0);
  const matchesA = await matchAutomations(db, shopAId, "inventory.low");
  assert.equal(matchesA.length, 1, "对照：本店能命中");
});

t("队列：B 店 worker 认领绝不消费 A 店事件", async () => {
  const event = {
    shopDomain: shopADomain,
    topic: "inventory_levels/update",
    entityType: "ProductVariant",
    entityId: "gid://shopify/ProductVariant/1",
    occurredAt: new Date(),
    data: { available: 1 },
  };
  const enq = await enqueueStandardEvent(db, event, { deliveryId: `${tag}-wh-1` });
  assert.ok(enq.enqueued);

  assert.equal(await claimNextEvent(db, shopBDomain), null, "B 店句柄认领不到");
  const claimed = await claimNextEvent(db, shopADomain);
  assert.ok(claimed, "A 店句柄认领成功");
  assert.equal(claimed.event.shopDomain, shopADomain);
});

t("接收面：缺 X-Shopify-Webhook-Id 的投递直接拒收，不落任何账", async () => {
  const outcome = await ingestWebhook(db, {
    shopDomain: shopBDomain,
    topic: "inventory_levels/update",
    webhookId: null,
    payload: { id: 1, available: 0 },
  });
  assert.deepEqual(outcome, { status: "rejected", reason: "missing_webhook_id" });
  const deliveries = await db.webhookDelivery.count({ where: { shop: shopBDomain } });
  assert.equal(deliveries, 0);
});

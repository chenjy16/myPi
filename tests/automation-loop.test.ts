import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeLoopGuard,
  resolveCascadeDepth,
  type LoopCountClient,
} from "../app/automation-loop.server.ts";
import type { LoopCheckInput } from "../app/lib/loop-protector.ts";

const NOW = new Date("2026-11-05T10:00:00.000Z");

// 假 executionLog：count 按 where 里是否有 dedupeKey 分流返回「重复数 / 限次数」；findFirst 返回父执行。
function fakeClient(opts: { dup?: number; recent?: number; parent?: { cascadeDepth: number } | null }) {
  const countWheres: Record<string, unknown>[] = [];
  let findFirstCalled = 0;
  let lastFindWhere: Record<string, unknown> | undefined;
  const client = {
    executionLog: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        countWheres.push(where);
        return "dedupeKey" in where ? (opts.dup ?? 0) : (opts.recent ?? 0);
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        findFirstCalled += 1;
        lastFindWhere = where;
        return opts.parent ?? null;
      },
    },
  } as unknown as LoopCountClient;
  return {
    client,
    countWheres,
    findCalls: () => findFirstCalled,
    lastFindWhere: () => lastFindWhere,
  };
}

function baseInput(overrides: Partial<LoopCheckInput> = {}): LoopCheckInput {
  return {
    automationId: "auto_1",
    entityType: "Product",
    entityId: "gid://shopify/Product/5",
    keyFields: { available: 2 },
    cascadeDepth: 0,
    duplicateCountInWindow: 0,
    executionsInWindow: 0,
    now: NOW,
    ...overrides,
  };
}

test("守卫·首次：窗内无重复无执行→allow", async () => {
  const { client, countWheres } = fakeClient({ dup: 0, recent: 0 });
  const guard = makeLoopGuard(client, { shopId: "shop_1" });
  const verdict = await guard(baseInput());
  assert.equal(verdict.decision, "allow");
  assert.equal(countWheres.length, 2, "查了重复数与限次数各一次");
});

test("守卫·同指纹重复→block（可靠去重层，窗内已落账）", async () => {
  const { client, countWheres } = fakeClient({ dup: 1, recent: 0 });
  const guard = makeLoopGuard(client, { shopId: "shop_1" });
  const verdict = await guard(baseInput());
  assert.equal(verdict.decision, "block");
  if (verdict.decision !== "block") return;
  assert.match(verdict.reason, /duplicate event fingerprint/);
  // 重复计数按 dedupeKey（指纹）查，非时间窗
  assert.ok("dedupeKey" in countWheres[0]);
});

test("守卫·同实体超限次→throttle（限流窗，非硬断）", async () => {
  const { client } = fakeClient({ dup: 0, recent: 6 }); // rateLimitCount 默认 5
  const guard = makeLoopGuard(client, { shopId: "shop_1" });
  const verdict = await guard(baseInput());
  assert.equal(verdict.decision, "throttle");
  if (verdict.decision !== "throttle") return;
  assert.match(verdict.reason, /rate limit/);
});

test("守卫·级联深度超限优先于一切→block", async () => {
  const { client } = fakeClient({ dup: 0, recent: 0 });
  const guard = makeLoopGuard(client, { shopId: "shop_1" });
  const verdict = await guard(baseInput({ cascadeDepth: 4 })); // maxDepth 默认 3
  assert.equal(verdict.decision, "block");
  if (verdict.decision !== "block") return;
  assert.match(verdict.reason, /cascade depth/);
});

test("resolveCascadeDepth·无父执行→根事件 0", async () => {
  const { client, lastFindWhere } = fakeClient({ parent: null });
  const depth = await resolveCascadeDepth(client, {
    shopId: "shop_1",
    entityId: "gid://shopify/Product/5",
    now: NOW,
  });
  assert.equal(depth, 0);
  // SKIPPED 执行不构成链路，须排除
  assert.deepEqual((lastFindWhere() as { status?: unknown }).status, { not: "SKIPPED" });
});

test("resolveCascadeDepth·关联到深度 2 的父执行→子深度 3", async () => {
  const { client } = fakeClient({ parent: { cascadeDepth: 2 } });
  const depth = await resolveCascadeDepth(client, {
    shopId: "shop_1",
    entityId: "gid://shopify/Product/5",
    now: NOW,
  });
  assert.equal(depth, 3);
});

test("resolveCascadeDepth·事件无实体→0 且不查库（不臆测链路）", async () => {
  const { client, findCalls } = fakeClient({ parent: { cascadeDepth: 9 } });
  const depth = await resolveCascadeDepth(client, {
    shopId: "shop_1",
    entityId: null,
    now: NOW,
  });
  assert.equal(depth, 0);
  assert.equal(findCalls(), 0, "无实体直接返回，绝不发起 findFirst");
});

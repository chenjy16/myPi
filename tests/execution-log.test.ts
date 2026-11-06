import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateStatus,
  appendStep,
  createExecutionLog,
  finalizeStatus,
  type ExecutionClient,
  type NewExecutionLog,
  type StepStatus,
} from "../app/lib/execution-log.ts";

/**
 * 执行记录落库原语单测（P1-12）：dedupeKey 撞账返回 null、步骤聚合规则表、
 * finalize 读步骤→回写终态的编排，全用假代理验证，不连库。
 */

const baseLog: NewExecutionLog = {
  shopId: "shop-1",
  automationId: "auto-1",
  automationVersion: 3,
  triggerType: "inventory.low",
  status: "RETRYING",
};

function fakeClient(options: {
  createError?: unknown;
  steps?: { status: string }[];
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const client = {
    executionLog: {
      create: async (args: unknown) => {
        calls.push({ op: "log.create", args });
        if (options.createError) throw options.createError;
        return { id: "exec-1" };
      },
      update: async (args: unknown) => {
        calls.push({ op: "log.update", args });
        return { id: "exec-1" };
      },
    },
    executionStep: {
      create: async (args: unknown) => {
        calls.push({ op: "step.create", args });
        return { id: "step-1" };
      },
      findMany: async () => options.steps ?? [],
    },
  } as unknown as ExecutionClient;
  return { client, calls };
}

const p2002 = Object.assign(new Error("Unique constraint failed"), {
  code: "P2002",
});

test("createExecutionLog 正常落账并返回 id", async () => {
  const { client, calls } = fakeClient();
  const log = await createExecutionLog(client, baseLog);
  assert.deepEqual(log, { id: "exec-1" });
  const args = calls[0].args as { data: Record<string, unknown> };
  assert.equal(args.data.cascadeDepth, 0); // 缺省补 0
  assert.equal(args.data.entityRef, null); // undefined 洞落成 null
});

test("给了 dedupeKey 且撞唯一约束：返回 null 让上层跳过，不重复执行", async () => {
  const { client } = fakeClient({ createError: p2002 });
  const log = await createExecutionLog(client, {
    ...baseLog,
    dedupeKey: "evt-42",
  });
  assert.equal(log, null);
});

test("没给 dedupeKey 时 P2002 不是去重信号，照抛", async () => {
  const { client } = fakeClient({ createError: p2002 });
  await assert.rejects(() => createExecutionLog(client, baseLog));
});

test("appendStep 透传写入并返回 id", async () => {
  const { client, calls } = fakeClient();
  const step = await appendStep(client, {
    executionId: "exec-1",
    order: 2,
    actionId: "tags.add",
    status: "AWAITING_CONFIRMATION",
  });
  assert.deepEqual(step, { id: "step-1" });
  const args = calls[0].args as { data: Record<string, unknown> };
  assert.equal(args.data.status, "AWAITING_CONFIRMATION");
  assert.equal(args.data.errorText, null);
});

function statuses(...list: StepStatus[]) {
  return list.map((status) => ({ status }));
}

test("aggregateStatus 规则表：失败/待确认/全成功/空 四类终态", () => {
  // 有失败（含 UNKNOWN）：有成功→部分成功，否则失败
  assert.equal(aggregateStatus(statuses("FAILED", "UNKNOWN")), "FAILED");
  assert.equal(
    aggregateStatus(statuses("SUCCESS", "FAILED")),
    "PARTIAL_SUCCESS",
  );
  assert.equal(
    aggregateStatus(statuses("SUCCESS", "UNKNOWN")),
    "PARTIAL_SUCCESS",
  );
  // 无失败但有挂起/待确认：有成功→部分成功，否则视为跳过
  assert.equal(
    aggregateStatus(statuses("SUCCESS", "AWAITING_CONFIRMATION")),
    "PARTIAL_SUCCESS",
  );
  assert.equal(aggregateStatus(statuses("PENDING")), "SKIPPED");
  assert.equal(aggregateStatus(statuses("AWAITING_CONFIRMATION")), "SKIPPED");
  // 全成功/跳过
  assert.equal(aggregateStatus(statuses("SUCCESS", "SKIPPED")), "SUCCESS");
  assert.equal(aggregateStatus(statuses("SUCCESS")), "SUCCESS");
  assert.equal(aggregateStatus(statuses("SKIPPED")), "SKIPPED");
  // 空步骤：没有任何动作发生
  assert.equal(aggregateStatus([]), "SKIPPED");
});

test("finalizeStatus 读步骤（按 order 升序）聚合后回写并返回终态", async () => {
  const { client, calls } = fakeClient({
    steps: [{ status: "SUCCESS" }, { status: "FAILED" }],
  });
  const status = await finalizeStatus(client, "exec-1");
  assert.equal(status, "PARTIAL_SUCCESS");
  assert.equal(calls[0].op, "log.update");
  const update = calls[0].args as {
    where: { id: string };
    data: { status: string };
  };
  assert.deepEqual(update.where, { id: "exec-1" });
  assert.equal(update.data.status, "PARTIAL_SUCCESS");
});

test("finalizeStatus：零步骤回写 SKIPPED（触发后被条件拦截的常态）", async () => {
  const { client, calls } = fakeClient({ steps: [] });
  const status = await finalizeStatus(client, "exec-1");
  assert.equal(status, "SKIPPED");
  const update = calls[0].args as { data: { status: string } };
  assert.equal(update.data.status, "SKIPPED");
});

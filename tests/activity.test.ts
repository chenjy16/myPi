import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listExecutions,
  listExecutionRows,
  getExecutionDetail,
  awaitingConfirmationCount,
  buildHumanSummary,
  type ActivityClient,
} from "../app/lib/activity.ts";

// P3-06 服务测（脱库）：过滤 / 游标分页稳定 / 血缘 / 摘要 / 跨店隔离。

type LogRow = Record<string, unknown> & {
  id: string;
  shopId: string;
  automationId: string;
  createdAt: Date;
};
type StepRow = Record<string, unknown> & {
  id: string;
  executionId: string;
  order: number;
  status: string;
};

function makeFakeDb(logs: LogRow[], steps: StepRow[]) {
  const execById = new Map(logs.map((l) => [l.id, l]));

  const matchField = (actual: unknown, cond: unknown): boolean => {
    if (cond instanceof Date && actual instanceof Date)
      return actual.getTime() === cond.getTime();
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      for (const [op, val] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "lt" && !(actual! < val!)) return false;
        if (op === "lte" && !(actual! <= val!)) return false;
        if (op === "gt" && !(actual! > val!)) return false;
        if (op === "gte" && !(actual! >= val!)) return false;
        if (op === "not" && actual === val) return false;
        if (op === "in" && !Array.isArray(val)) return false;
        if (op === "in" && !(val as unknown[]).includes(actual)) return false;
      }
      return true;
    }
    return actual === cond;
  };

  const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === "OR") {
        const branches = v as Record<string, unknown>[];
        if (!branches.some((b) => matchWhere(row, b))) return false;
        continue;
      }
      if (k === "execution") {
        const exec = execById.get(row.executionId as string);
        const want = (v as { shopId?: string }).shopId;
        if (want && exec?.shopId !== want) return false;
        continue;
      }
      if (!matchField(row[k], v)) return false;
    }
    return true;
  };

  const sortRows = <T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] => {
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, string>[];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [key, dir] = Object.entries(spec)[0];
        const av = a[key];
        const bv = b[key];
        let cmp = 0;
        if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
        else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };

  const client = {
    executionLog: {
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) {
        let rows = logs.filter((l) => matchWhere(l, where));
        rows = sortRows(rows, orderBy ?? { createdAt: "desc" });
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        const rows = logs.filter((l) => matchWhere(l, where));
        return rows[0] ? { ...rows[0] } : null;
      },
    },
    executionStep: {
      async findMany({ where, orderBy, select }: { where?: Record<string, unknown>; orderBy?: unknown; select?: unknown }) {
        let rows = steps.filter((s) => matchWhere(s, where));
        rows = sortRows(rows, orderBy ?? { order: "asc" });
        return rows.map((r) => (select ? { executionId: r.executionId } : { ...r }));
      },
    },
  };
  return client as unknown as ActivityClient;
}

function log(over: Partial<LogRow> & { id: string }): LogRow {
  return {
    shopId: "shop-1",
    automationId: "a1",
    automationVersion: 1,
    triggerType: "order.paid",
    entityRef: null,
    status: "SUCCESS",
    cascadeDepth: 0,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    parentExecutionId: null,
    conditionResult: null,
    ...over,
  };
}

test("listExecutions filters by status / automation / entity", async () => {
  const logs = [
    log({ id: "e1", status: "SUCCESS", automationId: "a1", entityRef: "gid://orders/1" }),
    log({ id: "e2", status: "FAILED", automationId: "a1", entityRef: "gid://orders/2" }),
    log({ id: "e3", status: "SUCCESS", automationId: "a2", entityRef: "gid://orders/3" }),
  ];
  const client = makeFakeDb(logs, []);
  assert.equal((await listExecutions(client, "shop-1", { status: "SUCCESS" })).items.length, 2);
  assert.equal((await listExecutions(client, "shop-1", { automationId: "a2" })).items.length, 1);
  assert.equal(
    (await listExecutions(client, "shop-1", { entityRef: "gid://orders/2" })).items[0].id,
    "e2",
  );
});

test("cursor pagination is stable and non-overlapping", async () => {
  const logs = Array.from({ length: 5 }, (_, i) =>
    log({ id: `e${i}`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)) }),
  );
  const client = makeFakeDb(logs, []);
  const seen: string[] = [];
  let cursor: string | null | undefined = undefined;
  let pages = 0;
  for (;;) {
    const page = await listExecutions(client, "shop-1", { limit: 2, cursor });
    pages += 1;
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    assert.ok(pages < 10, "should terminate");
  }
  assert.deepEqual(seen, ["e4", "e3", "e2", "e1", "e0"]); // desc, 全序无重复
  assert.equal(pages, 3);
});

test("getExecutionDetail returns ordered steps + lineage + conditionResult", async () => {
  const conditionResult = { result: true, logic: "AND", clauses: [{ field: "total_price", op: "greater_than_or_equal", expected: 500, actual: 600, pass: true }] };
  const logs = [
    log({ id: "parent", status: "SUCCESS", createdAt: new Date("2024-01-01T00:00:00Z") }),
    log({ id: "child", status: "SUCCESS", parentExecutionId: "parent", createdAt: new Date("2024-01-02T00:00:00Z"), conditionResult }),
  ];
  const steps = [
    { id: "s2", executionId: "child", order: 2, actionId: "email.send", status: "SUCCESS", result: null, errorText: null },
    { id: "s1", executionId: "child", order: 1, actionId: "tags.add", status: "SUCCESS", result: null, errorText: null },
    { id: "sp", executionId: "parent", order: 1, actionId: "tags.add", status: "SUCCESS", result: null, errorText: null },
  ];
  const client = makeFakeDb(logs as unknown as LogRow[], steps as StepRow[]);
  const detail = await getExecutionDetail(client, "shop-1", "child");
  assert.ok(detail);
  assert.deepEqual(detail!.steps.map((s) => s.order), [1, 2]); // ordered asc
  assert.equal(detail!.parent?.id, "parent");
  assert.equal(detail!.conditionResult?.clauses[0].field, "total_price");

  const parent = await getExecutionDetail(client, "shop-1", "parent");
  assert.equal(parent!.children.map((c) => c.id).includes("child"), true);
});

test("cross-shop detail and list are isolated", async () => {
  const client = makeFakeDb([log({ id: "e1" })], []);
  assert.equal(await getExecutionDetail(client, "shop-2", "e1"), null);
  assert.equal((await listExecutions(client, "shop-2", {})).items.length, 0);
});

test("buildHumanSummary reflects success / partial / skipped / awaiting", () => {
  const base = log({ id: "x", entityRef: "gid://orders/1042" });
  const step = (status: string, actionId = "tags.add") => ({ id: "s", order: 1, actionId, status, result: null, errorText: null });
  assert.match(
    buildHumanSummary(base as never, [step("SUCCESS")]),
    /paid order #1042 → added a tag, success 1\/1/,
  );
  assert.match(
    buildHumanSummary({ ...base, status: "PARTIAL_SUCCESS" } as never, [step("SUCCESS"), step("FAILED", "email.send")]),
    /1 failed/,
  );
  assert.match(buildHumanSummary({ ...base, status: "SKIPPED" } as never, []), /didn't meet the conditions/);
  assert.match(buildHumanSummary({ ...base, status: "RUNNING" } as never, [step("AWAITING_CONFIRMATION")]), /waiting for you to confirm/);
});

test("awaitingConfirmationCount counts distinct executions with an awaiting step", async () => {
  const logs = [log({ id: "e1" }), log({ id: "e2" }), log({ id: "e3" })];
  const steps = [
    { id: "s1", executionId: "e1", order: 1, status: "AWAITING_CONFIRMATION" },
    { id: "s2", executionId: "e1", order: 2, status: "AWAITING_CONFIRMATION" }, // same execution → count once
    { id: "s3", executionId: "e3", order: 1, status: "AWAITING_CONFIRMATION" },
    { id: "s4", executionId: "e2", order: 1, status: "SUCCESS" },
  ];
  const client = makeFakeDb(logs, steps as unknown as StepRow[]);
  assert.equal(await awaitingConfirmationCount(client, "shop-1"), 2);
});

test("listExecutionRows attaches per-row steps + human summary in one batch", async () => {
  const logs = [
    log({ id: "e1", status: "SUCCESS", entityRef: "gid://orders/1042" }),
    log({ id: "e2", status: "FAILED" }),
  ];
  const stepRows = [
    { id: "s1", executionId: "e1", order: 1, status: "SUCCESS", actionId: "tags.add", result: null, errorText: null },
    { id: "s2", executionId: "e2", order: 1, status: "FAILED", actionId: "email.send", result: null, errorText: "not configured" },
  ];
  const client = makeFakeDb(logs, stepRows as unknown as StepRow[]);
  const page = await listExecutionRows(client, "shop-1", { limit: 10 });
  assert.equal(page.items.length, 2);
  const e1 = page.items.find((i) => i.id === "e1")!;
  assert.equal(e1.steps.length, 1);
  assert.match(e1.summary, /added a tag/);
  assert.equal(e1.steps[0]!.actionId, "tags.add");
});

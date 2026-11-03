import assert from "node:assert/strict";
import { test } from "node:test";
import { adminGraphql } from "../app/lib/admin-graphql.server.ts";
import { AppError } from "../app/lib/app-error.ts";

/** 只用到 graphql 一个方法，按结构满足即可，避免在测试里引入 Shopify 运行时类型。 */
type FakeAdmin = {
  graphql: (
    operation: string,
    options?: { tries?: number; variables?: Record<string, unknown> },
  ) => Promise<Response>;
};
const asAdmin = (fake: FakeAdmin) =>
  adminGraphql<{ ok: boolean }>(
    fake as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
  );

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 记录被调用的等待时长；不真的 sleep，测试保持确定与瞬时。 */
function waitRecorder(): { calls: number[]; wait: (ms: number) => Promise<void> } {
  const calls: number[] = [];
  return {
    calls,
    wait: async (ms: number) => {
      calls.push(ms);
    },
  };
}

test("a successful response returns data and paces nothing", async () => {
  const rec = waitRecorder();
  const admin: FakeAdmin = {
    graphql: async () => jsonResponse({ data: { ok: true } }),
  };
  const result = await adminGraphql<{ ok: boolean }>(
    admin as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
    {},
    rec.wait,
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(rec.calls.length, 0, "no throttle -> no proactive wait");
});

test("passes the bounded tries to the client so it can back off internally", async () => {
  let seenTries: unknown;
  const admin: FakeAdmin = {
    graphql: async (_operation, options) => {
      seenTries = options?.tries;
      return jsonResponse({ data: { ok: true } });
    },
  };
  await asTestCall(admin);
  assert.equal(seenTries, 3, "default tries forwarded to admin.graphql");
});

async function asTestCall(admin: FakeAdmin) {
  return adminGraphql<{ ok: boolean }>(
    admin as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
  );
}

test("a throttled response triggers a bounded dynamic wait before returning", async () => {
  const rec = waitRecorder();
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({
        data: { ok: true },
        extensions: { cost: { throttled: true, nextWaitEstimate: 1500 } },
      }),
  };
  const result = await adminGraphql<{ ok: boolean }>(
    admin as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
    {},
    rec.wait,
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(rec.calls, [1500]);
});

test("a huge throttle estimate is capped so the loop can never hang", async () => {
  const rec = waitRecorder();
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({
        data: { ok: true },
        extensions: { cost: { throttled: true, nextWaitEstimate: 9_999_999 } },
      }),
  };
  await adminGraphql<{ ok: boolean }>(
    admin as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
    {},
    rec.wait,
  );
  assert.equal(rec.calls[0], 5000, "proactive wait capped at 5s");
});

test("HTTP 200 with THROTTLED error is classified as shopify_api", async () => {
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({ errors: [{ message: "Exceeded rate limit", extensions: { code: "THROTTLED" } }] }),
  };
  await assert.rejects(
    () => asAdmin(admin),
    (error: unknown) =>
      error instanceof AppError && error.kind === "shopify_api",
  );
});

test("missing scope error is classified as auth, not api-unavailable", async () => {
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({ errors: [{ message: "Missing access, requires read_orders scope" }] }),
  };
  await assert.rejects(
    () => asAdmin(admin),
    (error: unknown) => error instanceof AppError && error.kind === "auth",
  );
});

test("a GraphQL schema error keeps the actionable message as validation", async () => {
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({ errors: [{ message: "Field 'bogus' doesn't exist on type 'QueryRoot'" }] }),
  };
  await assert.rejects(
    () => asAdmin(admin),
    (error: unknown) =>
      error instanceof AppError &&
      error.kind === "validation" &&
      /bogus/.test(error.message),
  );
});

test("HTTP 429 without data folds to a retryable shopify_api error", async () => {
  const admin: FakeAdmin = {
    graphql: async () => jsonResponse({}, 429),
  };
  await assert.rejects(
    () => asAdmin(admin),
    (error: unknown) =>
      error instanceof AppError && error.kind === "shopify_api",
  );
});

test("retry exhaustion thrown by the client folds to shopify_api", async () => {
  const admin: FakeAdmin = {
    graphql: async () => {
      throw new Error("Attempted maximum number of 3 network retries");
    },
  };
  await assert.rejects(
    () => asAdmin(admin),
    (error: unknown) =>
      error instanceof AppError && error.kind === "shopify_api",
  );
});

test("unit cost access error is downgraded when allowed, keeping the sync alive", async () => {
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({
        data: { ok: true },
        errors: [{ message: "Missing access to product costs", path: ["unitCost"] }],
      }),
  };
  const result = await adminGraphql<{ ok: boolean }>(
    admin as unknown as Parameters<typeof adminGraphql>[0],
    "query { x }",
    { allowUnitCostAccessError: true },
  );
  assert.deepEqual(result, { ok: true });
});

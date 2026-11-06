import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminGraphqlWrite,
  collectUserErrors,
} from "../app/lib/admin-graphql.server.ts";
import { AppError } from "../app/lib/app-error.ts";

type FakeAdmin = {
  graphql: (
    operation: string,
    options?: { tries?: number; variables?: Record<string, unknown> },
  ) => Promise<Response>;
};
const asAdmin = (fake: FakeAdmin) =>
  fake as unknown as Parameters<typeof adminGraphqlWrite>[0];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noWait = async (): Promise<void> => {};

test("干净写操作透传 data；tries 与变量原样带给官方客户端", async () => {
  let seen: { operation?: string; tries?: unknown; variables?: unknown } = {};
  const admin: FakeAdmin = {
    graphql: async (operation, options) => {
      seen = { operation, tries: options?.tries, variables: options?.variables };
      return jsonResponse({ data: { orderUpdate: { order: { id: "gid://x/1" }, userErrors: [] } } });
    },
  };
  const data = await adminGraphqlWrite(
    asAdmin(admin),
    "mutation OrderUpdate($id: ID!) { orderUpdate(id: $id, order: {}) { userErrors { field message } } }",
    { variables: { id: "gid://x/1" }, requestSource: "automation:auto_9" },
    noWait,
  );
  assert.deepEqual(data, {
    orderUpdate: { order: { id: "gid://x/1" }, userErrors: [] },
  });
  assert.equal(typeof seen.tries, "number"); // 复用读的 tries 策略
  assert.deepEqual(seen.variables, { id: "gid://x/1" });
  assert.ok(seen.operation?.startsWith("# mypi-request-source: automation:auto_9\n"));
});

test("requestSource 净化：绝不允许可换行/注释闭合字符混进 GraphQL", async () => {
  let operation = "";
  const admin: FakeAdmin = {
    graphql: async (op) => {
      operation = op;
      return jsonResponse({ data: { ok: true } });
    },
  };
  await adminGraphqlWrite(
    asAdmin(admin),
    "mutation { ok }",
    { requestSource: "evil\"\"\n\"mutation { DropEverything }" },
    noWait,
  );
  const bannerLine = operation.split("\n")[0];
  assert.ok(!bannerLine.includes("\""), "引号应被净化");
  assert.match(bannerLine, /^# mypi-request-source: [^\s]+$/);
});

test("userErrors 不吞：折成 validation AppError，原文可行动", async () => {
  const admin: FakeAdmin = {
    graphql: async () =>
      jsonResponse({
        data: {
          tagsAdd: {
            userErrors: [{ field: ["tags"], message: "Tag name is too long" }],
          },
        },
      }),
  };
  await assert.rejects(
    adminGraphqlWrite(asAdmin(admin), "mutation { tagsAdd }", {}, noWait),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.kind, "validation");
      assert.equal(err.message, "Tag name is too long");
      assert.match(err.detail, /\[tags\] Tag name is too long/);
      return true;
    },
  );
});

test("GraphQL errors 分类沿用读通道：节流→shopify_api、权限→auth", async () => {
  const throttled: FakeAdmin = {
    graphql: async () =>
      jsonResponse({
        errors: [{ message: "Too many requests", extensions: { code: "THROTTLED" } }],
      }),
  };
  await assert.rejects(
    adminGraphqlWrite(asAdmin(throttled), "mutation { x }", {}, noWait),
    (err: unknown) => err instanceof AppError && err.kind === "shopify_api",
  );

  const forbidden: FakeAdmin = {
    graphql: async () => jsonResponse({ errors: [{ message: "Missing permission" }] }),
  };
  await assert.rejects(
    adminGraphqlWrite(asAdmin(forbidden), "mutation { x }", {}, noWait),
    (err: unknown) => err instanceof AppError && err.kind === "auth",
  );
});

test("collectUserErrors：任意路径形状都能捞；非条目不误报", () => {
  assert.deepEqual(
    collectUserErrors({ productUpdate: { userErrors: [{ message: "bad title", field: ["title"] }] } }),
    [{ message: "bad title", field: ["title"] }],
  );
  assert.deepEqual(collectUserErrors({ userErrors: [{ note: "no message" }] }), []);
  assert.deepEqual(collectUserErrors(null), []);
  assert.deepEqual(collectUserErrors(["plain", 42]), []);
  // 嵌套一层数组的形状
  assert.deepEqual(
    collectUserErrors({ a: { b: [{ userErrors: [{ message: "deep" }] }] } }),
    [{ message: "deep" }],
  );
});

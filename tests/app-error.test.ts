import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppError,
  DATABASE_UNAVAILABLE_MESSAGE,
  SHOPIFY_API_UNAVAILABLE_MESSAGE,
  UNKNOWN_ERROR_MESSAGE,
  APP_SAFE_ERROR_FLAG,
  classifyAppError,
  describeError,
  readSafeErrorPayload,
  toSafeError,
  toSafeErrorResponse,
} from "../app/lib/app-error.ts";

/** 造一个只带 name/code 的 Prisma 式错误，避免测试依赖真实客户端。 */
function prismaLike(name: string, code: string, message: string) {
  return Object.assign(new Error(message), { name, code });
}

test("explicit AppError keeps the kind the service chose", () => {
  const error = new AppError("auth", "Re-authorize the app.", "raw detail");
  assert.equal(classifyAppError(error), "auth");
  assert.equal(toSafeError(error).message, "Re-authorize the app.");
});

test("connection-level Prisma failures are database, not business errors", () => {
  for (const code of ["P1001", "P1002", "P1008", "P2024", "P2028", "P2034"]) {
    const error = prismaLike("PrismaClientKnownRequestError", code, "boom");
    assert.equal(classifyAppError(error), "database", code);
    assert.equal(
      toSafeError(error).message,
      DATABASE_UNAVAILABLE_MESSAGE,
      code,
    );
  }
});

test("integrity violations stay out of the retryable database bucket", () => {
  const error = prismaLike(
    "PrismaClientKnownRequestError",
    "P2002",
    "Unique constraint failed on the fields: (`activeKey`)",
  );
  assert.notEqual(classifyAppError(error), "database");
});

test("429 and 5xx from an upstream client read as an unavailable API", () => {
  for (const status of [429, 500, 503]) {
    const error = Object.assign(new Error("HTTP request failed"), { status });
    assert.equal(classifyAppError(error), "shopify_api", String(status));
    assert.equal(
      toSafeError(error).message,
      SHOPIFY_API_UNAVAILABLE_MESSAGE,
      String(status),
    );
  }
});

test("session and authorization failures are named, not guessed", () => {
  const error = Object.assign(new Error("Session not found"), {
    name: "SessionNotFoundError",
  });
  assert.equal(classifyAppError(error), "auth");
});

test("copy errors surface their own wording because it is app-authored", () => {
  const error = Object.assign(
    new Error("The model provider is rate limited."),
    {
      name: "ProductCopyError",
    },
  );
  assert.equal(classifyAppError(error), "validation");
  assert.equal(
    toSafeError(error).message,
    "The model provider is rate limited.",
  );
});

test("unexpected throwables never leak their raw message to the merchant", () => {
  const secret =
    "connect ECONNREFUSED 10.0.0.7:5432 — postgres://postgres:hunter2@db.internal";
  const safe = toSafeError(new Error(secret));
  assert.equal(safe.kind, "unknown");
  assert.equal(safe.message, UNKNOWN_ERROR_MESSAGE);
  assert.doesNotMatch(safe.message, /ECONNREFUSED|hunter2|postgres:\/\//);
  // 原文只进 detail，供服务端日志使用。
  assert.match(safe.detail, /ECONNREFUSED/);
});

test("detail collapses to one bounded line whatever was thrown", () => {
  assert.equal(describeError(undefined), "thrown value was undefined");
  assert.equal(describeError(null), "thrown value was null");
  assert.equal(describeError("plain string"), "plain string");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(describeError(circular), /^unserializable object$/);
  const long = new Error("x".repeat(900));
  assert.ok(describeError(long).length <= 500);
});

test("a database blip folds into a 503 Response that survives hydration intact", async () => {
  const error = prismaLike("PrismaClientKnownRequestError", "P1001", "down");
  const response = toSafeErrorResponse(error);
  assert.equal(response.status, 503);
  const body = await response.json();
  const payload = body[APP_SAFE_ERROR_FLAG];
  assert.equal(payload.kind, "database");
  assert.equal(payload.message, DATABASE_UNAVAILABLE_MESSAGE);
  // ErrorBoundary 从 useRouteError 的 { data } 形态里原样取回同一份分类。
  const recovered = readSafeErrorPayload({ data: body });
  assert.deepEqual(recovered, {
    kind: "database",
    message: DATABASE_UNAVAILABLE_MESSAGE,
    status: 503,
  });
});

test("the safe-error Response never carries the raw secret across the boundary", async () => {
  const secret =
    "connect ECONNREFUSED 10.0.0.7:5432 — postgres://postgres:hunter2@db.internal";
  const text = await toSafeErrorResponse(new Error(secret)).text();
  assert.doesNotMatch(text, /ECONNREFUSED|hunter2|postgres:\/\//);
});

test("readSafeErrorPayload ignores shapes that are not our flagged payload", () => {
  assert.equal(readSafeErrorPayload(undefined), null);
  assert.equal(readSafeErrorPayload(new Error("plain")), null);
  assert.equal(readSafeErrorPayload({ data: { other: 1 } }), null);
  assert.equal(
    readSafeErrorPayload({
      data: { [APP_SAFE_ERROR_FLAG]: { kind: "database" } },
    }),
    null,
  );
});

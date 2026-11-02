import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getModelConfiguration,
  getModelConfigurationStatus,
  normalizeModelError,
  parseProductCopyResponse,
  ProductCopyError,
  requireModelApiKey,
  withModelTimeout,
} from "../app/product-copy.server.ts";

test("model configuration uses defaults and accepts provider overrides", () => {
  assert.deepEqual(getModelConfiguration({}), {
    provider: "openai",
    model: "gpt-4.1-mini",
    apiKey: undefined,
  });
  assert.deepEqual(
    getModelConfiguration({
      PI_PROVIDER: "anthropic",
      PI_MODEL: "claude-sonnet-4-5",
      PI_API_KEY: "  test-key  ",
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "test-key",
    },
  );
});

test("model configuration rejects invalid provider and model values", () => {
  assert.throws(
    () => getModelConfiguration({ PI_PROVIDER: "../provider" }),
    (error: unknown) =>
      error instanceof ProductCopyError && error.code === "configuration",
  );
});

test("missing API keys fail without returning a secret", () => {
  assert.throws(
    () =>
      requireModelApiKey({
        provider: "openai",
        model: "gpt-4.1-mini",
        apiKey: undefined,
      }),
    (error: unknown) =>
      error instanceof ProductCopyError && error.code === "missing_api_key",
  );
});

test("configuration status never exposes the API key", () => {
  const previous = process.env.PI_API_KEY;
  process.env.PI_API_KEY = "test-key-not-for-output";
  try {
    const status = getModelConfigurationStatus();
    assert.equal(status.configured, true);
    assert.equal("apiKey" in status, false);
    assert.equal(
      JSON.stringify(status).includes("test-key-not-for-output"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PI_API_KEY;
    } else {
      process.env.PI_API_KEY = previous;
    }
  }
});

test("product copy response parses valid JSON and fenced JSON", () => {
  const json = JSON.stringify({ title: "优化标题", description: "优化描述" });
  assert.deepEqual(parseProductCopyResponse(json), {
    title: "优化标题",
    description: "优化描述",
  });
  assert.deepEqual(parseProductCopyResponse(`\`\`\`json\n${json}\n\`\`\``), {
    title: "优化标题",
    description: "优化描述",
  });
});

test("product copy response accepts the maximum field lengths", () => {
  const result = parseProductCopyResponse(
    JSON.stringify({
      title: "t".repeat(255),
      description: "d".repeat(20_000),
    }),
  );
  assert.equal(result.title.length, 255);
  assert.equal(result.description.length, 20_000);
});

test("product copy response rejects malformed, incomplete, extra, and oversized output", () => {
  const invalidResponses = [
    "not-json",
    JSON.stringify({ title: "标题" }),
    JSON.stringify({ title: "标题", description: "描述", extra: true }),
    JSON.stringify({ title: " ", description: "描述" }),
    JSON.stringify({ title: "x".repeat(256), description: "描述" }),
    JSON.stringify({ title: "标题", description: "x".repeat(20_001) }),
  ];

  for (const response of invalidResponses) {
    assert.throws(
      () => parseProductCopyResponse(response),
      (error: unknown) =>
        error instanceof ProductCopyError && error.code === "invalid_output",
    );
  }
});

test("model errors are normalized to actionable categories", () => {
  assert.equal(normalizeModelError({ status: 401 }).code, "authentication");
  assert.equal(normalizeModelError({ status: 403 }).code, "authentication");
  assert.equal(normalizeModelError({ statusCode: 429 }).code, "rate_limited");
  assert.equal(normalizeModelError(new Error("ETIMEDOUT")).code, "timeout");
  assert.equal(
    normalizeModelError(new Error("provider unavailable")).code,
    "provider",
  );
});

test("model timeout aborts the active request", async () => {
  let aborted = false;
  const operation = new Promise<never>(() => {});

  await assert.rejects(
    withModelTimeout(operation, 5, async () => {
      aborted = true;
    }),
    (error: unknown) =>
      error instanceof ProductCopyError && error.code === "timeout",
  );
  assert.equal(aborted, true);
});

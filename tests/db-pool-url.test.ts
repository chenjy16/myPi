import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDatasourceUrl,
  resolvePoolSettings,
} from "../app/lib/db-pool-url.ts";

const SESSION_POOLER =
  "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require&connect_timeout=20";

test("resolvePoolSettings falls back to safe defaults", () => {
  const settings = resolvePoolSettings({});
  assert.deepEqual(settings, {
    connectionLimit: 10,
    poolTimeoutSeconds: 10,
    connectTimeoutSeconds: 20,
  });
});

test("resolvePoolSettings honors overrides and clamps bad values", () => {
  assert.equal(resolvePoolSettings({ DB_CONNECTION_LIMIT: "25" }).connectionLimit, 25);
  assert.equal(resolvePoolSettings({ DB_CONNECTION_LIMIT: "0" }).connectionLimit, 10);
  assert.equal(resolvePoolSettings({ DB_CONNECTION_LIMIT: "abc" }).connectionLimit, 10);
  assert.equal(
    resolvePoolSettings({ DB_CONNECTION_LIMIT: "9999" }).connectionLimit,
    100,
    "capped so a typo can't blow the DB connection budget",
  );
  assert.equal(resolvePoolSettings({ DB_POOL_TIMEOUT_SECONDS: "30" }).poolTimeoutSeconds, 30);
});

test("buildDatasourceUrl adds only the missing pool params", () => {
  const url = buildDatasourceUrl({ DATABASE_URL: SESSION_POOLER }, resolvePoolSettings({ DB_CONNECTION_LIMIT: "15" }));
  assert.ok(url);
  const params = new URL(url!).searchParams;
  assert.equal(params.get("sslmode"), "require", "existing params untouched");
  // connect_timeout already present in the operator string -> keep 20, do not re-add a default.
  assert.equal(params.get("connect_timeout"), "20");
  assert.equal(params.get("connection_limit"), "15");
  assert.equal(params.get("pool_timeout"), "10");
});

test("buildDatasourceUrl never overrides an explicit pool value in the string", () => {
  const withLimit = `${SESSION_POOLER}&connection_limit=5`;
  const url = buildDatasourceUrl({ DATABASE_URL: withLimit }, { connectionLimit: 50, poolTimeoutSeconds: 10, connectTimeoutSeconds: 20 });
  assert.ok(url);
  assert.equal(new URL(url!).searchParams.get("connection_limit"), "5");
});

test("buildDatasourceUrl returns undefined without DATABASE_URL, passthrough when malformed", () => {
  assert.equal(buildDatasourceUrl({}), undefined);
  assert.equal(buildDatasourceUrl({ DATABASE_URL: "not a url" }), "not a url");
});

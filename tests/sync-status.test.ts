import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveSyncStatus,
  type SyncJobRow,
} from "../app/lib/sync-job-policy.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const at = (minutesAgo: number): Date =>
  new Date(NOW.getTime() - minutesAgo * 60_000);

function row(overrides: Partial<SyncJobRow> & Pick<SyncJobRow, "status">): SyncJobRow {
  return {
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

// P0-2 验收：区分「最后一次尝试」「最后一次成功」「当前状态」「最近失败原因」。
test("scenario 1 — a clean successful sync", () => {
  const status = deriveSyncStatus(
    [row({ status: "succeeded", createdAt: at(5), finishedAt: at(5) })],
    NOW,
  );
  assert.equal(status.current, "succeeded");
  assert.deepEqual(status.lastSyncAttemptAt, at(5));
  assert.deepEqual(status.lastSuccessfulSyncAt, at(5));
  assert.equal(status.lastSyncError, null);
  assert.equal(status.staleWithFallback, false);
});

test("scenario 2 — an in-flight sync reads as running, not failed", () => {
  const status = deriveSyncStatus(
    [
      row({ status: "running", createdAt: at(1), startedAt: at(1) }),
      row({ status: "succeeded", createdAt: at(40), finishedAt: at(40) }),
    ],
    NOW,
  );
  assert.equal(status.current, "running");
  assert.equal(status.staleWithFallback, false);
});

test("scenario 3 — repeated failures with no prior success", () => {
  const status = deriveSyncStatus(
    [
      row({ status: "failed", createdAt: at(2), error: "Shopify API unavailable" }),
      row({ status: "failed", createdAt: at(62), error: "older failure" }),
    ],
    NOW,
  );
  assert.equal(status.current, "failed");
  assert.equal(status.lastSuccessfulSyncAt, null);
  assert.equal(status.lastSyncError, "Shopify API unavailable");
  // No successful snapshot to fall back on, so this is not the "showing stale data" case.
  assert.equal(status.staleWithFallback, false);
});

test("scenario 4 — latest succeeded clears the streak; old error no longer shows", () => {
  const status = deriveSyncStatus(
    [
      row({ status: "succeeded", createdAt: at(3), finishedAt: at(3) }),
      row({ status: "failed", createdAt: at(33), error: "transient" }),
    ],
    NOW,
  );
  assert.equal(status.current, "succeeded");
  assert.equal(status.lastSyncError, null, "a newer success must not surface an older error");
  assert.equal(status.staleWithFallback, false);
});

test("scenario 6 — old snapshot still present but the latest sync failed", () => {
  const status = deriveSyncStatus(
    [
      row({ status: "failed", createdAt: at(10), error: "Throttled and retries exhausted" }),
      row({ status: "succeeded", createdAt: at(300), finishedAt: at(300) }),
    ],
    NOW,
  );
  assert.equal(status.current, "failed");
  assert.equal(status.staleWithFallback, true);
  assert.deepEqual(status.lastSuccessfulSyncAt, at(300));
  assert.equal(status.lastSyncError, "Throttled and retries exhausted");
});

test("a crashed running row past its lease is shown as failed, not stuck in progress", () => {
  // Default lease is 30 minutes; this running row started 90 minutes ago.
  const status = deriveSyncStatus(
    [row({ status: "running", createdAt: at(90), startedAt: at(90) })],
    NOW,
  );
  assert.equal(status.current, "failed");
});

test("an empty ledger reads as never-synced, not a failure", () => {
  const status = deriveSyncStatus([], NOW);
  assert.equal(status.current, "never");
  assert.equal(status.lastSyncAttemptAt, null);
  assert.equal(status.lastSuccessfulSyncAt, null);
  assert.equal(status.staleWithFallback, false);
});

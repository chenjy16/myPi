import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAppError, toSafeError } from "../app/lib/app-error.ts";
import {
  SyncAlreadyRunningError,
  jobLeaseMinutes,
  leaseCutoff,
  syncJobClaimKey,
} from "../app/lib/sync-job-policy.ts";

test("the claim key is one lock per shop and job type", () => {
  assert.equal(
    syncJobClaimKey("acme.myshopify.com", "inventory-snapshot"),
    "acme.myshopify.com:inventory-snapshot",
  );
  assert.notEqual(
    syncJobClaimKey("acme.myshopify.com", "inventory-snapshot"),
    syncJobClaimKey("acme.myshopify.com", "sales-daily"),
  );
});

test("a lost race reads as an actionable wait, not a failure", () => {
  const error = new SyncAlreadyRunningError("inventory-snapshot");
  assert.equal(classifyAppError(error), "validation");
  const safe = toSafeError(error);
  assert.match(safe.message, /inventory sync is already running/i);
  assert.doesNotMatch(safe.message, /P2002|activeKey|Unique constraint/);
});

test("the lease window stays bounded no matter what the env says", () => {
  const original = process.env.WORKER_JOB_LEASE_MINUTES;
  try {
    delete process.env.WORKER_JOB_LEASE_MINUTES;
    assert.equal(jobLeaseMinutes(), 30);

    process.env.WORKER_JOB_LEASE_MINUTES = "90";
    const now = new Date("2026-11-02T12:00:00Z");
    assert.equal(leaseCutoff(now).toISOString(), "2026-11-02T10:30:00.000Z");

    // 配错（0、负数、非数字）回落到默认值，上限一天，避免出现「永远不过期」的锁。
    process.env.WORKER_JOB_LEASE_MINUTES = "0";
    assert.equal(jobLeaseMinutes(), 30);
    process.env.WORKER_JOB_LEASE_MINUTES = "abc";
    assert.equal(jobLeaseMinutes(), 30);
    process.env.WORKER_JOB_LEASE_MINUTES = "99999";
    assert.equal(jobLeaseMinutes(), 24 * 60);
  } finally {
    if (original === undefined) {
      delete process.env.WORKER_JOB_LEASE_MINUTES;
    } else {
      process.env.WORKER_JOB_LEASE_MINUTES = original;
    }
  }
});

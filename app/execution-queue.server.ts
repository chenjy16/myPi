import db from "./db.server";
import {
  claimNextEvent as claimNextCore,
  completeExecutionJob as completeCore,
  enqueueStandardEvent as enqueueCore,
  reapStaleExecutionJobs as reapCore,
  type ClaimedEvent,
  type EnqueueResult,
} from "./lib/execution-queue";
import type { StandardEvent } from "./lib/event-normalizer";

/** 执行队列的真实库绑定面；逻辑在 lib/execution-queue，便于脱库单测。 */
export function enqueueStandardEvent(
  event: StandardEvent,
  options: { deliveryId?: string; shopId?: string } = {},
): Promise<EnqueueResult> {
  return enqueueCore(db, event, options);
}

export function claimNextEvent(shop: string, now: Date = new Date()): Promise<ClaimedEvent | null> {
  return claimNextCore(db, shop, now);
}

export function reapStaleExecutionJobs(shop?: string, now: Date = new Date()): Promise<number> {
  return reapCore(db, shop, now);
}

export function completeExecutionJob(
  jobId: string,
  ok: boolean,
  errorText?: string,
): Promise<void> {
  return completeCore(db, jobId, ok, errorText);
}

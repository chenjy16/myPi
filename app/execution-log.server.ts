import db from "./db.server";
import {
  createExecutionLog as createLogCore,
  appendStep as appendStepCore,
  finalizeStatus as finalizeCore,
  type NewExecutionLog,
  type NewStep,
} from "./lib/execution-log";
import {
  pruneOldExecutions as pruneCore,
  type PruneOldExecutionsDependencies,
} from "./lib/execution-retention";

/** 执行记录的真实库绑定面；逻辑在 lib/execution-log，便于脱库单测。 */
export function createExecutionLog(input: NewExecutionLog) {
  return createLogCore(db, input);
}

export function appendStep(step: NewStep) {
  return appendStepCore(db, step);
}

export function finalizeStatus(executionId: string) {
  return finalizeCore(db, executionId);
}

/** P4-10：删超出保留窗口（EXECUTION_RETENTION_DAYS，默认 180 天）的执行史；逻辑在 lib/execution-retention。 */
export function pruneOldExecutions(deps?: PruneOldExecutionsDependencies) {
  return pruneCore(db, deps);
}

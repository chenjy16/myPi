import assert from "node:assert/strict";
import { test } from "node:test";
import { executionEventForOutcome } from "../app/lib/execution-metrics.ts";
import { isAnalyticsEventType } from "../app/lib/analytics.ts";
import type { AutomationRunOutcome } from "../app/lib/automation-engine.ts";
import type { ExecutionStatus } from "../app/lib/execution-log.ts";
import type { EvaluationResult } from "../app/lib/condition-evaluator.ts";

const SKIPPED_EVAL: EvaluationResult = { result: false, logic: "AND", clauses: [] };

function conditionsSkipped(): AutomationRunOutcome {
  return { status: "conditions-skipped", executionId: "e", evaluation: SKIPPED_EVAL };
}

function completed(
  executionStatus: ExecutionStatus,
  awaitingConfirmation = false,
): AutomationRunOutcome {
  return {
    status: "completed",
    executionId: "exec_1",
    executionStatus,
    awaitingConfirmation,
  };
}

test("executionEventForOutcome：终态映射到对应事件且事件名合法", () => {
  const cases: [AutomationRunOutcome, string][] = [
    [completed("SUCCESS"), "execution_succeeded"],
    [completed("FAILED"), "execution_failed"],
    [completed("PARTIAL_SUCCESS"), "execution_partial"],
    [completed("RETRYING"), "execution_retried"],
    [completed("SKIPPED"), "execution_skipped"],
    [conditionsSkipped(), "execution_skipped"],
    [{ status: "duplicate-skipped" } as AutomationRunOutcome, "execution_skipped"],
    [
      { status: "loop-blocked", executionId: "e", reason: "depth" } as AutomationRunOutcome,
      "execution_loop_blocked",
    ],
  ];
  for (const [outcome, expected] of cases) {
    const m = executionEventForOutcome(outcome);
    assert.ok(m, `应产生事件：${JSON.stringify(outcome)}`);
    assert.equal(m!.type, expected);
    assert.ok(isAnalyticsEventType(m!.type), `${m!.type} 必须在白名单内`);
  }
});

test("executionEventForOutcome：awaiting_confirmation 优先于成功/失败终态", () => {
  const m = executionEventForOutcome(completed("PARTIAL_SUCCESS", true));
  assert.equal(m!.type, "execution_awaiting_confirmation");
  assert.deepEqual(m!.props, { executionStatus: "PARTIAL_SUCCESS" });
});

test("executionEventForOutcome：RUNNING 终态不虚报，返回 null", () => {
  assert.equal(executionEventForOutcome(completed("RUNNING")), null);
});

test("executionEventForOutcome：skipped 细分原因可读", () => {
  const dedupe = executionEventForOutcome({ status: "duplicate-skipped" });
  assert.equal(dedupe!.props?.reason, "dedupe");
  const cond = executionEventForOutcome(conditionsSkipped());
  assert.equal(cond!.props?.reason, "conditions");
});

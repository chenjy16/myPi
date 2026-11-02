import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTION_BOARD_STATES,
  calculateAdoptionMetrics,
  resolveActionBoardState,
  summarizeActionBoard,
  type ActionBoardRowInput,
} from "../app/lib/reorder-action-board.ts";

/** 一条「有建议、没表态、数据干净」的行，用例只改自己要验证的那一项。 */
function row(
  overrides: Partial<ActionBoardRowInput> = {},
): ActionBoardRowInput {
  return {
    hasLiveSuggestion: true,
    status: null,
    needsReview: false,
    paused: false,
    ...overrides,
  };
}

test("every board state is reachable from a suggestion", () => {
  assert.deepEqual(ACTION_BOARD_STATES, [
    "paused",
    "pending",
    "accepted",
    "edited",
    "ignored",
    "ordered",
  ]);
  // 没表过态的建议就是待办。
  assert.equal(resolveActionBoardState(row()), "pending");
  assert.equal(resolveActionBoardState(row({ status: "ignored" })), "ignored");
});

test("an ordered row survives losing its suggestion", () => {
  assert.equal(
    resolveActionBoardState(
      row({ hasLiveSuggestion: false, status: "ordered" }),
    ),
    "ordered",
  );
  // 采购已经发生，不该因为这次不算建议就把历史藏起来。
  assert.equal(
    resolveActionBoardState(
      row({ hasLiveSuggestion: false, status: "ordered", paused: true }),
    ),
    "ordered",
  );
});

test("accepted rows stay for review but ignored rows leave with the suggestion", () => {
  const withoutAdvice: Partial<ActionBoardRowInput> = {
    hasLiveSuggestion: false,
  };
  assert.equal(
    resolveActionBoardState(row({ ...withoutAdvice, status: "accepted" })),
    "accepted",
  );
  assert.equal(
    resolveActionBoardState(row({ ...withoutAdvice, status: "edited" })),
    "edited",
  );
  assert.equal(
    resolveActionBoardState(row({ ...withoutAdvice, status: "ignored" })),
    null,
  );
  assert.equal(resolveActionBoardState(row(withoutAdvice)), null);
});

test("paused covers pending but never rewrites a finished purchase", () => {
  assert.equal(resolveActionBoardState(row({ paused: true })), "paused");
  assert.equal(
    resolveActionBoardState(row({ paused: true, status: "accepted" })),
    "paused",
  );
  assert.equal(
    resolveActionBoardState(row({ paused: true, status: "ordered" })),
    "ordered",
  );
});

test("a changed suggestion sends an accepted row back to pending", () => {
  assert.equal(
    resolveActionBoardState(row({ status: "accepted", needsReview: true })),
    "pending",
  );
  assert.equal(
    resolveActionBoardState(row({ status: "edited", needsReview: true })),
    "pending",
  );
  // 忽略的行不需要重新算，数字变了也不该把它拉回待办。
  assert.equal(
    resolveActionBoardState(row({ status: "ignored", needsReview: true })),
    "ignored",
  );
});

test("counts skip nulls and start every state at zero", () => {
  const counts = summarizeActionBoard([
    "pending",
    "pending",
    null,
    "ordered",
    null,
    "ignored",
  ]);
  assert.equal(counts.pending, 2);
  assert.equal(counts.ordered, 1);
  assert.equal(counts.ignored, 1);
  assert.equal(counts.accepted, 0);
  assert.equal(counts.paused, 0);
  assert.deepEqual(Object.keys(counts), ACTION_BOARD_STATES);
});

test("an empty board reports no rate instead of a fake zero", () => {
  const metrics = calculateAdoptionMetrics(summarizeActionBoard([null, null]));
  assert.equal(metrics.adoptionRate, null);
  assert.equal(metrics.reviewedRate, null);
  assert.equal(metrics.actionableCount, 0);
});

test("pending-only work has no adoption rate and 0% reviewed", () => {
  const metrics = calculateAdoptionMetrics(
    summarizeActionBoard(["pending", "pending", null]),
  );
  assert.equal(metrics.adoptionRate, null);
  assert.equal(metrics.reviewedRate, 0);
  assert.equal(metrics.actionableCount, 2);
});

test("adoption counts adjusted as adopted and ignored as not", () => {
  const metrics = calculateAdoptionMetrics(
    summarizeActionBoard([
      "accepted",
      "accepted",
      "accepted",
      "ignored",
      null,
      null,
    ]),
  );
  // 已表态 4 行，采纳 3 行；待办 0 行。
  assert.equal(metrics.adoptionRate, 0.75);
  assert.equal(metrics.reviewedRate, 1);
});

test("ordered and edited both count toward adoption", () => {
  const metrics = calculateAdoptionMetrics(
    summarizeActionBoard(["ordered", "edited", "ignored", "pending"]),
  );
  assert.equal(metrics.adoptionRate, 2 / 3);
  // 分母含待办：已表态 3 / 应处理 4。
  assert.equal(metrics.reviewedRate, 0.75);
  assert.equal(metrics.actionableCount, 4);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUDIT_ACTION_BY_DECISION_STATUS,
  DECISION_REASON_MAX_LENGTH,
  canMarkReorderRecommendationOrdered,
  isRecommendationAuditAction,
  isReorderDecisionIntent,
  isReorderDecisionStatus,
  isValidRequestKey,
  parseDecisionReason,
  parsePositiveQuantity,
} from "../app/lib/reorder-recommendations.ts";

test("reorder decisions accept only supported actions and statuses", () => {
  assert.equal(isReorderDecisionIntent("accept-recommendation"), true);
  assert.equal(isReorderDecisionIntent("edit-recommendation"), true);
  assert.equal(isReorderDecisionIntent("ignore-recommendation"), true);
  assert.equal(isReorderDecisionIntent("mark-ordered"), true);
  assert.equal(isReorderDecisionIntent("delete-all"), false);

  assert.equal(isReorderDecisionStatus("accepted"), true);
  assert.equal(isReorderDecisionStatus("edited"), true);
  assert.equal(isReorderDecisionStatus("ignored"), true);
  assert.equal(isReorderDecisionStatus("ordered"), true);
  // pending 是同步登记出来的待表态初态，属于合法落库值；paused 只在运行时派生。
  assert.equal(isReorderDecisionStatus("pending"), true);
  assert.equal(isReorderDecisionStatus("paused"), false);
  assert.equal(isReorderDecisionStatus("accepted-recommendation"), false);

  assert.equal(isRecommendationAuditAction("created"), true);
  assert.equal(isRecommendationAuditAction("mark-ordered"), true);
  assert.equal(isRecommendationAuditAction("paused"), false);
  for (const action of Object.values(AUDIT_ACTION_BY_DECISION_STATUS)) {
    assert.equal(isRecommendationAuditAction(action), true);
  }
});

test("a pending recommendation can never be marked ordered", () => {
  assert.equal(
    canMarkReorderRecommendationOrdered({
      status: "pending",
      needsReview: false,
    }),
    false,
  );
});

test("a recommendation can be marked ordered only after current acceptance or edit", () => {
  assert.equal(
    canMarkReorderRecommendationOrdered({
      status: "accepted",
      needsReview: false,
    }),
    true,
  );
  assert.equal(
    canMarkReorderRecommendationOrdered({
      status: "edited",
      needsReview: false,
    }),
    true,
  );
  assert.equal(
    canMarkReorderRecommendationOrdered({
      status: "accepted",
      needsReview: true,
    }),
    false,
  );
  assert.equal(
    canMarkReorderRecommendationOrdered({
      status: "ignored",
      needsReview: false,
    }),
    false,
  );
  assert.equal(canMarkReorderRecommendationOrdered(null), false);
});

test("edited reorder quantities must be positive 32-bit integers", () => {
  assert.equal(parsePositiveQuantity("1"), 1);
  assert.equal(parsePositiveQuantity("2147483647"), 2147483647);
  assert.equal(parsePositiveQuantity("0"), null);
  assert.equal(parsePositiveQuantity("-1"), null);
  assert.equal(parsePositiveQuantity("1.5"), null);
  assert.equal(parsePositiveQuantity("2147483648"), null);
  assert.equal(parsePositiveQuantity(""), null);
  assert.equal(parsePositiveQuantity(null), null);
  assert.equal(parsePositiveQuantity(new File([], "quantity")), null);
});

test("decision reasons normalize blanks, cap length, and keep text intact", () => {
  // 未填或纯空白统一为 null——落库存 null，而不是空串。
  assert.equal(parseDecisionReason(null), null);
  assert.equal(parseDecisionReason(""), null);
  assert.equal(parseDecisionReason("   "), null);
  // 正常文本 trim 后保留。
  assert.equal(
    parseDecisionReason(" supplier was out of stock "),
    "supplier was out of stock",
  );
  // 超长返回 undefined（调用方报错），恰好等于上限仍合法。
  assert.equal(
    parseDecisionReason("x".repeat(DECISION_REASON_MAX_LENGTH + 1)),
    undefined,
  );
  assert.equal(
    parseDecisionReason("x".repeat(DECISION_REASON_MAX_LENGTH)),
    "x".repeat(DECISION_REASON_MAX_LENGTH),
  );
});

test("request keys accept only well-formed uuids", () => {
  assert.equal(isValidRequestKey("3f0c8b1a-27de-4a2f-9d1c-6b5a9c0d1e22"), true);
  assert.equal(isValidRequestKey("3F0C8B1A-27DE-4A2F-9D1C-6B5A9C0D1E22"), true);
  // 缺段、多段、非 hex、空串、任意注入串一律拒。
  assert.equal(isValidRequestKey("3f0c8b1a-27de-4a2f-9d1c-6b5a9c0d1e2"), false);
  assert.equal(isValidRequestKey("3f0c8b1a27de4a2f9d1c6b5a9c0d1e22"), false);
  assert.equal(isValidRequestKey("not-a-uuid"), false);
  assert.equal(isValidRequestKey("'; DROP TABLE"), false);
  assert.equal(isValidRequestKey(""), false);
});

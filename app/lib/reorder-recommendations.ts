/**
 * 补货决策的落库状态。pending 是同步登记出的「待表态」初态，由系统写入；
 * 数据异常时的 paused 属于运行时派生态，不落在这一列上。
 */
export type ReorderDecisionStatus =
  "pending" | "accepted" | "edited" | "ignored" | "ordered";

export type ReorderDecisionIntent =
  | "accept-recommendation"
  | "edit-recommendation"
  | "ignore-recommendation"
  | "mark-ordered";

/** 审计流水的动作：created 由同步登记待办行，其余对应商家四个按钮。 */
export type RecommendationAuditAction = "created" | ReorderDecisionIntent;

const AUDIT_ACTIONS: RecommendationAuditAction[] = [
  "created",
  "accept-recommendation",
  "edit-recommendation",
  "ignore-recommendation",
  "mark-ordered",
];

/** 判断审计动作是否合法，避免写入拼错的状态。 */
export function isRecommendationAuditAction(
  value: string,
): value is RecommendationAuditAction {
  return (AUDIT_ACTIONS as string[]).includes(value);
}

/**
 * 审计流水里的操作者。应用只持有 offline session，拿不到具体员工账号，
 * 所以 P0-lite 只区分「系统自动登记」与「人在应用里点了」，不伪称能识别到个人。
 */
export const AUDIT_OPERATOR_SYSTEM = "system";
export const AUDIT_OPERATOR_MERCHANT = "merchant";

/** 决策态对应的审计动作，供同步与手工写入共用一套映射。 */
export const AUDIT_ACTION_BY_DECISION_STATUS: Record<
  ReorderDecisionStatus,
  RecommendationAuditAction
> = {
  pending: "created",
  accepted: "accept-recommendation",
  edited: "edit-recommendation",
  ignored: "ignore-recommendation",
  ordered: "mark-ordered",
};

/** 判断数据库里的 status 是否为合法补货决策状态。 */
export function isReorderDecisionStatus(
  value: string,
): value is ReorderDecisionStatus {
  return (
    value === "pending" ||
    value === "accepted" ||
    value === "edited" ||
    value === "ignored" ||
    value === "ordered"
  );
}

/** 仅当建议已接受或已调整、且同步后数量未变化时，才允许标记「已采购」。 */
export function canMarkReorderRecommendationOrdered(
  recommendation: {
    status: ReorderDecisionStatus;
    needsReview: boolean;
  } | null,
): boolean {
  return (
    recommendation !== null &&
    !recommendation.needsReview &&
    (recommendation.status === "accepted" || recommendation.status === "edited")
  );
}

/** 判断表单 intent 是否为四种补货决策之一。 */
export function isReorderDecisionIntent(
  value: FormDataEntryValue | null,
): value is ReorderDecisionIntent {
  return (
    value === "accept-recommendation" ||
    value === "edit-recommendation" ||
    value === "ignore-recommendation" ||
    value === "mark-ordered"
  );
}

/** 把表单数量解析为正整数；非法或超出 Int 上限则返回 null。 */
export function parsePositiveQuantity(
  value: FormDataEntryValue | null,
): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity <= 2_147_483_647
    ? quantity
    : null;
}

/** 决策理由的字符上限；UI 的 maxLength 与服务端校验共用这一个常量。 */
export const DECISION_REASON_MAX_LENGTH = 200;

/**
 * 解析决策理由：未填/纯空白归一为 null，超长返回 undefined（调用方报错），
 * 其余返回 trim 后的文本。只有 edit/ignore 收集理由。
 */
export function parseDecisionReason(
  value: FormDataEntryValue | null,
): string | null | undefined {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > DECISION_REASON_MAX_LENGTH) return undefined;
  return text;
}

/** 校验请求级幂等键是否为标准 UUID v4（表单值不可信，非法 key 直接拒）。 */
export function isValidRequestKey(
  value: FormDataEntryValue | null,
): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

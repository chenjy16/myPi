// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与 sync-job-policy.ts 同一约定）。
// 纯逻辑、零依赖，供引擎与前端共同消费：Action 风险分级 → 执行前是否需人工确认。
// 决策基准 docs/PRD-V2.0.md §20.1（P6 Safe by Default）。

/** 执行风险等级。high 落 AWAITING_CONFIRMATION，确认前不得发 Mutation。 */
export type RiskLevel = "low" | "high";

/** 确认模式。auto=排到即执行；required=需商家点确认。 */
export type ConfirmationMode = "auto" | "required";

/**
 * 首版已登记 Action 的风险表。缺省即 high（安全默认，见 resolveConfirmation）。
 * 刻意**不含**"改价 / 删订单"——那是 PRD §8 非目标，未来新增 Action 必须显式声明风险。
 */
const ACTION_RISK: Readonly<Record<string, RiskLevel>> = {
  "tags.add": "low",
  "tags.remove": "low",
  "email.send": "low",
  "webhook.send": "low",
  "product.updateStatus": "high",
};

/** 已登记 Action id，供校验器 / 模板目录交叉核对。 */
export const KNOWN_ACTION_IDS: readonly string[] = Object.keys(ACTION_RISK);

/** 取某 Action 的风险等级；未登记或显式 high 一律 high。 */
export function actionRiskLevel(actionId: string): RiskLevel {
  return ACTION_RISK[actionId] ?? "high";
}

/**
 * 风险 → 确认模式的唯一映射：low→auto，其余（含 high）→required。
 * 缺省走 required，绝不因为「没查到」就自动执行高风险动作。
 */
export function resolveConfirmation(riskLevel: RiskLevel): ConfirmationMode {
  return riskLevel === "low" ? "auto" : "required";
}

/** 便捷组合：直接由 actionId 得到确认模式。 */
export function confirmationForAction(actionId: string): ConfirmationMode {
  return resolveConfirmation(actionRiskLevel(actionId));
}

/**
 * DSL 里允许显式声明的 riskLevel 取值（缺省时按 actionId 派生，声明了则以其为准，
 * 但仍不得把 high 降级成 auto 之外的意外——引擎在 P2-10 会再校验一次）。
 */
export const DSL_RISK_LEVELS: readonly RiskLevel[] = ["low", "high"];
export const DSL_CONFIRMATION_MODES: readonly ConfirmationMode[] = [
  "auto",
  "required",
];

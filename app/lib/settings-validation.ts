// 带扩展名是故意的：本文件要能被 `node --test` 直接加载，校验规则必须能在不连数据库时被验证。
import { AppError } from "./app-error.ts";

/**
 * 补货参数的校验层。
 *
 * 这三列以前只有 schema 默认值（14/7/14），全仓没有任何写入路径 —— 页面上却写着
 * "System estimate"，商家以为系统按自己的交期算，实际是硬编码。这里把参数变成
 * 真正可编辑、可持久化、可校验的业务输入，并把「参数改了要重算建议」这件事坐实。
 */

/** 参数上下界：上界防止把建议量算成天文数字，下界允许 0（现货直发没有交期）。 */
export const REPLENISHMENT_LIMITS = {
  leadTimeDays: { min: 0, max: 180 },
  safetyStockDays: { min: 0, max: 90 },
  reviewPeriodDays: { min: 1, max: 90 },
} as const;

export type ReplenishmentFieldName = keyof typeof REPLENISHMENT_LIMITS;

export type ReplenishmentSettings = {
  leadTimeDays: number;
  safetyStockDays: number;
  reviewPeriodDays: number;
};

/**
 * 商家还没保存过参数时的初始值。必须与 schema 里 InventorySettings 三列的
 * @default(14 / 7 / 14) 保持一致 —— 校验层和存储层的默认值一旦分叉，
 * 「参数是否变了」的判定就会失真，重算会被无谓触发或被漏掉。
 */
export const DEFAULT_REPLENISHMENT_SETTINGS: ReplenishmentSettings = {
  leadTimeDays: 14,
  safetyStockDays: 7,
  reviewPeriodDays: 14,
};

export type ReplenishmentValidation =
  | { ok: true; value: ReplenishmentSettings; errors: Record<string, never> }
  | { ok: false; value: null; errors: Partial<Record<ReplenishmentFieldName, string>> };

/**
 * 把表单里的字符串收成整数：只接受十进制整数字面量，拒绝 "14.5"、"1e3"、"abc"、空串。
 * 返回 null 表示「这不是一个数」，由调用方给具体文案。供应商表单共用这套收口语义。
 */
export function parseInteger(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateField(
  field: ReplenishmentFieldName,
  label: string,
  raw: unknown,
  errors: Partial<Record<ReplenishmentFieldName, string>>,
): number | null {
  const { min, max } = REPLENISHMENT_LIMITS[field];
  const parsed = parseInteger(raw);
  if (parsed === null) {
    errors[field] = `${label} must be a whole number of days.`;
    return null;
  }
  if (parsed < min || parsed > max) {
    errors[field] = `${label} must be between ${min} and ${max} days.`;
    return null;
  }
  return parsed;
}

/**
 * 校验补货参数，永远不抛异常：返回 ok 与逐字段文案，让 UI 能把错误贴在对应输入框上。
 * 需要抛出的一路（action 层）用 toAppError。
 */
export function validateReplenishmentSettings(raw: {
  leadTimeDays?: unknown;
  safetyStockDays?: unknown;
  reviewPeriodDays?: unknown;
}): ReplenishmentValidation {
  const errors: Partial<Record<ReplenishmentFieldName, string>> = {};

  const leadTimeDays = validateField(
    "leadTimeDays",
    "Lead time",
    raw.leadTimeDays,
    errors,
  );
  const safetyStockDays = validateField(
    "safetyStockDays",
    "Safety stock",
    raw.safetyStockDays,
    errors,
  );
  const reviewPeriodDays = validateField(
    "reviewPeriodDays",
    "Purchase review cycle",
    raw.reviewPeriodDays,
    errors,
  );

  if (
    leadTimeDays === null ||
    safetyStockDays === null ||
    reviewPeriodDays === null
  ) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    value: { leadTimeDays, safetyStockDays, reviewPeriodDays },
    errors: {},
  };
}

/** 校验失败时折叠成一个可抛的 AppError，validation 类对商家是可行动的。 */
export function toReplenishmentSettingsError(
  validation: Extract<ReplenishmentValidation, { ok: false }>,
): AppError {
  const messages = Object.values(validation.errors).filter(Boolean);
  return new AppError(
    "validation",
    messages.join(" ") ||
      "These replenishment settings are not valid. Check the day values and try again.",
  );
}

/**
 * 参数是否真的变了。没变就不必重算建议 —— 重算会刷新 suggestedQuantity，
 * 把商家刚做过决策的记录搅成"数字自己动了"，那是很难解释的体验。
 */
export function hasReplenishmentChange(
  current: ReplenishmentSettings,
  next: ReplenishmentSettings,
): boolean {
  return (
    current.leadTimeDays !== next.leadTimeDays ||
    current.safetyStockDays !== next.safetyStockDays ||
    current.reviewPeriodDays !== next.reviewPeriodDays
  );
}

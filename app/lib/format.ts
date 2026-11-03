/**
 * 全站数据展示格式化的唯一出口（UI 重构 spec §10）。
 * 规则：货币用商店币种、数量千位分隔、百分比统一一位小数、
 * 缺失值统一 “—”、日期走商店时区。页面不得各自 toFixed。
 * 纯函数模块，node --test 可直接加载。
 */

/** 缺失值占位（em dash，与全站表格空值口径一致）。 */
export const MISSING = "—";

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 金额：商店币种 + 统一两位精度；无币种或无值时退化为千位数字 / “—”。 */
export function formatMoney(
  amount: number | null | undefined,
  currency?: string | null,
  locale = "en",
): string {
  if (!isNumber(amount)) return MISSING;
  if (!currency) return formatQuantity(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** 数量：千位分隔、无小数（库存/采购件数）。 */
export function formatQuantity(amount: number | null | undefined): string {
  if (!isNumber(amount)) return MISSING;
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(
    amount,
  );
}

/** 百分比：统一一位小数 + “%”（值按 0–100 传入）。 */
export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (!isNumber(value)) return MISSING;
  return `${value.toFixed(digits)}%`;
}

/** 比率：接口给的是 0–1 的小数，默认渲染成整数百分比（62%）；null → “—”。 */
export function formatRate(
  value: number | null | undefined,
  digits = 0,
): string {
  if (!isNumber(value)) return MISSING;
  return formatPercent(value * 100, digits);
}

/** 带小数的量：日均销量、覆盖天数这类需要保留一位精度的数字。 */
export function formatDecimal(
  value: number | null | undefined,
  digits = 1,
): string {
  if (!isNumber(value)) return MISSING;
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value);
}

/** 日期：商店时区（IANA 名，如 "America/New_York"）；缺值 “—”。 */
export function formatDate(
  date: Date | string | null | undefined,
  timeZone?: string | null,
): string {
  const value = typeof date === "string" ? new Date(date) : date;
  if (!value || Number.isNaN(value.getTime())) return MISSING;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(value);
}

/** 日期时间：同上并带时:分，用于同步台账/审计时间。 */
export function formatDateTime(
  date: Date | string | null | undefined,
  timeZone?: string | null,
): string {
  const value = typeof date === "string" ? new Date(date) : date;
  if (!value || Number.isNaN(value.getTime())) return MISSING;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(value);
}

// 带扩展名是故意的：本文件要能被 `node -ntest` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑、零依赖：12 个条件运算符的确定性求值（PRD §19），供 Condition Evaluator（P2-04）消费。
// 铁律：类型不匹配（如对 array 做数值比较）一律返回 false，绝不抛——求值器要让无效条件
// 安全落 pass:false 并给出可读明细，而不是把整条自动化炸成 FAILED。
export type ConditionOperatorName =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "in"
  | "not_in";

export type ConditionOperandType =
  | "number"
  | "string"
  | "boolean"
  | "bool"
  | "date"
  | "array";

/** 数值化：number 直通；十进制数字字符串才转换；其余 null（不参与比较）。 */
function toComparableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ISO 日期字符串 → 时间戳；非 ISO 形态（无法 Date.parse）返回 null。 */
function toComparableTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof actual === "number" || typeof expected === "number") {
    const a = toComparableNumber(actual);
    const e = toComparableNumber(expected);
    return a !== null && e !== null && a === e;
  }
  if (typeof actual === "string" && typeof expected === "string") return actual === expected;
  if (typeof actual === "boolean" && typeof expected === "boolean") return actual === expected;
  return false;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function compareNumbers(op: string, actual: unknown, expected: unknown): boolean {
  const a = toComparableNumber(actual);
  const e = toComparableNumber(expected);
  if (a === null || e === null) return false;
  switch (op) {
    case "greater_than":
      return a > e;
    case "greater_than_or_equal":
      return a >= e;
    case "less_than":
      return a < e;
    case "less_than_or_equal":
      return a <= e;
    default:
      return false;
  }
}

function compareDates(op: string, actual: unknown, expected: unknown): boolean {
  const a = toComparableTime(actual);
  const e = toComparableTime(expected);
  if (a === null || e === null) return false;
  switch (op) {
    case "greater_than":
      return a > e;
    case "greater_than_or_equal":
      return a >= e;
    case "less_than":
      return a < e;
    case "less_than_or_equal":
      return a <= e;
    case "equals":
      return a === e;
    case "not_equals":
      return a !== e;
    default:
      return false;
  }
}

/**
 * 求值单个运算符。type 是分派依据（编译期已由 DSL 声明），null actual 除空判定外一律 false（PRD §19）。
 * 布尔声明兼容 bool/boolean 两种写法（与 P1-14 校验器同口径）。
 */
export function evaluateOperator(
  op: ConditionOperatorName,
  actual: unknown,
  expected: unknown,
  type: ConditionOperandType,
): boolean {
  // 空值规则：null/undefined 参与非空判定一律 false；is_empty/is_not_empty 自带空语义。
  const isNullish = actual === null || actual === undefined;
  if (op === "is_empty") return isEmptyValue(actual);
  if (op === "is_not_empty") return !isEmptyValue(actual);
  if (isNullish) return false;

  switch (op) {
    case "equals":
      if (type === "date") return compareDates("equals", actual, expected);
      if (type === "array") {
        const list = asArray(actual);
        const want = asArray(expected);
        return !!list && !!want && list.length === want.length && list.every((x, i) => looseEquals(x, want[i]));
      }
      return looseEquals(actual, expected);
    case "not_equals":
      if (type === "date") return compareDates("not_equals", actual, expected);
      return !evaluateOperator("equals", actual, expected, type);
    case "greater_than":
    case "greater_than_or_equal":
    case "less_than":
    case "less_than_or_equal":
      if (type === "date") return compareDates(op, actual, expected);
      if (type === "number") return compareNumbers(op, actual, expected);
      return false; // string/bool/array 上序比较没有确定语义，一律判非
    case "contains": {
      if (type === "array" || Array.isArray(actual)) {
        const list = asArray(actual);
        return !!list && list.some((x) => looseEquals(x, expected));
      }
      if (type === "string" && typeof actual === "string" && typeof expected === "string")
        return actual.includes(expected);
      return false;
    }
    case "not_contains": {
      // 空串/空数组对 not_contains 的语义：什么都不含，判真。
      const list = asArray(actual);
      if (list) return !list.some((x) => looseEquals(x, expected));
      if (typeof actual === "string" && typeof expected === "string")
        return !actual.includes(expected);
      return false;
    }
    case "in": {
      const candidates = asArray(expected);
      if (!candidates) return false; // expected 不是集合，无「属于」可言
      if (Array.isArray(actual)) {
        // actual 为数组：任一元素属于候选集即真（如 customer.tags in [vip, wholesale]）
        return actual.some((x) => candidates.some((c) => looseEquals(x, c)));
      }
      return candidates.some((c) => looseEquals(actual, c));
    }
    case "not_in": {
      const candidates = asArray(expected);
      if (!candidates) return false;
      return !evaluateOperator("in", actual, expected, type);
    }
    default:
      return false;
  }
}

export const OPERATOR_NAMES: readonly ConditionOperatorName[] = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "in",
  "not_in",
];

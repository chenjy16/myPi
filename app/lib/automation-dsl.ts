// 带扩展名是故意的：本文件要能被 `node --test` 直接加载。
// 纯逻辑、零运行时依赖的 DSL 结构校验器，落实 docs/PRD-V2.0.md §21.3。
// 只做「结构 + 枚举」校验并**一次性收集全部错误**（UI 要能整屏列出问题，不做 fail-fast）；
// 字段白名单校验留接口：传入 allowedFields 时，条件里出现的 field 越界即判非法。
import { DSL_RISK_LEVELS, DSL_CONFIRMATION_MODES } from "./action-risk-policy.ts";

export type ValidationResult = { ok: boolean; errors: string[] };

export const DSL_VERSIONS: readonly string[] = ["2.0"];
export const AUTOMATION_STATUSES: readonly string[] = [
  "active",
  "paused",
  "deleted",
];
export const TRIGGER_TYPES: readonly string[] = [
  "order.created",
  "order.paid",
  "order.cancelled",
  "customer.created",
  "product.updated",
  "inventory.low",
  "daily.schedule",
];
export const TRIGGER_SOURCES: readonly string[] = [
  "shopify.webhook",
  "scheduler",
  "shopify.webhook+reconcile",
];
export const CONDITION_LOGIC: readonly string[] = ["AND", "OR"];
export const CONDITION_OPS: readonly string[] = [
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
// 布尔同时接受 "bool" 与 "boolean"，避免 DSL 书写口径分歧导致的误拒。
export const CONDITION_TYPES: readonly string[] = [
  "number",
  "string",
  "boolean",
  "bool",
  "date",
  "array",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 校验一条 Automation Definition。input 允许是任意值（未 parse 的 JSON 结果）。
 * @param allowedFields 可选字段白名单（来自 Trigger Registry）；提供时约束 conditions.field。
 */
export function validateDefinition(
  input: unknown,
  allowedFields?: ReadonlySet<string>,
): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["definition must be a JSON object"] };
  }

  // —— 顶层必填 ——
  for (const key of ["dslVersion", "name", "status", "trigger", "actions"]) {
    if (!hasOwn(input, key)) errors.push(`missing required field: ${key}`);
  }

  if (hasOwn(input, "dslVersion")) {
    if (typeof input.dslVersion !== "string")
      errors.push("dslVersion must be a string");
    else if (!DSL_VERSIONS.includes(input.dslVersion))
      errors.push(`dslVersion must be one of: ${DSL_VERSIONS.join(", ")}`);
  }

  if (hasOwn(input, "name") && typeof input.name !== "string")
    errors.push("name must be a string");

  if (hasOwn(input, "status")) {
    if (
      typeof input.status !== "string" ||
      !AUTOMATION_STATUSES.includes(input.status)
    )
      errors.push(`status must be one of: ${AUTOMATION_STATUSES.join(", ")}`);
  }

  if (hasOwn(input, "trigger")) validateTrigger(input.trigger, errors);
  if (hasOwn(input, "conditions"))
    validateConditions(input.conditions, allowedFields, errors);
  if (hasOwn(input, "actions")) validateActions(input.actions, errors);

  // 可选顶层字段只做形状校验（向后兼容：未知字段一律忽略，不报错——PRD §21.4 演进原则）
  if (hasOwn(input, "automationId") && typeof input.automationId !== "string")
    errors.push("automationId must be a string");
  if (hasOwn(input, "templateRef") && !isPlainObject(input.templateRef))
    errors.push("templateRef must be an object");

  return { ok: errors.length === 0, errors };
}

function validateTrigger(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push("trigger must be an object");
    return;
  }
  for (const key of ["type", "source"]) {
    if (!hasOwn(value, key)) errors.push(`trigger missing required field: ${key}`);
  }
  if (hasOwn(value, "type")) {
    if (
      typeof value.type !== "string" ||
      !TRIGGER_TYPES.includes(value.type)
    )
      errors.push(`trigger.type must be one of: ${TRIGGER_TYPES.join(", ")}`);
  }
  if (hasOwn(value, "source")) {
    if (
      typeof value.source !== "string" ||
      !TRIGGER_SOURCES.includes(value.source)
    )
      errors.push(`trigger.source must be one of: ${TRIGGER_SOURCES.join(", ")}`);
  }
  // topic 是可选便捷字段（P2-02 matcher 实际以 trigger.type 反查 Registry），给了就必须是字符串
  if (hasOwn(value, "topic") && typeof value.topic !== "string")
    errors.push("trigger.topic must be a string");
}

function validateConditions(
  value: unknown,
  allowedFields: ReadonlySet<string> | undefined,
  errors: string[],
): void {
  if (!isPlainObject(value)) {
    errors.push("conditions must be an object");
    return;
  }
  if (hasOwn(value, "logic")) {
    if (
      typeof value.logic !== "string" ||
      !CONDITION_LOGIC.includes(value.logic)
    )
      errors.push(`conditions.logic must be one of: ${CONDITION_LOGIC.join(", ")}`);
  }
  if (!hasOwn(value, "clauses")) return; // clauses 可选：无 clauses 视作无条件
  if (!Array.isArray(value.clauses)) {
    errors.push("conditions.clauses must be an array");
    return;
  }
  value.clauses.forEach((clause, i) => {
    if (!isPlainObject(clause)) {
      errors.push(`conditions.clauses[${i}] must be an object`);
      return;
    }
    for (const key of ["field", "op", "value", "type"]) {
      if (!hasOwn(clause, key))
        errors.push(`conditions.clauses[${i}] missing required field: ${key}`);
    }
    if (typeof clause.field === "string" && allowedFields) {
      if (!allowedFields.has(clause.field))
        errors.push(
          `conditions.clauses[${i}].field not in whitelist: ${clause.field}`,
        );
    }
    if (hasOwn(clause, "op")) {
      if (
        typeof clause.op !== "string" ||
        !CONDITION_OPS.includes(clause.op)
      )
        errors.push(
          `conditions.clauses[${i}].op must be one of: ${CONDITION_OPS.join(", ")}`,
        );
    }
    if (hasOwn(clause, "type")) {
      if (
        typeof clause.type !== "string" ||
        !CONDITION_TYPES.includes(clause.type)
      )
        errors.push(
          `conditions.clauses[${i}].type must be one of: ${CONDITION_TYPES.join(", ")}`,
        );
    }
  });
}

function validateActions(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("actions must be an array");
    return;
  }
  if (value.length < 1) errors.push("actions must contain at least 1 item");
  value.forEach((action, i) => {
    if (!isPlainObject(action)) {
      errors.push(`actions[${i}] must be an object`);
      return;
    }
    if (!hasOwn(action, "actionId") || typeof action.actionId !== "string")
      errors.push(`actions[${i}].actionId must be a non-empty string`);
    if (!hasOwn(action, "params") || !isPlainObject(action.params))
      errors.push(`actions[${i}].params must be an object`);
    // 目标实体（order/customer/product）：可选，缺省由引擎按事件 entityType 推断；给了就必须是字符串
    if (hasOwn(action, "target") && typeof action.target !== "string")
      errors.push(`actions[${i}].target must be a string`);
    if (hasOwn(action, "riskLevel")) {
      if (
        typeof action.riskLevel !== "string" ||
        !DSL_RISK_LEVELS.includes(action.riskLevel as never)
      )
        errors.push(
          `actions[${i}].riskLevel must be one of: ${DSL_RISK_LEVELS.join(", ")}`,
        );
    }
    if (hasOwn(action, "confirmation")) {
      if (
        typeof action.confirmation !== "string" ||
        !DSL_CONFIRMATION_MODES.includes(action.confirmation as never)
      )
        errors.push(
          `actions[${i}].confirmation must be one of: ${DSL_CONFIRMATION_MODES.join(", ")}`,
        );
    }
  });
}

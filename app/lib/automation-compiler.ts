// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：Definition 编译器（PRD §21.4 / P2-18）——DSL → 冻结的运行时计划。
// 编译一次、处处执行：引擎（P2-11）只消费编译产物，不再解析原始 DSL；AutomationVersion 冻结
// 存编译结果 + compiledVersion（dslVersion + planHash），老执行记录据此可确定性回放。
// 校验复用 P1-14 validateDefinition（白名单来自 P2-01 trigger-registry），参数闸口在 P2-06。
// 非法输入抛 AggregateError：错误清单完整透传给 UI，绝不带病产出半成品计划。
import {
  type CompiledClause,
  type CompiledConditions,
} from "./condition-evaluator.ts";
import type {
  ConditionOperandType,
  ConditionOperatorName,
} from "./condition-operators.ts";
import { fieldWhitelist, getTrigger } from "./trigger-registry.ts";
import {
  getAction,
  validateActionParams,
  validateActionTarget,
} from "./action-registry.ts";
import {
  confirmationForAction,
  type ConfirmationMode,
  type RiskLevel,
} from "./action-risk-policy.ts";
import { validateDefinition, type ValidationResult } from "./automation-dsl.ts";

export const COMPILER_VERSION = "2.0";

export type CompiledActionStep = {
  actionId: string;
  /** 步骤目标实体（order/customer/product）；null = 由引擎按事件 entityType 推断。 */
  target: string | null;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  confirmation: ConfirmationMode;
};

export type CompiledPlan = {
  compiledVersion: string;
  dslVersion: string;
  /** 内容 hash：同 DSL 编译结果必同 hash，回放校验/版本去重都靠它。 */
  planHash: string;
  triggerType: string;
  triggerSource: string;
  /** P2-02 matcher 的索引键：首版即 triggerType（topic 由 Registry 反查，不单方面绑定）。 */
  triggerMatcherKey: string;
  conditions: CompiledConditions;
  actions: CompiledActionStep[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** FNV-1a 32bit（与 loop-protector 同族工具，编译器零依赖原则下不引 crypto）。 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) => `${k}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(",")}}`;
}

/**
 * 编译一条 Automation Definition。流程：trigger 查注册表 → 白名单进 DSL 校验 →
 * 条件逐条编译 → 动作逐步校验（参数/目标/风险缺省）→ 冻结计划。
 */
export function compile(input: unknown): CompiledPlan {
  const errors: string[] = [];
  if (!isPlainObject(input))
    throw new AggregateError(["definition must be a JSON object"], "Automation definition is not an object");

  // 1) trigger 必须先能查表——白名单是 DSL 校验的输入，查不到表就没有校验基线。
  const trigger = isPlainObject(input.trigger) ? input.trigger : null;
  if (!trigger) errors.push("trigger must be an object");
  let whitelist: ReadonlySet<string> = new Set();
  let triggerType = "";
  let triggerSource = "";
  if (trigger) {
    if (typeof trigger.type !== "string") {
      errors.push("trigger.type must be a string");
    } else {
      triggerType = trigger.type;
      try {
        const definition = getTrigger(triggerType);
        whitelist = fieldWhitelist(triggerType);
        if (
          typeof trigger.source === "string" &&
          trigger.source !== definition.source
        )
          errors.push(
            `trigger.source "${trigger.source}" does not match registry "${definition.source}"`,
          );
        triggerSource = definition.source;
      } catch {
        errors.push(`trigger.type not in registry: ${triggerType}`);
      }
    }
  }

  // 2) 其余结构走 P1-14 校验器（白名单注入，越界字段在编译期就拦住）。
  const validation: ValidationResult = validateDefinition(
    input,
    whitelist.size > 0 ? whitelist : undefined,
  );
  errors.push(...validation.errors);

  // 2.5) 全量预检：白名单外字段/未登记动作/坏 target 在结构合法时就收集完，
  //      一次性报全部问题（商家改一处就报一病的反馈循环最差）。
  const definition = input as Record<string, unknown>;
  const rawActions = Array.isArray(definition.actions) ? (definition.actions as unknown[]) : [];
  for (const raw of rawActions) {
    if (!isPlainObject(raw) || typeof raw.actionId !== "string") continue; // 形状问题校验器已报
    try {
      getAction(raw.actionId);
    } catch {
      errors.push(`actions[${raw.actionId}] not in registry: ${raw.actionId}`);
      continue;
    }
    if (typeof raw.target === "string")
      errors.push(...validateActionTarget(raw.actionId, raw.target));
    const provided = isPlainObject(raw.params) ? raw.params : {};
    for (const key of Object.keys(provided)) {
      if (key !== "tags" && !getAction(raw.actionId).paramSchema[key])
        errors.push(`actions[${raw.actionId}]: unknown param: ${key}`);
    }
  }

  if (errors.length)
    throw new AggregateError(errors, "Automation definition failed to compile");

  // —— 以下 input/trigger 的形态已由校验器担保 ——
  const triggerParams = isPlainObject(trigger!.params) ? trigger!.params : {};
  // topic 可在 trigger 根（PRD 示例形状）或 trigger.params（DSL 早期形态）：两处都读，编译后固化
  const topic =
    typeof trigger!.topic === "string"
      ? trigger!.topic
      : typeof triggerParams.topic === "string"
        ? triggerParams.topic
        : null;

  // 3) 条件编译：logic 缺省 AND；clause 字段已过白名单，类型在此固化。
  const conditionsRaw = isPlainObject(definition.conditions)
    ? (definition.conditions as Record<string, unknown>)
    : null;
  const logic = conditionsRaw?.logic === "OR" ? "OR" : "AND";
  const rawClauses = Array.isArray(conditionsRaw?.clauses)
    ? (conditionsRaw!.clauses as unknown[])
    : [];
  const clauses: CompiledClause[] = rawClauses.map((c) => {
    const clause = c as Record<string, unknown>;
    return {
      field: String(clause.field),
      op: clause.op as ConditionOperatorName,
      value: clause.value,
      type: clause.type as ConditionOperandType,
    };
  });
  const conditions: CompiledConditions = { logic, clauses };

  // 4) 动作编译：tags 数组展开成逐步打标（PRD 示例①）；风险缺省按注册表派生，
  //    high 风险永不被 DSL 降级成 auto（Safe by Default，P6）。
  const actionsRaw = definition.actions as unknown[];
  const steps: CompiledActionStep[] = [];
  for (const raw of actionsRaw) {
    const action = raw as Record<string, unknown>;
    const actionId = action.actionId as string;
    let definition_: ReturnType<typeof getAction>;
    try {
      definition_ = getAction(actionId); // 未知 id 在 DSL 校验后这里兼作运行前闸门
    } catch {
      errors.push(`actions[${actionId}] not in registry: ${actionId}`);
      continue;
    }
    const provided = isPlainObject(action.params) ? action.params : {};
    // tags: [...] 语法糖 → 每个标签一个独立步骤（执行器一步一 Mutation，幂等口径不变）
    const tagList = Array.isArray(provided.tags)
      ? (provided.tags as unknown[])
      : null;
    if (tagList && tagList.length === 0)
      errors.push(`actions[${actionId}]: tags must contain at least one entry`);
    const expansions: unknown[] = tagList ?? [undefined];
    for (const tagValue of expansions) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(provided)) {
        if (k !== "tags") params[k] = v;
      }
      if (tagList) {
        if (typeof tagValue !== "string" || tagValue.trim() === "") {
          errors.push(
            `actions[${actionId}]: tags entries must be non-empty strings`,
          );
        } else {
          params.tag = tagValue.trim();
        }
      }
      // 默认值填充：DSL 缺省字段以注册表 defaultValue 固化进计划（回放不再查表）
      for (const [name, field] of Object.entries(definition_.paramSchema)) {
        if (params[name] === undefined && field.defaultValue !== undefined)
          params[name] = field.defaultValue;
      }
      const paramErrors = validateActionParams(actionId, params);
      errors.push(...paramErrors);
      const target =
        typeof action.target === "string"
          ? action.target.toLowerCase()
          : null;
      if (target) errors.push(...validateActionTarget(actionId, target));
      const declaredRisk =
        action.riskLevel === "low" || action.riskLevel === "high"
          ? (action.riskLevel as RiskLevel)
          : undefined;
      const riskLevel = declaredRisk ?? definition_.riskLevel;
      const derived = confirmationForAction(actionId);
      const declaredConfirmation =
        action.confirmation === "auto" || action.confirmation === "required"
          ? (action.confirmation as ConfirmationMode)
          : undefined;
      // high 风险只能 required；low 风险尊重 DSL 声明但不得越过派生下限
      const confirmation: ConfirmationMode =
        riskLevel === "high"
          ? "required"
          : declaredConfirmation === "required"
            ? "required"
            : derived;
      steps.push({ actionId, target, params, riskLevel, confirmation });
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Automation definition failed to compile");

  const planBase = {
    compiledVersion: COMPILER_VERSION,
    dslVersion: definition.dslVersion as string,
    triggerType,
    triggerSource,
    triggerMatcherKey: topic ? `${triggerType}|${topic}` : triggerType,
    conditions,
    actions: steps,
  };
  const planHash = hashString(stableStringify(planBase));
  return Object.freeze({ ...planBase, planHash });
}

/** 回放一致性：把存量计划与当前编译结果对 hash——版本漂移立即可见，不静默重算。 */
export function planMatches(plan: CompiledPlan, definition: unknown): boolean {
  try {
    return compile(definition).planHash === plan.planHash;
  } catch {
    return false;
  }
}

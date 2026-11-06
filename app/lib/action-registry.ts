// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑、零依赖：Action 元数据唯一登记处（PRD §20）——参数 schema、所需 scope、风险/确认、
// 幂等与错误文案模板。风险一律经 P1-13 action-risk-policy 派生，缺省 high/required，绝不放宽。
// 刻意不注册「改价 / 删单」（PRD §8 非目标）：未知 actionId 在编译期与运行期都不可达。
import {
  actionRiskLevel,
  confirmationForAction,
  type ConfirmationMode,
  type RiskLevel,
} from "./action-risk-policy.ts";

export type ParamFieldKind = "string" | "number" | "boolean" | "enum" | "stringArray";

export type ParamFieldSchema = {
  kind: ParamFieldKind;
  required: boolean;
  defaultValue?: string | number | boolean | null;
  /** enum 型的合法取值。 */
  choices?: readonly string[];
};

export type ActionDefinition = {
  actionId: string;
  /** 参数名 → schema；驱动编译期校验与默认值填充。 */
  paramSchema: Readonly<Record<string, ParamFieldSchema>>;
  /** 执行所需 scope（声明式登记；扩权动作属 Phase 4 决策，本表不改 toml）。 */
  requiredScopes: readonly string[];
  riskLevel: RiskLevel;
  confirmation: ConfirmationMode;
  /** 幂等策略说明（供执行器实现与商家文档同口径引用）。 */
  idempotency: string;
  /** 商家可读错误模板；{detail} 只放安全摘要，GraphQL 原始堆栈永不透传（P3）。 */
  errorTemplate: string;
  /** 目标资源类型（tag 类动作按 trigger 目标选；空表示与实体无关）。 */
  targetEntities: readonly string[];
};

/** 首版登记的动作。新增动作必须在此显式声明风险，否则等于不存在。 */
const ACTIONS: readonly ActionDefinition[] = [
  {
    actionId: "tags.add",
    paramSchema: {
      tag: { kind: "string", required: true },
    },
    requiredScopes: ["write_orders", "write_customers", "write_products"],
    riskLevel: actionRiskLevel("tags.add"),
    confirmation: confirmationForAction("tags.add"),
    idempotency: "先读现有 tags，缺失才写；重复执行无副作用（P2-08）",
    errorTemplate: "Failed to add tag “{tag}”: {detail}",
    targetEntities: ["Order", "Customer", "Product"],
  },
  {
    actionId: "tags.remove",
    paramSchema: {
      tag: { kind: "string", required: true },
    },
    requiredScopes: ["write_orders", "write_customers", "write_products"],
    riskLevel: actionRiskLevel("tags.remove"),
    confirmation: confirmationForAction("tags.remove"),
    idempotency: "标签不存在视为 no-op 成功（P2-08）",
    errorTemplate: "Failed to remove tag “{tag}”: {detail}",
    targetEntities: ["Order", "Customer", "Product"],
  },
  {
    actionId: "email.send",
    paramSchema: {
      template: { kind: "string", required: true },
      to: { kind: "string", required: false, defaultValue: null },
      // 模板变量名清单（PRD 示例③ 的 vars）：声明要注入的上下文字段，值由执行器运行时补齐
      vars: { kind: "stringArray", required: false },
    },
    requiredScopes: [],
    riskLevel: actionRiskLevel("email.send"),
    confirmation: confirmationForAction("email.send"),
    idempotency: "以 ExecutionStep.id 作发送去重键（P2-09）",
    errorTemplate: "Failed to send email “{template}”: {detail}",
    targetEntities: [],
  },
  {
    actionId: "webhook.send",
    paramSchema: {
      integrationId: { kind: "string", required: true },
    },
    requiredScopes: [],
    riskLevel: actionRiskLevel("webhook.send"),
    confirmation: confirmationForAction("webhook.send"),
    idempotency: "出站携带幂等键 header，接收方据此去重（P2-09）",
    errorTemplate: "Failed to call your webhook endpoint: {detail}",
    targetEntities: [],
  },
  {
    actionId: "product.updateStatus",
    paramSchema: {
      status: {
        kind: "enum",
        required: true,
        choices: ["ACTIVE", "DRAFT", "ARCHIVED"] as const,
      },
    },
    requiredScopes: ["write_products"],
    riskLevel: actionRiskLevel("product.updateStatus"),
    confirmation: confirmationForAction("product.updateStatus"),
    idempotency: "productUpdate 幂等（同状态重写无额外副作用，V-11）",
    errorTemplate: "Failed to change product status to “{status}”: {detail}",
    targetEntities: ["Product"],
  },
] as const;

const BY_ID = new Map(ACTIONS.map((a) => [a.actionId, a]));

/** 按 id 取动作；未知 id 抛错——编译期（P2-18）与运行期（P2-10）共用这道闸。 */
export function getAction(actionId: string): ActionDefinition {
  const action = BY_ID.get(actionId);
  if (!action) throw new Error(`Unknown action id: ${actionId}`);
  return action;
}

export function listActions(): readonly ActionDefinition[] {
  return ACTIONS;
}

/** 参数默认值填充 + 必填/枚举校验：返回错误清单（空即合法），编译期使用。 */
export function validateActionParams(
  actionId: string,
  params: Record<string, unknown>,
): string[] {
  const action = getAction(actionId);
  const errors: string[] = [];
  for (const [name, schema] of Object.entries(action.paramSchema)) {
    const provided = params[name];
    if (provided === undefined || provided === null || provided === "") {
      if (schema.required && schema.defaultValue === undefined)
        errors.push(`actions[${actionId}]: missing required param: ${name}`);
      continue;
    }
    if (schema.kind === "enum") {
      if (
        typeof provided !== "string" ||
        !(schema.choices ?? []).includes(provided)
      )
        errors.push(
          `actions[${actionId}]: param ${name} must be one of: ${(schema.choices ?? []).join(", ")}`,
        );
    }
    if (schema.kind === "number" && typeof provided !== "number") {
      errors.push(`actions[${actionId}]: param ${name} must be a number`);
    }
    if (schema.kind === "string" && typeof provided !== "string") {
      errors.push(`actions[${actionId}]: param ${name} must be a string`);
    }
    if (
      schema.kind === "stringArray" &&
      !(Array.isArray(provided) && provided.every((x) => typeof x === "string"))
    ) {
      errors.push(`actions[${actionId}]: param ${name} must be an array of strings`);
    }
  }
  // 未登记的参数名直接拒绝：防 DSL 夹带越界字段绕过白名单思想
  for (const name of Object.keys(params)) {
    if (!action.paramSchema[name])
      errors.push(`actions[${actionId}]: unknown param: ${name}`);
  }
  return errors;
}

/** 动作级 target（步骤目标实体）校验：与登记的目标实体清单大小写无关匹配。 */
export function validateActionTarget(actionId: string, target: string): string[] {
  const action = getAction(actionId);
  if (action.targetEntities.length === 0) return [];
  const allowed = action.targetEntities.map((e) => e.toLowerCase());
  return allowed.includes(target.toLowerCase())
    ? []
    : [`actions[${actionId}]: target must be one of: ${allowed.join(", ")}`];
}

export const KNOWN_ACTION_IDS: readonly string[] = ACTIONS.map(
  (a) => a.actionId,
);

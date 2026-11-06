// 带扩展名是故意的：本模块要能被 `node --test` 直接加载。
// 启用向导的纯逻辑（PRD §22 / P3-08）：把 HTML 表单的字符串参数校正成类型化值 + 字段级校验，
// 并给出商家语言的实时可读预览。路由只喂原始表单、拿回 {values|fieldErrors}，
// 真正的 DSL 构造与编译仍在 automations-core（服务端二次校验，前端预览不等于放行）。
import type { CompiledPlan } from "./automation-compiler.ts";
import type { TemplateDefinition, TemplateParam } from "./template-catalog.ts";

export type CoerceResult = {
  ok: boolean;
  values: Record<string, unknown>;
  fieldErrors: Record<string, string>;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function coerceOne(
  param: TemplateParam,
  raw: string | undefined,
): { value?: unknown; error?: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    if (param.required) return { error: `${param.label} is required` };
    return {}; // 可选项留空 = 不下发该键，回落模板 default
  }
  switch (param.type) {
    case "amount":
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { error: `${param.label} must be a number` };
      if (n < 0) return { error: `${param.label} cannot be negative` };
      return { value: n };
    }
    case "email": {
      if (!EMAIL_RE.test(trimmed))
        return { error: `${param.label} must be a valid email address` };
      return { value: trimmed };
    }
    case "date": {
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) return { error: `${param.label} is not a valid date` };
      return { value: d.toISOString() };
    }
    case "select": {
      const options = param.options ?? [];
      if (!options.includes(trimmed))
        return { error: `${param.label} must be one of: ${options.join(", ")}` };
      return { value: trimmed };
    }
    case "tag":
    case "text":
    default:
      return { value: trimmed };
  }
}

export function validateTemplateParams(
  template: TemplateDefinition,
  raw: Record<string, string | undefined>,
): CoerceResult {
  const values: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const param of template.params) {
    const result = coerceOne(param, raw[param.key]);
    if (result.error) fieldErrors[param.key] = result.error;
    else if (result.value !== undefined) values[param.key] = result.value;
  }
  return { ok: Object.keys(fieldErrors).length === 0, values, fieldErrors };
}

// —— 商家语言预览（纯文案，绝不出现 DSL/Mutation/GID 术语）——

const TRIGGER_PHRASE: Record<string, string> = {
  "order.created": "an order is created",
  "order.paid": "an order is paid",
  "order.cancelled": "an order is cancelled",
  "customer.created": "a new customer signs up",
  "product.updated": "a product is updated",
  "inventory.low": "a product runs low on stock",
  "daily.schedule": "your daily schedule runs",
};

/** 条件子句：把关键数值/关键词揉进一句人话；无值时给通用描述。 */
function conditionPhrase(template: TemplateDefinition, values: Record<string, unknown>): string {
  const parts: string[] = [];
  const amount = values.amount;
  if (typeof amount === "number") parts.push(`the order total is at least ${amount}`);
  const threshold = values.threshold;
  if (typeof threshold === "number") parts.push(`available stock is at or below ${threshold}`);
  const keyword = values.keyword;
  if (typeof keyword === "string" && keyword) parts.push(`the note or title contains “${keyword}”`);
  return parts.length ? ` when ${parts.join(" and ")}` : "";
}

export function describeTemplate(
  template: TemplateDefinition,
  values: Record<string, unknown>,
): { headline: string; steps: string[] } {
  const trigger = TRIGGER_PHRASE[template.triggerType] ?? template.triggerType;
  const headline = `When ${trigger}${conditionPhrase(template, values)}`;
  return { headline, steps: [...template.stepsPreview] };
}

/** 用校验后的值产出计划预览（供确认页展示"将发生 N 步"）；不抛，交由服务端建库时再校验。 */
export function previewStepCount(plan: CompiledPlan | null): number {
  return plan?.actions.length ?? 0;
}

// —— 存量计划的商家可读回放（列表摘要 + 详情视图，P3-10/11）——

const FIELD_LABEL: Record<string, string> = {
  total_price: "the order total",
  currency: "the order currency",
  customer_tags: "the customer tags",
  cancelled_at: "the cancellation",
  tags: "the customer tags",
  note: "the customer note",
  status: "the product status",
  title: "the product title",
  available: "available stock",
  location_id: "the location",
};

const OP_LABEL: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  greater_than: "is more than",
  greater_than_or_equal: "is at least",
  less_than: "is less than",
  less_than_or_equal: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  in: "is one of",
  not_in: "is not one of",
};

const PLAN_ACTION_LABEL: Record<string, string> = {
  "tags.add": "Add a tag",
  "tags.remove": "Remove a tag",
  "email.send": "Send an email",
  "webhook.send": "Call your webhook",
  "product.updateStatus": "Change product status",
};

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function describeClause(clause: { field: string; op: string; value: unknown }): string {
  const field = FIELD_LABEL[clause.field] ?? clause.field;
  const op = OP_LABEL[clause.op] ?? clause.op;
  const needsValue = !(clause.op === "is_empty" || clause.op === "is_not_empty");
  return needsValue ? `${field} ${op} ${describeValue(clause.value)}` : `${field} ${op}`;
}

/** 触发器一句话摘要（列表行用）。 */
export function triggerSummary(type: string): string {
  return TRIGGER_PHRASE[type] ? `When ${TRIGGER_PHRASE[type]}` : type;
}

/**
 * 把落库的条件求值结果翻成逐条商家可读行（P3-13 详情可解释）：
 * 每条给出条件文案、当时的实际值、以及是否满足；无谓 Mutation/GID 术语。
 */
export function describeEvaluation(result: {
  logic: "AND" | "OR";
  clauses: readonly { field: string; op: string; expected: unknown; actual: unknown; pass: boolean; invalidField?: boolean }[];
}): { text: string; actual: string; pass: boolean; invalid: boolean }[] {
  return result.clauses.map((c) => {
    const field = FIELD_LABEL[c.field] ?? c.field;
    const op = OP_LABEL[c.op] ?? c.op;
    const needsValue = !(c.op === "is_empty" || c.op === "is_not_empty");
    const text = needsValue ? `${field} ${op} ${describeValue(c.expected)}` : `${field} ${op}`;
    return {
      text,
      actual: c.invalidField ? "not available" : describeValue(c.actual),
      pass: c.pass,
      invalid: Boolean(c.invalidField),
    };
  });
}

/** 把冻结计划翻成商家可读的三段：触发 / 条件 / 动作（不含 DSL 术语）。 */
export function describePlan(plan: CompiledPlan): {
  trigger: string;
  conditions: string[];
  actions: string[];
} {
  const conditions = plan.conditions.clauses.map(describeClause);
  return {
    trigger: triggerSummary(plan.triggerType),
    conditions: conditions.length
      ? conditions.map((c, i) => (i === 0 ? c : `${plan.conditions.logic === "OR" ? "or" : "and"} ${c}`))
      : ["Always runs when the trigger fires"],
    actions: plan.actions.map(
      (a) =>
        `${PLAN_ACTION_LABEL[a.actionId] ?? a.actionId}${
          a.params.tag ? ` “${String(a.params.tag)}”` : ""
        }${a.params.status ? ` to ${String(a.params.status)}` : ""}`,
    ),
  };
}

/** 单个步骤动作的商家可读标签（执行详情时间线用）。 */
export function stepActionLabel(actionId: string): string {
  return PLAN_ACTION_LABEL[actionId] ?? actionId;
}

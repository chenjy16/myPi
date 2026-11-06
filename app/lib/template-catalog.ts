// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑、零运行时依赖：模板目录（PRD §22 / P3-05）。数据驱动——画廊、向导、创建服务
// 全部读这张表，不再各写一份。每个模板的 definitionTemplate(params) 必须产出能通过
// P1-14 validateDefinition（含 trigger 字段白名单）且被 P2-18 compile 接受的 DSL。
// requiresProtectedData 一律从 trigger-registry 派生，绝不手写：订单/客户类受 R1 审批墙
// 阻塞的诚实边界（V-5）在 UI 与目录层同一口径，避免"启用即假装在跑"。
import {
  fieldWhitelist,
  getTrigger,
  type TriggerTypeId,
} from "./trigger-registry.ts";

export type TemplateParamType =
  | "amount"
  | "number"
  | "tag"
  | "text"
  | "email"
  | "date"
  | "select";

export type TemplateParam = {
  /** DSL 里引用该值的键；也用作表单 name。 */
  key: string;
  label: string;
  type: TemplateParamType;
  required: boolean;
  /** 缺省值：既驱动表单预填，也让 definitionTemplate({}) 产出合法 DSL（契约测依赖）。 */
  default?: string | number;
  /** select 型的合法取值。 */
  options?: readonly string[];
  /** 该参数映射到哪个条件字段（白名单核对/预览用）。 */
  whitelistField?: string;
  helpText?: string;
};

export type TemplateTier = "LAUNCH" | "EXTENDED";

export type TemplateDefinition = {
  id: string;
  name: string;
  oneLine: string;
  category: string;
  tier: TemplateTier;
  triggerType: TriggerTypeId;
  params: readonly TemplateParam[];
  /** 由参数产出待校验/待编译的 DSL 对象（未知键忽略，缺省回落 default）。 */
  definitionTemplate: (params: Record<string, unknown>) => unknown;
  /** 是否属 Protected Customer Data：从 trigger-registry 派生，非手写。 */
  requiresProtectedData: boolean;
  /** 画廊用的商家语言步骤摘要（不含 Mutation/GID 等术语）。 */
  stepsPreview: readonly string[];
};

/** 取参数值：显式给定优先，否则回落该 param 的 default，最后落空串/0 保底。 */
function paramValue(
  params: Record<string, unknown>,
  def: TemplateParam,
): unknown {
  const provided = params[def.key];
  if (provided !== undefined && provided !== null && provided !== "") {
    return provided;
  }
  return def.default;
}

function num(params: Record<string, unknown>, def: TemplateParam): number {
  const raw = paramValue(params, def);
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function str(params: Record<string, unknown>, def: TemplateParam): string {
  return String(paramValue(params, def) ?? "");
}

/** DSL 顶层骨架：dslVersion/name/status + 从注册表取的真实 trigger 形状（含 topic）。 */
function dslSkeleton(t: TemplateDefinition, name: string): Record<string, unknown> {
  const trigger = getTrigger(t.triggerType);
  return {
    dslVersion: "2.0",
    name,
    status: "active",
    trigger: {
      type: trigger.type,
      source: trigger.source,
      // scheduler 触发无 topic；给了字符串会被 DSL 校验拒绝，故条件展开
      ...(trigger.topic === null ? {} : { topic: trigger.topic }),
    },
  };
}

// —— 首发 5 模板（LAUNCH）——

const VIP_TAG: TemplateDefinition = {
  id: "T1-vip-tag",
  name: "VIP order tagging",
  oneLine: "Automatically tag paid orders above a set value as VIP.",
  category: "Orders",
  tier: "LAUNCH",
  triggerType: "order.paid",
  requiresProtectedData: getTrigger("order.paid").protectedCustomerData,
  params: [
    {
      key: "amount",
      label: "Order value threshold",
      type: "amount",
      required: true,
      default: 500,
      whitelistField: "total_price",
      helpText: "Tag orders whose total is at least this amount.",
    },
    {
      key: "tag",
      label: "Tag to add",
      type: "tag",
      required: true,
      default: "VIP",
    },
  ],
  stepsPreview: [
    "When an order is paid and its total reaches your threshold",
    "Add a tag to the order",
  ],
  definitionTemplate: (params) => {
    const amount = VIP_TAG.params[0];
    const tag = VIP_TAG.params[1];
    return {
      ...dslSkeleton(VIP_TAG, VIP_TAG.name),
      conditions: {
        logic: "AND",
        clauses: [
          {
            field: "total_price",
            op: "greater_than_or_equal",
            value: num(params, amount),
            type: "number",
          },
        ],
      },
      actions: [{ actionId: "tags.add", params: { tag: str(params, tag) } }],
    };
  },
};

const HIGH_VALUE_EMAIL: TemplateDefinition = {
  id: "T2-high-value-email",
  name: "High-value order notification",
  oneLine: "Email your team when a paid order crosses a value threshold.",
  category: "Orders",
  tier: "LAUNCH",
  triggerType: "order.paid",
  requiresProtectedData: getTrigger("order.paid").protectedCustomerData,
  params: [
    {
      key: "amount",
      label: "Order value threshold",
      type: "amount",
      required: true,
      default: 1000,
      whitelistField: "total_price",
    },
    {
      key: "template",
      label: "Email template",
      type: "text",
      required: true,
      default: "high-value-order",
    },
    {
      key: "recipient",
      label: "Notify this address",
      type: "email",
      required: false,
      default: "",
      helpText: "Leave blank to use the order's own contact.",
    },
  ],
  stepsPreview: [
    "When an order is paid and its total reaches your threshold",
    "Send a notification email",
  ],
  definitionTemplate: (params) => {
    const amount = HIGH_VALUE_EMAIL.params[0];
    const template = HIGH_VALUE_EMAIL.params[1];
    const recipient = HIGH_VALUE_EMAIL.params[2];
    const emailParams: Record<string, unknown> = {
      template: str(params, template),
    };
    const to = paramValue(params, recipient);
    if (to) emailParams.to = String(to);
    return {
      ...dslSkeleton(HIGH_VALUE_EMAIL, HIGH_VALUE_EMAIL.name),
      conditions: {
        logic: "AND",
        clauses: [
          {
            field: "total_price",
            op: "greater_than_or_equal",
            value: num(params, amount),
            type: "number",
          },
        ],
      },
      actions: [{ actionId: "email.send", params: emailParams }],
    };
  },
};

const LOW_STOCK_TAG: TemplateDefinition = {
  id: "T4-low-stock",
  name: "Low stock alert",
  oneLine: "Tag products when available inventory drops to your reorder point.",
  category: "Inventory",
  tier: "LAUNCH",
  triggerType: "inventory.low",
  requiresProtectedData: getTrigger("inventory.low").protectedCustomerData,
  params: [
    {
      key: "threshold",
      label: "Reorder point",
      type: "number",
      required: true,
      default: 5,
      whitelistField: "available",
      helpText: "Trigger when available units are at or below this number.",
    },
    {
      key: "tag",
      label: "Tag to add",
      type: "tag",
      required: true,
      default: "restock",
    },
  ],
  stepsPreview: [
    "When a product's available stock drops to your reorder point",
    "Add a tag to the product",
  ],
  definitionTemplate: (params) => {
    const threshold = LOW_STOCK_TAG.params[0];
    const tag = LOW_STOCK_TAG.params[1];
    return {
      ...dslSkeleton(LOW_STOCK_TAG, LOW_STOCK_TAG.name),
      conditions: {
        logic: "AND",
        clauses: [
          {
            field: "available",
            op: "less_than_or_equal",
            value: num(params, threshold),
            type: "number",
          },
        ],
      },
      actions: [{ actionId: "tags.add", params: { tag: str(params, tag) } }],
    };
  },
};

const CANCELLED_ORDER_EMAIL: TemplateDefinition = {
  id: "T5-cancel-notify",
  name: "Cancelled order notice",
  oneLine: "Send a notice email whenever an order is cancelled.",
  category: "Orders",
  tier: "LAUNCH",
  triggerType: "order.cancelled",
  requiresProtectedData: getTrigger("order.cancelled").protectedCustomerData,
  params: [
    {
      key: "template",
      label: "Email template",
      type: "text",
      required: true,
      default: "order-cancelled",
    },
    {
      key: "recipient",
      label: "Notify this address",
      type: "email",
      required: false,
      default: "",
    },
  ],
  stepsPreview: [
    "When an order is cancelled",
    "Send a cancellation email",
  ],
  definitionTemplate: (params) => {
    const template = CANCELLED_ORDER_EMAIL.params[0];
    const recipient = CANCELLED_ORDER_EMAIL.params[1];
    const emailParams: Record<string, unknown> = {
      template: str(params, template),
    };
    const to = paramValue(params, recipient);
    if (to) emailParams.to = String(to);
    return {
      ...dslSkeleton(CANCELLED_ORDER_EMAIL, CANCELLED_ORDER_EMAIL.name),
      actions: [{ actionId: "email.send", params: emailParams }],
    };
  },
};

const CUSTOMER_SEGMENT_TAG: TemplateDefinition = {
  id: "T7-customer-segment",
  name: "Customer segmentation",
  oneLine: "Tag new customers whose note mentions a keyword (e.g. wholesale).",
  category: "Customers",
  tier: "LAUNCH",
  triggerType: "customer.created",
  requiresProtectedData: getTrigger("customer.created").protectedCustomerData,
  params: [
    {
      key: "keyword",
      label: "Note contains",
      type: "text",
      required: true,
      default: "wholesale",
      whitelistField: "note",
    },
    {
      key: "tag",
      label: "Tag to add",
      type: "tag",
      required: true,
      default: "wholesale",
    },
  ],
  stepsPreview: [
    "When a customer is created and their note contains your keyword",
    "Add a tag to the customer",
  ],
  definitionTemplate: (params) => {
    const keyword = CUSTOMER_SEGMENT_TAG.params[0];
    const tag = CUSTOMER_SEGMENT_TAG.params[1];
    return {
      ...dslSkeleton(CUSTOMER_SEGMENT_TAG, CUSTOMER_SEGMENT_TAG.name),
      conditions: {
        logic: "AND",
        clauses: [
          {
            field: "note",
            op: "contains",
            value: str(params, keyword),
            type: "string",
          },
        ],
      },
      actions: [{ actionId: "tags.add", params: { tag: str(params, tag) } }],
    };
  },
};

// —— EXTENDED（登记但不进首发硬指标，画廊标"即将/实验"）——

const NEW_ORDER_TAG: TemplateDefinition = {
  id: "T3-new-order-tag",
  name: "First-touch order tagging",
  oneLine: "Tag every new order for downstream routing.",
  category: "Orders",
  tier: "EXTENDED",
  triggerType: "order.created",
  requiresProtectedData: getTrigger("order.created").protectedCustomerData,
  params: [
    { key: "tag", label: "Tag to add", type: "tag", required: true, default: "new" },
  ],
  stepsPreview: ["When an order is created", "Add a tag to the order"],
  definitionTemplate: (params) => ({
    ...dslSkeleton(NEW_ORDER_TAG, NEW_ORDER_TAG.name),
    actions: [
      { actionId: "tags.add", params: { tag: str(params, NEW_ORDER_TAG.params[0]) } },
    ],
  }),
};

const TEST_PRODUCT_UNPUBLISH: TemplateDefinition = {
  id: "T6-test-product",
  name: "Auto-draft test products",
  oneLine: "Move products whose title matches a keyword back to draft.",
  category: "Products",
  tier: "EXTENDED",
  triggerType: "product.updated",
  requiresProtectedData: getTrigger("product.updated").protectedCustomerData,
  params: [
    {
      key: "keyword",
      label: "Title contains",
      type: "text",
      required: true,
      default: "test",
      whitelistField: "title",
    },
  ],
  stepsPreview: [
    "When a product updates and its title contains your keyword",
    "Move the product to draft",
  ],
  definitionTemplate: (params) => ({
    ...dslSkeleton(TEST_PRODUCT_UNPUBLISH, TEST_PRODUCT_UNPUBLISH.name),
    conditions: {
      logic: "AND",
      clauses: [
        {
          field: "title",
          op: "contains",
          value: str(params, TEST_PRODUCT_UNPUBLISH.params[0]),
          type: "string",
        },
      ],
    },
    actions: [{ actionId: "product.updateStatus", params: { status: "DRAFT" } }],
  }),
};

const DAILY_DIGEST: TemplateDefinition = {
  id: "T8-daily-digest",
  name: "Daily summary email",
  oneLine: "Send a scheduled digest to your inbox every day.",
  category: "Schedule",
  tier: "EXTENDED",
  triggerType: "daily.schedule",
  requiresProtectedData: getTrigger("daily.schedule").protectedCustomerData,
  params: [
    {
      key: "template",
      label: "Email template",
      type: "text",
      required: true,
      default: "daily-digest",
    },
    { key: "recipient", label: "Send to", type: "email", required: true, default: "" },
  ],
  stepsPreview: ["On your daily schedule", "Send a summary email"],
  definitionTemplate: (params) => {
    const emailParams: Record<string, unknown> = {
      template: str(params, DAILY_DIGEST.params[0]),
    };
    const to = paramValue(params, DAILY_DIGEST.params[1]);
    if (to) emailParams.to = String(to);
    return {
      ...dslSkeleton(DAILY_DIGEST, DAILY_DIGEST.name),
      actions: [{ actionId: "email.send", params: emailParams }],
    };
  },
};

const LOW_STOCK_WEBHOOK: TemplateDefinition = {
  id: "T9-low-stock-webhook",
  name: "Low stock to your system",
  oneLine: "Call an external webhook when stock hits your reorder point.",
  category: "Inventory",
  tier: "EXTENDED",
  triggerType: "inventory.low",
  requiresProtectedData: getTrigger("inventory.low").protectedCustomerData,
  params: [
    {
      key: "threshold",
      label: "Reorder point",
      type: "number",
      required: true,
      default: 3,
      whitelistField: "available",
    },
    {
      key: "integrationId",
      label: "Webhook integration",
      type: "text",
      required: true,
      default: "integration-placeholder",
    },
  ],
  stepsPreview: [
    "When a product's available stock drops to your reorder point",
    "Call your webhook endpoint",
  ],
  definitionTemplate: (params) => ({
    ...dslSkeleton(LOW_STOCK_WEBHOOK, LOW_STOCK_WEBHOOK.name),
    conditions: {
      logic: "AND",
      clauses: [
        {
          field: "available",
          op: "less_than_or_equal",
          value: num(params, LOW_STOCK_WEBHOOK.params[0]),
          type: "number",
        },
      ],
    },
    actions: [
      {
        actionId: "webhook.send",
        params: { integrationId: str(params, LOW_STOCK_WEBHOOK.params[1]) },
      },
    ],
  }),
};

const PAID_ORDER_WEBHOOK: TemplateDefinition = {
  id: "T10-paid-order-webhook",
  name: "Push paid orders to your ERP",
  oneLine: "Call an external webhook whenever an order is paid.",
  category: "Orders",
  tier: "EXTENDED",
  triggerType: "order.paid",
  requiresProtectedData: getTrigger("order.paid").protectedCustomerData,
  params: [
    {
      key: "integrationId",
      label: "Webhook integration",
      type: "text",
      required: true,
      default: "integration-placeholder",
    },
  ],
  stepsPreview: ["When an order is paid", "Call your webhook endpoint"],
  definitionTemplate: (params) => ({
    ...dslSkeleton(PAID_ORDER_WEBHOOK, PAID_ORDER_WEBHOOK.name),
    actions: [
      {
        actionId: "webhook.send",
        params: { integrationId: str(params, PAID_ORDER_WEBHOOK.params[0]) },
      },
    ],
  }),
};

export const LAUNCH_TEMPLATES: readonly TemplateDefinition[] = [
  VIP_TAG,
  HIGH_VALUE_EMAIL,
  LOW_STOCK_TAG,
  CANCELLED_ORDER_EMAIL,
  CUSTOMER_SEGMENT_TAG,
];

export const EXTENDED_TEMPLATES: readonly TemplateDefinition[] = [
  NEW_ORDER_TAG,
  TEST_PRODUCT_UNPUBLISH,
  DAILY_DIGEST,
  LOW_STOCK_WEBHOOK,
  PAID_ORDER_WEBHOOK,
];

export const ALL_TEMPLATES: readonly TemplateDefinition[] = [
  ...LAUNCH_TEMPLATES,
  ...EXTENDED_TEMPLATES,
];

const BY_ID = new Map(ALL_TEMPLATES.map((t) => [t.id, t]));

export function getTemplate(id: string): TemplateDefinition | undefined {
  return BY_ID.get(id);
}

/** 用每个参数的 default 构造一份种子参数，供契约测与"预览空表单"复用。 */
export function defaultParams(t: TemplateDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of t.params) out[p.key] = p.default;
  return out;
}

/** 条件字段白名单（供契约测交叉核对 definitionTemplate 未越界）。 */
export function whitelistFor(triggerType: TriggerTypeId): ReadonlySet<string> {
  return fieldWhitelist(triggerType);
}

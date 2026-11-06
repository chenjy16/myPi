// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与 action-risk-policy.ts 同一约定）。
// 纯逻辑、零依赖：Trigger 元数据的唯一登记处，替代散落在引擎里的 switch-case（PRD §18）。
// 白名单只收 docs/V2-OPEN-QUESTIONS.md 中 VERIFIED 的字段——未验证字段（如 customers company，
// 依 D-9）绝不进入首发白名单，否则 Condition Evaluator 会放行运行时取不到/不可靠的判据。
import type { StandardEvent } from "./event-normalizer.ts";

export type TriggerTypeId =
  | "order.created"
  | "order.paid"
  | "order.cancelled"
  | "customer.created"
  | "product.updated"
  | "inventory.low"
  | "daily.schedule";

export type TriggerSourceId = "shopify.webhook" | "scheduler" | "shopify.webhook+reconcile";

/** 可用性以 OQ 文件为准：VERIFIED 才可进 P0 验收用例。 */
export type TriggerAvailability = "VERIFIED" | "PENDING";

export type TriggerDefinition = {
  type: TriggerTypeId;
  source: TriggerSourceId;
  /** 对应的 Shopify webhook topic；scheduler 触发为 null。 */
  topic: string | null;
  /** 订阅/读取所需 scope（声明式登记，实际扩权是 Phase 4 决策项）。 */
  requiredScopes: readonly string[];
  /** 是否属 Protected Customer Data（R1 审批墙；V-5）。 */
  protectedCustomerData: boolean;
  /** StandardEvent.data 里允许条件判定的字段白名单（P2-04 Evaluator 消费）。 */
  fieldWhitelist: readonly string[];
  availability: TriggerAvailability;
  /** inventory.low 是「webhook + 阈值重算」复合 trigger，非原生低库存事件（PRD §18）。 */
  composite?: boolean;
};

const TRIGGERS: readonly TriggerDefinition[] = [
  {
    type: "order.created",
    source: "shopify.webhook",
    topic: "orders/create",
    requiredScopes: ["read_orders"],
    protectedCustomerData: true,
    fieldWhitelist: ["total_price", "currency", "customer_tags"],
    availability: "PENDING", // 字段 VERIFIED，但订阅被 R1 审批墙阻塞（V-5/B-1）
  },
  {
    type: "order.paid",
    source: "shopify.webhook",
    topic: "orders/paid",
    requiredScopes: ["read_orders"],
    protectedCustomerData: true,
    fieldWhitelist: ["total_price", "currency", "customer_tags"],
    availability: "PENDING",
  },
  {
    type: "order.cancelled",
    source: "shopify.webhook",
    topic: "orders/cancelled",
    requiredScopes: ["read_orders"],
    protectedCustomerData: true,
    fieldWhitelist: ["cancelled_at", "customer_tags"],
    availability: "PENDING",
  },
  {
    type: "customer.created",
    source: "shopify.webhook",
    topic: "customers/create",
    requiredScopes: ["read_customers"],
    protectedCustomerData: true,
    // D-9：首发只用 note/tags 已验证字段；company/B2B 判据待 OQ-3 实测后再启
    fieldWhitelist: ["tags", "note"],
    availability: "PENDING",
  },
  {
    type: "product.updated",
    source: "shopify.webhook",
    topic: "products/update",
    requiredScopes: ["read_products"],
    protectedCustomerData: false,
    fieldWhitelist: ["status", "title"],
    availability: "VERIFIED", // V-7：非 protected，可订阅
  },
  {
    type: "inventory.low",
    source: "shopify.webhook+reconcile",
    topic: "inventory_levels/update",
    requiredScopes: ["read_inventory"],
    protectedCustomerData: false,
    fieldWhitelist: ["available", "location_id"],
    availability: "VERIFIED", // V-6：生产在用
    composite: true, // 触发判据 = 投递信号 + 阈值重算，at-least-once 漏投由对账兜底（V-4）
  },
  {
    type: "daily.schedule",
    source: "scheduler",
    topic: null,
    requiredScopes: [],
    protectedCustomerData: false,
    // 定时触发不携带事件实体字段；判据在步骤内由数据层完成，条件层无可白名单字段
    fieldWhitelist: [],
    availability: "VERIFIED",
  },
] as const;

const BY_TYPE = new Map<string, TriggerDefinition>(
  TRIGGERS.map((t) => [t.type, t]),
);

/** 按类型取 trigger；未知类型抛错——绝不静默给空元数据让引擎带病运行。 */
export function getTrigger(type: string): TriggerDefinition {
  const trigger = BY_TYPE.get(type);
  if (!trigger) throw new Error(`Unknown trigger type: ${type}`);
  return trigger;
}

/**
 * topic 反查。一个 topic 可能同时服务「直投」与「+reconcile」两种来源的 trigger，
 * 但登记上 inventory_levels/update 只对应 inventory.low，故反查唯一；重复登记直接抛错防注册表写脏。
 */
export function triggerForTopic(topic: string): TriggerDefinition | null {
  const matches = TRIGGERS.filter((t) => t.topic === topic);
  if (matches.length > 1)
    throw new Error(`Trigger registry has duplicate topic bindings: ${topic}`);
  return matches[0] ?? null;
}

/** 条件字段白名单（Set 形状供 Evaluator O(1) 判定）。 */
export function fieldWhitelist(type: string): ReadonlySet<string> {
  return new Set(getTrigger(type).fieldWhitelist);
}

/** 已登记类型清单，供校验器与模板目录交叉核对。 */
export const KNOWN_TRIGGER_TYPES: readonly TriggerTypeId[] = TRIGGERS.map(
  (t) => t.type,
);

/** trigger 元数据与归一器输出 shape 的一致性自检（引擎认领事件后第一道防线）。 */
export function triggerMatchesEvent(trigger: TriggerDefinition, event: StandardEvent): boolean {
  if (trigger.topic === null) return event.topic === ""; // scheduler 注入的事件不来自 webhook
  return event.topic === trigger.topic;
}

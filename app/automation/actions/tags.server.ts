// Tags 执行器（P2-08）：tagsAdd/tagsRemove 真实执行且幂等。
// 幂等口径与 P2-06 注册表一致：add 先读现有 tags、缺失才写；remove 不存在即 no-op 成功。
// 写全部走 P2-07 adminGraphqlWrite：带 requestSource 来源注释、userErrors 折成可读错误。
import { adminGraphqlWrite } from "../../lib/admin-graphql.server.ts";
import { toGid } from "../../lib/shopify-id.ts";
import type { StandardEvent } from "../../lib/event-normalizer.ts";
import type { CompiledActionStep } from "../../lib/automation-compiler.ts";

export type ExecutorContext = {
  /** 只需 graphql 一个方法；类型从写封装推导，测试用假代理满足。 */
  admin: Parameters<typeof adminGraphqlWrite>[0];
  requestSource?: string;
};

export type ActionExecResult = {
  success: boolean;
  data?: Record<string, unknown>;
  errorText?: string;
};

const TARGET_TYPE: Record<string, "Order" | "Customer" | "Product"> = {
  order: "Order",
  customer: "Customer",
  product: "Product",
};

function tagName(step: CompiledActionStep): string | null {
  const tag = step.params.tag;
  return typeof tag === "string" && tag.trim() !== "" ? tag.trim() : null;
}

/**
 * 解析步骤目标 GID：DSL 显式 target 优先；缺省按事件 entityType 推断。
 * 推断不出（target 越界 / 事件无实体）返回 null，由调用方判错。
 */
function resolveTarget(
  step: CompiledActionStep,
  event: StandardEvent,
): { gid: string; type: "Order" | "Customer" | "Product" } | null {
  if (!event.entityId) return null;
  const key =
    step.target ?? event.entityType.toLowerCase(); // Order→order、ProductVariant→productvariant
  const type = TARGET_TYPE[key];
  if (!type) return null;
  const gid = toGid(event.entityId, type);
  return gid ? { gid, type } : null;
}

/** 读目标现有 tags：资源类型不同字段路径不同，统一折成字符串数组。 */
async function readExistingTags(
  admin: ExecutorContext["admin"],
  gid: string,
  requestSource?: string,
): Promise<string[] | null> {
  const query = `query mypiTargetTags($id: ID!) {
    node(id: $id) {
      ... on Order { tags }
      ... on Customer { tags }
      ... on Product { tags }
    }
  }`;
  const data = await adminGraphqlWrite<{ node?: { tags?: unknown } | null }>(
    admin,
    query,
    { variables: { id: gid }, requestSource },
  );
  if (!data.node) return null;
  const raw = data.node.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

const ADD_MUTATION = `mutation MypiTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}`;

const REMOVE_MUTATION = `mutation MypiTagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) {
    node { id }
    userErrors { field message }
  }
}`;

export async function executeTagsAdd(
  step: CompiledActionStep,
  event: StandardEvent,
  ctx: ExecutorContext,
): Promise<ActionExecResult> {
  const tag = tagName(step);
  const target = resolveTarget(step, event);
  if (!tag)
    return { success: false, errorText: "Add tag: no tag name in step params." };
  if (!target)
    return {
      success: false,
      errorText: `Add tag: cannot resolve a taggable target (target=${step.target ?? event.entityType}).`,
    };
  try {
    const existing = await readExistingTags(ctx.admin, target.gid, ctx.requestSource);
    if (existing === null)
      return { success: false, errorText: `Add tag: target ${target.gid} not found.` };
    if (existing.includes(tag))
      return { success: true, data: { idempotent: true, tag, target: target.gid } };
    await adminGraphqlWrite(
      ctx.admin,
      ADD_MUTATION,
      { variables: { id: target.gid, tags: [tag] }, requestSource: ctx.requestSource },
    );
    return { success: true, data: { added: tag, target: target.gid } };
  } catch (error) {
    return { success: false, errorText: readableError(error) };
  }
}

export async function executeTagsRemove(
  step: CompiledActionStep,
  event: StandardEvent,
  ctx: ExecutorContext,
): Promise<ActionExecResult> {
  const tag = tagName(step);
  const target = resolveTarget(step, event);
  if (!tag)
    return { success: false, errorText: "Remove tag: no tag name in step params." };
  if (!target)
    return {
      success: false,
      errorText: `Remove tag: cannot resolve a taggable target (target=${step.target ?? event.entityType}).`,
    };
  try {
    const existing = await readExistingTags(ctx.admin, target.gid, ctx.requestSource);
    if (existing === null)
      return { success: false, errorText: `Remove tag: target ${target.gid} not found.` };
    // 不存在即 no-op 成功：remove 的幂等形态（P2-06 登记口径）
    if (!existing.includes(tag))
      return { success: true, data: { idempotent: true, tag, target: target.gid } };
    await adminGraphqlWrite(
      ctx.admin,
      REMOVE_MUTATION,
      { variables: { id: target.gid, tags: [tag] }, requestSource: ctx.requestSource },
    );
    return { success: true, data: { removed: tag, target: target.gid } };
  } catch (error) {
    return { success: false, errorText: readableError(error) };
  }
}

export type TagCorrection = "applied" | "not_applied" | "unreadable";

/**
 * UNKNOWN 回读校正（P2-17）：只读查询、绝不发起任何 Mutation、绝不重发。
 * 按 Shopify 现状判定 tags 步是否已生效——超时未回包不等于失败，判定不了交给人工。
 */
export async function correctTagsStep(
  admin: ExecutorContext["admin"],
  step: CompiledActionStep,
  event: StandardEvent,
  requestSource?: string,
): Promise<TagCorrection> {
  const tag = tagName(step);
  const target = resolveTarget(step, event);
  if (!tag || !target) return "unreadable";
  let existing: string[] | null;
  try {
    existing = await readExistingTags(admin, target.gid, requestSource);
  } catch {
    return "unreadable";
  }
  if (existing === null) return "unreadable";
  const has = existing.includes(tag);
  if (step.actionId === "tags.add") return has ? "applied" : "not_applied";
  if (step.actionId === "tags.remove") return has ? "not_applied" : "applied";
  return "unreadable";
}

/** 商家可读错误：AppError.message 已是安全摘要；原始堆栈永不透传（P3 口径）。 */
function readableError(error: unknown): string {
  if (error instanceof Error && "kind" in error) {
    const appError = error as Error & { kind: string; detail?: string };
    return appError.detail
      ? `${appError.message} (${appError.detail})`.slice(0, 500)
      : appError.message.slice(0, 500);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

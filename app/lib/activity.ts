// 带扩展名是故意的：本模块要能被 `node --test` 直接加载。
// Activity Logs 服务核（PRD §23 / P3-06）：执行史的过滤 / 游标分页 / 血缘 / 人话摘要。
// client 注入便于脱库单测；一切读按 shopId 收口，跨店不可读。摘要走商家语言，
// 绝不出现 Mutation / GID 等术语（P3-19 可读性红线）。
import type { ExecutionLog, PrismaClient } from "@prisma/client";
import type { EvaluationResult } from "./condition-evaluator.ts";
import type { CompiledPlan } from "./automation-compiler.ts";

export type ActivityClient = Pick<PrismaClient, "executionLog" | "executionStep">;

export type ExecutionStepRecord = {
  id: string;
  order: number;
  actionId: string;
  status: string;
  result: unknown;
  errorText: string | null;
};

export type ExecutionSummary = {
  id: string;
  automationId: string;
  automationVersion: number;
  triggerType: string;
  entityRef: string | null;
  status: string;
  cascadeDepth: number;
  createdAt: Date;
  parentExecutionId: string | null;
};

export type ListFilters = {
  status?: string;
  automationId?: string;
  entityRef?: string;
  from?: Date;
  to?: Date;
  cursor?: string | null;
  limit?: number;
};

export type ListPage = {
  items: ExecutionSummary[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function encodeCursor(row: ExecutionSummary): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64");
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, "base64").toString("utf8").split("|");
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || !id) return null;
    return { at: date, id };
  } catch {
    return null;
  }
}

/** createdAt+id 双游标（同秒也不漏不重）；过滤 + 时间窗叠加。 */
export async function listExecutions(
  client: ActivityClient,
  shopId: string,
  filters: ListFilters = {},
): Promise<ListPage> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where: Record<string, unknown> = { shopId };
  if (filters.status) where.status = filters.status;
  if (filters.automationId) where.automationId = filters.automationId;
  if (filters.entityRef) where.entityRef = filters.entityRef;

  const createdAt: Record<string, unknown> = {};
  if (filters.from) createdAt.gte = filters.from;
  if (filters.to) createdAt.lte = filters.to;
  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    if (decoded) {
      // 游标语义：早于游标时刻，或同刻但 id 更小（配合 desc 排序，同秒不漏不重）。
      where.OR = [
        { createdAt: { lt: decoded.at } },
        { createdAt: decoded.at, id: { lt: decoded.id } },
      ];
    }
  } else if (Object.keys(createdAt).length) {
    where.createdAt = createdAt;
  }

  const rows = await client.executionLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const pageRows = truncated ? rows.slice(0, limit) : rows;
  const items = pageRows.map(toSummary);
  return {
    items,
    nextCursor: truncated && items.length ? encodeCursor(items[items.length - 1]) : null,
  };
}

function toSummary(row: ExecutionLog): ExecutionSummary {
  return {
    id: row.id,
    automationId: row.automationId,
    automationVersion: row.automationVersion,
    triggerType: row.triggerType,
    entityRef: row.entityRef,
    status: row.status,
    cascadeDepth: row.cascadeDepth,
    createdAt: row.createdAt,
    parentExecutionId: row.parentExecutionId,
  };
}

export type ExecutionDetail = ExecutionSummary & {
  conditionResult: EvaluationResult | null;
  steps: ExecutionStepRecord[];
  parent: ExecutionSummary | null;
  children: ExecutionSummary[];
};

export async function getExecutionDetail(
  client: ActivityClient,
  shopId: string,
  executionId: string,
): Promise<ExecutionDetail | null> {
  const row = await client.executionLog.findFirst({
    where: { id: executionId, shopId },
  });
  if (!row) return null; // 跨店/不存在一律 null，不泄露他店存在性

  const stepRows = await client.executionStep.findMany({
    where: { executionId: row.id },
    orderBy: { order: "asc" },
  });
  const steps: ExecutionStepRecord[] = stepRows.map((s) => ({
    id: s.id,
    order: s.order,
    actionId: s.actionId,
    status: s.status,
    result: s.result,
    errorText: s.errorText,
  }));

  const parentRow = row.parentExecutionId
    ? await client.executionLog.findFirst({
        where: { id: row.parentExecutionId, shopId },
      })
    : null;
  const childRows = await client.executionLog.findMany({
    where: { shopId, parentExecutionId: row.id },
    orderBy: { createdAt: "asc" },
  });

  return {
    ...toSummary(row),
    conditionResult: (row.conditionResult as EvaluationResult) ?? null,
    steps,
    parent: parentRow ? toSummary(parentRow) : null,
    children: childRows.map(toSummary),
  };
}

/** 存在待确认步骤的执行数（Center 角标 / 待确认指标）。 */
export async function awaitingConfirmationCount(
  client: ActivityClient,
  shopId: string,
): Promise<number> {
  const rows = await client.executionStep.findMany({
    where: { status: "AWAITING_CONFIRMATION", execution: { shopId } },
    select: { executionId: true },
  });
  return new Set(rows.map((r) => r.executionId)).size;
}

export type ExecutionRow = ExecutionSummary & {
  steps: ExecutionStepRecord[];
  summary: string;
};

/**
 * 列表页专用：先分页取执行，再批量取本页步骤，逐行算商家摘要（避免 N+1）。
 * 只读、按 shopId 收口；摘要口径与详情页一致。
 */
export async function listExecutionRows(
  client: ActivityClient,
  shopId: string,
  filters: ListFilters = {},
): Promise<{ items: ExecutionRow[]; nextCursor: string | null }> {
  const page = await listExecutions(client, shopId, filters);
  const ids = page.items.map((i) => i.id);
  const byExec = new Map<string, ExecutionStepRecord[]>();
  if (ids.length > 0) {
    const stepRows = await client.executionStep.findMany({
      where: { executionId: { in: ids } },
      orderBy: { order: "asc" },
    });
    for (const s of stepRows) {
      const arr = byExec.get(s.executionId) ?? [];
      arr.push({
        id: s.id,
        order: s.order,
        actionId: s.actionId,
        status: s.status,
        result: s.result,
        errorText: s.errorText,
      });
      byExec.set(s.executionId, arr);
    }
  }
  const items = page.items.map((i) => {
    const steps = byExec.get(i.id) ?? [];
    return { ...i, steps, summary: buildHumanSummary(i, steps) };
  });
  return { items, nextCursor: page.nextCursor };
}

// —— 商家语言摘要（纯函数，供列表逐行使用）——

const TRIGGER_LABEL: Record<string, string> = {
  "order.created": "a new order",
  "order.paid": "a paid order",
  "order.cancelled": "a cancelled order",
  "customer.created": "a new customer",
  "product.updated": "a product update",
  "inventory.low": "low stock",
  "daily.schedule": "the daily schedule",
};

const ACTION_LABEL: Record<string, string> = {
  "tags.add": "added a tag",
  "tags.remove": "removed a tag",
  "email.send": "sent an email",
  "webhook.send": "called your webhook",
  "product.updateStatus": "changed product status",
};

function shortRef(entityRef: string | null): string | null {
  if (!entityRef) return null;
  const m = /\/(\d+)$/.exec(entityRef) || /_(\d+)$/.exec(entityRef);
  return m ? `#${m[1]}` : null;
}

export function buildHumanSummary(
  log: ExecutionSummary,
  steps: ExecutionStepRecord[],
): string {
  const subject = TRIGGER_LABEL[log.triggerType] ?? log.triggerType;
  const ref = shortRef(log.entityRef);
  const head = ref ? `${subject} ${ref}` : subject;

  const total = steps.length;
  const succeeded = steps.filter((s) => s.status === "SUCCESS").length;
  const failed = steps.filter((s) => s.status === "FAILED").length;
  const awaiting = steps.filter((s) => s.status === "AWAITING_CONFIRMATION").length;

  if (log.status === "SKIPPED") return `Skipped — ${head} didn't meet the conditions`;
  if (awaiting > 0) {
    const done = `${succeeded}/${total}`;
    return `${head} → waiting for you to confirm a step (done ${done})`;
  }
  const verbPhrase = steps[0] ? ACTION_LABEL[steps[0].actionId] ?? steps[0].actionId : "ran";
  const more = total > 1 ? ` +${total - 1} more` : "";
  const counts = `success ${succeeded}/${total}`;
  if (log.status === "PARTIAL_SUCCESS" || failed > 0) {
    return `${head} → ${verbPhrase}${more}, ${counts}, ${failed} failed`;
  }
  return `${head} → ${verbPhrase}${more}, ${counts}`;
}

/** 从冻结计划取步骤动作名，供"未运行"预览（无执行记录时）。 */
export function plannedStepLabels(plan: CompiledPlan | null | undefined): string[] {
  if (!plan) return [];
  return plan.actions.map((a) => ACTION_LABEL[a.actionId] ?? a.actionId);
}

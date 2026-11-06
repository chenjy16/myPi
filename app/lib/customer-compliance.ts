// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// 客户级合规处理服务核（P4-09，GDPR/CCPA）：customers/data_request 导出、customers/redact 清除。
// 事实口径：本应用从不落库原始客户 PII（事件快照走白名单裁剪，见 event-normalizer/safeSnapshot）；
// 但执行史里会引用客户——customer.created 触发的 entityRef 是客户 GID、tags.add 步的 result
// 节点 id 可能是客户 GID、payload 白名单字段（如 customer_tags）源自客户。redact 处理的是这些引用。
// client 注入、判定/掩蔽全纯函数，可脱库单测，也可喂真库做集成渗透。
import type { Prisma, PrismaClient } from "@prisma/client";

export type ComplianceClient = Pick<
  PrismaClient,
  "executionLog" | "executionStep"
>;

const CUSTOMER_GID_MARK = "shopify/Customer/";
export const REDACTED = "[redacted-customer]";

/**
 * 判断一个已落库的值是否引用给定客户：
 *  - 字符串含完整客户 GID（`...shopify/Customer/<id>`，以后无数字续写为界，12 不匹配 123）；
 *  - 数字/字符串值恰等于客户数值 id，且所在键名是 id/customerId（精确匹配，不做子串）。
 */
export function referencesCustomerId(
  value: unknown,
  customerId: string | number,
  keyName?: string,
): boolean {
  const id = String(customerId).trim();
  if (!id) return false;
  if (typeof value === "string") {
    if (hasExactCustomerGid(value, id)) return true;
    // 数值 id 仅作为独立整串出现也算引用（如旧行里的裸 id）
    return value === id;
  }
  if (typeof value === "number" && keyName !== undefined) {
    return (
      (keyName === "id" || keyName === "customerId") && String(value) === id
    );
  }
  return false;
}

/** GID 精确边界匹配：`Customer/<id>` 后必须是串尾或非数字。 */
function hasExactCustomerGid(text: string, id: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(CUSTOMER_GID_MARK, from);
    if (at === -1) return false;
    const after = text.slice(at + CUSTOMER_GID_MARK.length);
    const match = /^\d+/.exec(after);
    if (match && match[0] === id) {
      const rest = after.slice(id.length);
      if (!/^\d/.test(rest)) return true;
    }
    from = at + CUSTOMER_GID_MARK.length;
  }
}

/** 深度遍历判定：结构里任何位置引用该客户即 true。 */
export function structureReferencesCustomer(
  node: unknown,
  customerId: string | number,
): boolean {
  const walk = (value: unknown, key?: string): boolean => {
    if (referencesCustomerId(value, customerId, key)) return true;
    if (Array.isArray(value)) return value.some((v) => walk(v));
    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).some(([k, v]) =>
        walk(v, k),
      );
    }
    return false;
  };
  return walk(node);
}

/** 深度掩蔽：把所有对该客户的引用折成占位串，其余原样保留（返回新结构，不改入参）。 */
export function maskCustomerReferences(
  node: unknown,
  customerId: string | number,
): unknown {
  const id = String(customerId).trim();
  const maskText = (text: string): string => {
    if (!id) return text;
    const gidRe = new RegExp(
      `(shopify/Customer/)${id}(?![0-9])`,
      "g",
    );
    return text.replace(gidRe, `$1${REDACTED}`).replace(new RegExp(`^${id}$`), REDACTED);
  };
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const touched =
        referencesCustomerId(value, customerId) || value.includes(`Customer/${id}`);
      return touched ? maskText(value) : value;
    }
    if (typeof value === "number" && key !== undefined) {
      if (
        (key === "id" || key === "customerId") &&
        String(value) === id
      ) {
        return REDACTED;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v, k),
        ]),
      );
    }
    return value;
  };
  return walk(node);
}

/**
 * 抽出一段结构里引用到的全部客户数值 id（GID 形式）。
 * retention prune 用它完成「不知道具体客户、但要先把裸引用掩蔽掉」的场景。
 */
export function extractCustomerIds(node: unknown): string[] {
  const found = new Set<string>();
  const GID_RE = /shopify\/Customer\/(\d+)/g;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(GID_RE)) found.add(m[1]);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const v of Array.isArray(value) ? value : Object.values(value)) walk(v);
  };
  walk(node);
  return [...found];
}

// —— 读：某客户的执行关联（data_request 导出面） ——

export type CustomerExecutionRecord = {
  id: string;
  automationId: string;
  triggerType: string;
  status: string;
  createdAt: Date;
  /** 掩蔽后的引用信息：只保留与本客户相关的动作事实。 */
  steps: { actionId: string; status: string; result: unknown }[];
};

export async function findCustomerExecutionRecords(
  client: ComplianceClient,
  shopId: string,
  customerId: string | number,
): Promise<CustomerExecutionRecord[]> {
  // 候选集按店收口（绝不跨店），再逐行做纯引用判定。
  const logs = await client.executionLog.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
  });
  const out: CustomerExecutionRecord[] = [];
  for (const log of logs) {
    const stepRows = await client.executionStep.findMany({
      where: { executionId: log.id },
      orderBy: { order: "asc" },
    });
    const hit =
      structureReferencesCustomer(log.entityRef, customerId) ||
      structureReferencesCustomer(log.payload, customerId) ||
      stepRows.some(
        (s) =>
          structureReferencesCustomer(s.result, customerId) ||
          structureReferencesCustomer(s.errorText, customerId),
      );
    if (!hit) continue;
    out.push({
      id: log.id,
      automationId: log.automationId,
      triggerType: log.triggerType,
      status: log.status,
      createdAt: log.createdAt,
      steps: stepRows.map((s) => ({
        actionId: s.actionId,
        status: s.status,
        result: maskCustomerReferences(s.result, customerId),
      })),
    });
  }
  return out;
}

// —— 写：清除客户引用（customers/redact 执行面） ——

export type RedactOutcome = {
  executionsScanned: number;
  logsMasked: number;
  stepsMasked: number;
};

export async function redactCustomerReferences(
  client: ComplianceClient,
  shopId: string,
  customerIds: (string | number)[],
): Promise<RedactOutcome> {
  const ids = customerIds.map((id) => String(id).trim()).filter(Boolean);
  const logs = await client.executionLog.findMany({ where: { shopId } });
  let logsMasked = 0;
  let stepsMasked = 0;
  for (const log of logs) {
    let logTouched = false;
    for (const id of ids) {
      if (structureReferencesCustomer(log.payload, id) && log.payload != null) {
        log.payload = maskCustomerReferences(log.payload, id) as Prisma.JsonValue;
        logTouched = true;
      }
      if (structureReferencesCustomer(log.entityRef, id)) {
        log.entityRef = REDACTED;
        logTouched = true;
      }
    }
    if (logTouched) {
      await client.executionLog.update({
        where: { id: log.id },
        data: { payload: log.payload as never, entityRef: log.entityRef },
      });
      logsMasked += 1;
    }

    const stepRows = await client.executionStep.findMany({
      where: { executionId: log.id },
    });
    for (const s of stepRows) {
      let stepTouched = false;
      let result: Prisma.JsonValue | null = s.result as Prisma.JsonValue | null;
      let errorText = s.errorText;
      for (const id of ids) {
        if (structureReferencesCustomer(result, id)) {
          result = maskCustomerReferences(result, id) as Prisma.JsonValue;
          stepTouched = true;
        }
        if (structureReferencesCustomer(errorText, id)) {
          errorText = REDACTED;
          stepTouched = true;
        }
      }
      if (stepTouched) {
        await client.executionStep.update({
          where: { id: s.id },
          data: { result: result as never, errorText },
        });
        stepsMasked += 1;
      }
    }
  }
  return { executionsScanned: logs.length, logsMasked, stepsMasked };
}

// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// 数据保留策略纯核（P4-10）：保留窗口计算 + 「哪些旧执行该删」判定。
// 不自取时钟：now 一律由调用方注入， cutoff 是显式参数 —— prune 侧先算一次、审计日志原样落。
// 客户引用判定与掩蔽复用 customer-compliance 的纯函数：含客户引用的旧行也是「先掩蔽再删」，
// 保证哪怕删除中途失败，留在库里的行也已不再指向客户。

export const DEFAULT_EXECUTION_RETENTION_DAYS = 180;

/** env 解析：非法/非正数一律回退默认值，绝不让一个坏配置把保留窗口调成 0（那等于全删）。 */
export function parseRetentionDays(
  raw: string | undefined,
  fallback: number = DEFAULT_EXECUTION_RETENTION_DAYS,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 保留窗口起点：早于（<）该时间戳的执行进入可删集合。 */
export function cutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export type RetentionCandidate = {
  id: string;
  createdAt: Date;
  entityRef?: string | null;
  payload?: unknown;
};

/**
 * 应删集合：createdAt 早于 cutoff 的行（比较用时间戳，等价于 DB 的 createdAt < cutoff）。
 * 「含客户引用」在这里只是分类计数——它不改变去留（两类都删），改变的是处理顺序：
 * 带引用的行先过一遍掩蔽再删，不给「裸 PII 行」留任何存活窗口。
 */
export function selectPrunableExecutions<T extends RetentionCandidate>(
  rows: readonly T[],
  cutoff: Date,
): { toDelete: T[]; withCustomerRef: T[] } {
  const toDelete: T[] = [];
  const withCustomerRef: T[] = [];
  for (const row of rows) {
    if (row.createdAt.getTime() >= cutoff.getTime()) continue;
    toDelete.push(row);
    // 客户 id 无从枚举，这里判定的是「该行是否引用了任何客户 GID」，供掩蔽与审计。
    if (referencesAnyCustomer(row.entityRef) || referencesAnyCustomer(row.payload)) {
      withCustomerRef.push(row);
    }
  }
  return { toDelete, withCustomerRef };
}

/** 任意客户 GID 引用（不限定具体客户编号）——掩蔽决策用，不做逐客户匹配。 */
function referencesAnyCustomer(value: unknown): boolean {
  if (typeof value === "string") return value.includes("shopify/Customer/");
  if (!value || typeof value !== "object") return false;
  // 借用逐客户判定的遍历形状代价太高（无 id 可传），这里自己做一次轻量深度扫描。
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (node.includes("shopify/Customer/")) return true;
      continue;
    }
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    stack.push(...(Array.isArray(node) ? node : Object.values(node)));
  }
  return false;
}

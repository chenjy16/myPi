// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：写 scope 缺口判定（P4-06）。session.scope 由 Shopify 在鉴权时带回，
// 但本模块不碰鉴权/时钟——只吃「已授权 scope 字符串 + 一组动作 id」，输出缺失集，
// 供 automations 列表/详情/向导页在检测到写权限不足时挂重授权 banner。
// 保守口径：动作的 requiredScopes 取并集（tags.add 对 Order/Customer/Product 列出多 scope，
// 缺任一都可能意味着目标实体的写权限没给全），宁可多提示一次重授权，也不让自动化静默失败。
import { getAction } from "./action-registry.ts";

/** 把 session.scope（逗号/空格分隔）归一为小写集合；空/ null → 空集。 */
export function normalizeScope(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** 一组动作 id 需要的 scope 并集（去重、排序）；未知 actionId 交由 getAction 抛错。 */
export function requiredScopesForActions(
  actionIds: Iterable<string>,
): string[] {
  const set = new Set<string>();
  for (const id of actionIds) {
    for (const scope of getAction(id).requiredScopes) set.add(scope);
  }
  return [...set].sort();
}

/** 已授权集合未覆盖的所需 scope（保持 required 的排序）。 */
export function missingScopes(
  granted: ReadonlySet<string>,
  required: readonly string[],
): string[] {
  return required.filter((scope) => !granted.has(scope));
}

export type ScopeGap = {
  /** true = 该组动作所需写 scope 已全部覆盖（或本就没有写动作）。 */
  ok: boolean;
  required: string[];
  missing: string[];
};

/** 一步判定：给定已授权 scope 串 + 动作 id 集合 → 是否够、缺哪些。 */
export function evaluateScopeGap(
  grantedScope: string | null | undefined,
  actionIds: Iterable<string>,
): ScopeGap {
  const required = requiredScopesForActions(actionIds);
  const missing = missingScopes(normalizeScope(grantedScope), required);
  return { ok: missing.length === 0, required, missing };
}

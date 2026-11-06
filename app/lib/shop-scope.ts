// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// 多租户硬边界守卫（P4-03）：一切「按 id 取回再操作」的读写，返回/继续之前必须过这里。
// 口径：跨店与不存在一律同样不可见——绝不泄露目标行在别店存在过（E2E 场景 F 的静态面）。
// 纯逻辑、零依赖；查询 where 已带 shopId 的调用点用它做第二道显式断言（防御纵深）。

/** 资源对本店不可见（不存在或属于别店）。调用方折成 not-found，绝不透传细节。 */
export class ShopScopeError extends Error {
  constructor() {
    super("Resource is not visible for this store");
    this.name = "ShopScopeError";
  }
}

/** shopId 本身缺失即配置/会话异常——先于任何查询炸掉，绝不降级成"查全部"。 */
export function requireShopId(shopId: string | null | undefined): string {
  if (!shopId) throw new ShopScopeError();
  return shopId;
}

/**
 * 断言 row 归属 shopId 并原样返回（可链式用）。
 * row 为 null/undefined、缺 shopId 列、或 shopId 不等 → 一律抛 ShopScopeError。
 */
export function assertShopScope<T extends { shopId?: string }>(
  shopId: string,
  row: T | null | undefined,
): T {
  requireShopId(shopId);
  if (!row || row.shopId !== shopId) throw new ShopScopeError();
  return row;
}

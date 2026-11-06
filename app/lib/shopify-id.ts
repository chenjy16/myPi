// 带扩展名是故意的：本文件要能被 `node --test` 直接加载。
// 纯逻辑、零依赖。从 webhook-sync.server.ts 抽出，成为「payload id → GID」的唯一实现，
// 避免 V1 同步链路与 V2 归一链路各存一份（docs/V2-PHASE1-TASKS.md P1-08）。

/**
 * 把 payload 里的 id 归一成 Shopify GID：兼容 REST 数字 id 与 GraphQL 原生字符串 id 两种形状。
 * 解析不出（非数字、空串、非法字符串）返回 null，由调用方决定跳过而不是抛错。
 */
export function toGid(value: unknown, type: string): string | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return `gid://shopify/${type}/${value}`;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("gid://")) return value;
  return /^\d+$/.test(value) ? `gid://shopify/${type}/${value}` : null;
}

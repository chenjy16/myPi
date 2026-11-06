// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 sync-job-ledger.ts 同一约定）。
// Shop 租户目录编排：把「域名字符串」升级为唯一的 Shop 租户行。
// 绝不假设 Session.shop 唯一（V1 里同店可有多条 session），租户以本表的 Shop.shop @unique 为准。
import type { PrismaClient } from "@prisma/client";
import { isUniqueViolation } from "./sync-job-policy.ts";

export type ShopClient = Pick<
  PrismaClient,
  "shop" | "session" | "inventorySettings"
>;

export type ShopDefaults = {
  timezone?: string;
  currencyCode?: string;
  primaryCountry?: string | null;
};

/**
 * 幂等地确保某域名有对应 Shop 行。并发撞 Shop.shop 唯一约束时回读已存在行返回，
 * 因此多处同时 ensureShop 只产生一条租户记录。新建时优先用显式 defaults，
 * 其次取库里 InventorySettings 的时区/币种（迁移 §1.5），最后落 UTC/USD。
 */
export async function ensureShop(
  client: ShopClient,
  shopDomain: string,
  defaults: ShopDefaults = {},
) {
  const existing = await client.shop.findUnique({
    where: { shop: shopDomain },
  });
  if (existing) return existing;

  const settings = await client.inventorySettings.findUnique({
    where: { shop: shopDomain },
    select: { timezone: true, currencyCode: true },
  });

  try {
    return await client.shop.create({
      data: {
        shop: shopDomain,
        timezone: defaults.timezone ?? settings?.timezone ?? "UTC",
        currencyCode: defaults.currencyCode ?? settings?.currencyCode ?? "USD",
        primaryCountry: defaults.primaryCountry ?? null,
      },
    });
  } catch (error) {
    // 并发创建：另一个进程先建成了，回读它返回，绝不把竞态当失败抛给上层。
    if (isUniqueViolation(error)) {
      const row = await client.shop.findUnique({
        where: { shop: shopDomain },
      });
      if (row) return row;
    }
    throw error;
  }
}

/**
 * 从已鉴权的会话域名解析（并确保）Shop。调用方保证 session 存在（authenticate 之后），
 * 因此这里不再校验 session，只负责把域名映射成租户行。
 */
export async function resolveShopFromSession(
  client: ShopClient,
  shopDomain: string,
  defaults: ShopDefaults = {},
) {
  return ensureShop(client, shopDomain, defaults);
}

export type BackfillResult = {
  total: number;
  created: number;
  skipped: number;
};

/**
 * 一次性回填：为所有已有 offline session 的店铺建 Shop 行（迁移 §3.2 / P1-05）。
 * 幂等——只读 session、绝不改 accessToken/expires，商家零重授权；可重复执行。
 */
export async function backfillShops(
  client: ShopClient,
): Promise<BackfillResult> {
  const rows = await client.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  const domains = [...new Set(rows.map((row) => row.shop))];

  let created = 0;
  let skipped = 0;
  for (const domain of domains) {
    const before = await client.shop.findUnique({
      where: { shop: domain },
      select: { id: true },
    });
    await ensureShop(client, domain);
    if (before) skipped += 1;
    else created += 1;
  }
  return { total: domains.length, created, skipped };
}

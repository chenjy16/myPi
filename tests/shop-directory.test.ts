import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backfillShops,
  ensureShop,
  type ShopClient,
} from "../app/lib/shop-directory.ts";

/**
 * Shop 租户目录单测（P1-04）：幂等 ensure、三级默认值优先级（defaults > InventorySettings >
 * UTC/USD）、并发撞唯一约束回读竞态行、backfill 只读 session 不改 token 且可重复执行。
 */

type ShopRow = { id: string; shop: string; timezone: string; currencyCode: string };

function fakeClient(options: {
  shops?: ShopRow[];
  settings?: { timezone: string; currencyCode: string } | null;
  sessions?: { shop: string }[];
  createRaceRow?: ShopRow;
} = {}) {
  const shops = new Map((options.shops ?? []).map((s) => [s.shop, s]));
  const created: Record<string, unknown>[] = [];
  let touchedSession = false;
  const client = {
    shop: {
      findUnique: async ({ where }: { where: { shop: string } }) =>
        shops.get(where.shop) ?? null,
      create: async ({ data }: { data: Record<string, unknown> & { shop: string } }) => {
        created.push(data);
        if (options.createRaceRow) {
          // 模拟并发竞态：对手进程先建成了，我们迟到一步抛 P2002，回读能看到它的行
          shops.set(data.shop, options.createRaceRow);
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        const row = { id: `shop-${shops.size + 1}`, ...data } as ShopRow;
        shops.set(row.shop, row);
        return row;
      },
    },
    inventorySettings: {
      findUnique: async () => options.settings ?? null,
    },
    session: {
      findMany: async () => {
        touchedSession = true;
        return options.sessions ?? [];
      },
    },
  } as unknown as ShopClient & { session: { findMany: () => unknown } };
  return { client, created, shops, getTouchedSession: () => touchedSession };
}

test("已存在的 Shop 直接返回，不再创建", async () => {
  const existing: ShopRow = {
    id: "shop-1",
    shop: "demo.myshopify.com",
    timezone: "Asia/Shanghai",
    currencyCode: "CNY",
  };
  const { client, created } = fakeClient({ shops: [existing] });
  const row = await ensureShop(client, "demo.myshopify.com");
  assert.deepEqual(row, existing);
  assert.equal(created.length, 0);
});

test("默认值优先级：显式 defaults > InventorySettings > UTC/USD", async () => {
  const a = fakeClient({ settings: { timezone: "Europe/Berlin", currencyCode: "EUR" } });
  await ensureShop(a.client, "a.myshopify.com");
  assert.equal(a.created[0].timezone, "Europe/Berlin");
  assert.equal(a.created[0].currencyCode, "EUR");

  const b = fakeClient({ settings: { timezone: "Europe/Berlin", currencyCode: "EUR" } });
  await ensureShop(b.client, "b.myshopify.com", { timezone: "Asia/Tokyo" });
  assert.equal(b.created[0].timezone, "Asia/Tokyo"); // defaults 覆盖 settings
  assert.equal(b.created[0].currencyCode, "EUR"); // 未指定的仍走 settings

  const c = fakeClient({ settings: null });
  await ensureShop(c.client, "c.myshopify.com");
  assert.equal(c.created[0].timezone, "UTC");
  assert.equal(c.created[0].currencyCode, "USD");
  assert.equal(c.created[0].primaryCountry, null);
});

test("并发创建撞 P2002：回读竞态行返回，绝不上抛", async () => {
  const raceRow: ShopRow = {
    id: "shop-winner",
    shop: "x.myshopify.com",
    timezone: "UTC",
    currencyCode: "USD",
  };
  const { client } = fakeClient({ createRaceRow: raceRow });
  const row = await ensureShop(client, "x.myshopify.com");
  assert.deepEqual(row, raceRow);
});

test("非竞态的唯一约束异常（回读仍为空）照抛，不掩盖真问题", async () => {
  // create 抛 P2002 但库里回读永远为空：这不是并发竞态，必须上抛给调用方
  const client = {
    shop: {
      findUnique: async () => null,
      create: async () => {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        });
      },
    },
    inventorySettings: { findUnique: async () => null },
    session: { findMany: async () => [] },
  } as unknown as ShopClient;
  await assert.rejects(() => ensureShop(client, "y.myshopify.com"));
});

test("backfill：按去重域名建齐租户，幂等重跑计数正确", async () => {
  const { client, shops } = fakeClient({
    sessions: [
      { shop: "a.myshopify.com" },
      { shop: "a.myshopify.com" },
      { shop: "b.myshopify.com" },
    ],
  });

  const first = await backfillShops(client);
  assert.deepEqual(first, { total: 2, created: 2, skipped: 0 });
  assert.equal(shops.size, 2);

  const second = await backfillShops(client);
  assert.deepEqual(second, { total: 2, created: 0, skipped: 2 });
});

test("backfill 只读 session，绝不写回 token/scopes（商家零重授权红线）", async () => {
  const { client, getTouchedSession } = fakeClient({
    sessions: [{ shop: "a.myshopify.com" }],
  });
  await backfillShops(client);
  assert.ok(getTouchedSession()); // 确实读过 session
  // ShopClient 类型面只有 findMany，编译期就杜绝了 session.update 的存在
});

// P4-23 · 轻载基准：ingest 归一化 + matcher 命中（纯核 + 内存假 db）。
// 目的不是压生产库，而是锁住「纯函数的 CPU 侧成本」——这两段是每一条 webhook
// 都会经过的公共路径，只要 P95 稳定，DB 侧的开销就有清晰的可控边界。
// 用法：node --experimental-transform-types scripts/perf-light.ts [N] [M]
//   N = 店铺数，默认 100
//   M = 每店事件数，默认 1000
import { performance } from "node:perf_hooks";
import { normalizeEvent } from "../app/lib/event-normalizer.ts";
import { matchAutomations } from "../app/automation-matcher.server.ts";
import type { CompiledPlan } from "../app/lib/automation-compiler.ts";

const N = Number(process.argv[2] ?? 100);
const M = Number(process.argv[3] ?? 1000);

// —— 内存假 db：每店一条 active 自动化 + 一个编译版本 ——
type AutomationRow = { id: string; currentVersionId: string | null };
type VersionRow = { id: string; automationId: string; version: number; definition: unknown };
const automations: AutomationRow[] = [];
const versions: VersionRow[] = [];
const plan: CompiledPlan = {
  compiledVersion: "2.0",
  dslVersion: "2.0",
  name: "bench",
  triggerType: "inventory.low",
  triggerMatcherKey: "inventory_levels/update",
  conditions: { logic: "AND", clauses: [] },
  actions: [{ actionId: "tags.add", params: { tag: "low-stock" }, target: "Product" }],
} as unknown as CompiledPlan;
for (let s = 0; s < N; s++) {
  const id = `auto-${s}`;
  const vid = `ver-${s}`;
  automations.push({ id, currentVersionId: vid });
  versions.push({ id: vid, automationId: id, version: 1, definition: plan });
}
const fakeClient = {
  automation: {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      automations.filter((a) => a.id === `auto-${(where.shopId as string).slice(5)}`),
  },
  automationVersion: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const ids = ((where.id as { in: string[] })?.in) ?? [];
      return versions.filter((v) => ids.includes(v.id));
    },
  },
};

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// —— 归一化基准 ——
const normSamples: number[] = [];
for (let s = 0; s < N; s++) {
  for (let i = 0; i < M; i++) {
    const start = performance.now();
    normalizeEvent({
      shopDomain: `shop${s}.myshopify.com`,
      topic: "orders/create",
      payload: {
        id: 10000 + i,
        admin_graphql_api_id: `gid://shopify/Order/${10000 + i}`,
        total_price: "42.50",
        currency: "USD",
        customer: { tags: "vip,newsletter" },
      },
    });
    normSamples.push(performance.now() - start);
  }
}
normSamples.sort((a, b) => a - b);

// —— 匹配器基准 ——
const matchSamples: number[] = [];
for (let s = 0; s < N; s++) {
  for (let i = 0; i < M; i++) {
    const start = performance.now();
    await matchAutomations(fakeClient, `shop-${s}`, "inventory_levels/update");
    matchSamples.push(performance.now() - start);
  }
}
matchSamples.sort((a, b) => a - b);

const summarize = (name: string, xs: number[]) =>
  console.log(
    `${name.padEnd(20)} n=${xs.length}  p50=${pct(xs, 50).toFixed(4)}ms  p95=${pct(
      xs,
      95,
    ).toFixed(4)}ms  p99=${pct(xs, 99).toFixed(4)}ms  max=${xs[xs.length - 1]?.toFixed(
      4,
    )}ms`,
  );

console.log(`\n== P4-23 light benchmark  N=${N} shops  M=${M} events/shop ==`);
summarize("normalizeEvent", normSamples);
summarize("matchAutomations", matchSamples);
console.log(
  "\n（假 db，纯核 + 内存查询；真实环境下的 DB IO 不在本基准内，见 server-operations-guide §7.2）\n",
);

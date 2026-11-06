// P4-18 · 一次性行数对账脚本：把 release-runbook §6.3 的两段 SQL 打到 DATABASE_URL
// 指向的库（生产 / staging / scratch 都行），把行数与一致性结果原样打印到 stdout。
// 只读，绝不写库；无副作用。用法：
//   DATABASE_URL=... node --experimental-transform-types scripts/backup-reconcile.ts
// 演练时把输出粘到 docs/release-runbook.md §6.3.1 的表格中。
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

type Row = { t: string; count: bigint };
const counts: Row[] = await p.$queryRawUnsafe(`
SELECT 'Session' t, count(*)::bigint FROM "Session"
UNION ALL SELECT 'InventorySnapshot', count(*)::bigint FROM "InventorySnapshot"
UNION ALL SELECT 'SalesDaily', count(*)::bigint FROM "SalesDaily"
UNION ALL SELECT 'DataSyncJob', count(*)::bigint FROM "DataSyncJob"
UNION ALL SELECT 'ReorderRecommendation', count(*)::bigint FROM "ReorderRecommendation"
UNION ALL SELECT 'RecommendationAudit', count(*)::bigint FROM "RecommendationAudit"
UNION ALL SELECT 'AnalyticsEvent', count(*)::bigint FROM "AnalyticsEvent"
UNION ALL SELECT 'Shop', count(*)::bigint FROM "Shop"
UNION ALL SELECT 'Automation', count(*)::bigint FROM "Automation"
UNION ALL SELECT 'AutomationVersion', count(*)::bigint FROM "AutomationVersion"
UNION ALL SELECT 'ExecutionLog', count(*)::bigint FROM "ExecutionLog"
UNION ALL SELECT 'ExecutionStep', count(*)::bigint FROM "ExecutionStep"
UNION ALL SELECT 'WebhookDelivery', count(*)::bigint FROM "WebhookDelivery"
UNION ALL SELECT 'Integration', count(*)::bigint FROM "Integration"
UNION ALL SELECT 'ScheduledJob', count(*)::bigint FROM "ScheduledJob";
`);

type ConsistencyRow = { count: bigint };
const [orphanAutomation, orphanStep, nullShop, missingSecret] =
  await Promise.all([
    p.$queryRawUnsafe<ConsistencyRow[]>(
      `SELECT count(*)::bigint FROM "Automation" a
       LEFT JOIN "AutomationVersion" v ON v.id = a."currentVersionId"
       WHERE a.status <> 'deleted' AND v.id IS NULL`,
    ),
    p.$queryRawUnsafe<ConsistencyRow[]>(
      `SELECT count(*)::bigint FROM "ExecutionStep" s
       LEFT JOIN "ExecutionLog" l ON l.id = s."executionId"
       WHERE l.id IS NULL`,
    ),
    p.$queryRawUnsafe<{ null_shop: boolean; count: bigint }[]>(
      `SELECT ("shopId" IS NULL) null_shop, count(*)::bigint
       FROM "WebhookDelivery" GROUP BY 1`,
    ),
    p.$queryRawUnsafe<ConsistencyRow[]>(
      `SELECT count(*)::bigint FROM "Integration"
       WHERE kind IN ('EMAIL', 'CUSTOM_WEBHOOK')
         AND "secretsEncrypted" IS NULL`,
    ),
  ]);

console.log("== row counts ==");
for (const r of counts) console.log(`${r.t.padEnd(24)} ${r.count.toString()}`);
console.log("== consistency (expected 0) ==");
console.log(`orphan_automation_current  ${orphanAutomation[0]?.count.toString()}`);
console.log(`orphan_execution_step      ${orphanStep[0]?.count.toString()}`);
console.log(`integration_missing_secret ${missingSecret[0]?.count.toString()}`);
console.log("webhook_delivery null_shop distribution (informational):");
for (const r of nullShop)
  console.log(`  shopId ${r.null_shop ? "NULL" : "set"} : ${r.count.toString()}`);

await p.$disconnect();

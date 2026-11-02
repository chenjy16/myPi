/**
 * mypi 后台 worker：与 Web 进程分离的独立 Node 进程，承担阶段 1 的调度地基。
 *
 * 职责：
 *   1. 周期性为所有已授权店铺抓「当日多地点库存快照」，并追写可售变化事件；
 *   2. 每天按权限窗口重建日销量（read_all_orders 决定 90 天还是 60 天）。
 *
 * 依赖 offline session（shopify.server.ts 里 useOnlineTokens=false），所以商家必须已完成
 * 一次安装授权；每次执行都登记进 DataSyncJob 台账，同店同类型任务不会并发重跑。
 */
import "dotenv/config";

/** 快照节奏：每小时第 15 分钟。同日重复抓是 upsert，天然幂等且能让当日数据保持新鲜。 */
const SNAPSHOT_CRON = process.env.WORKER_SNAPSHOT_CRON ?? "15 * * * *";
/** 销量重建节奏：默认每天 03:00（UTC）。 */
const SALES_CRON = process.env.WORKER_SALES_CRON ?? "0 3 * * *";

function log(message: string, detail?: unknown): void {
  console.log(`[worker ${new Date().toISOString()}] ${message}`, detail ?? "");
}

function logError(message: string, error: unknown): void {
  console.error(
    `[worker ${new Date().toISOString()}] ${message}`,
    error instanceof Error ? error.message : String(error),
  );
}

/** 已授权店铺 = 存储里存在 offline session 的 shop。 */
async function installedShops(prisma: typeof import("../app/db.server").default) {
  const rows = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return rows.map(({ shop }) => shop);
}

async function main(): Promise<void> {
  // shopify.server.ts 在 import 阶段就会读这几个变量，缺任何一个都会在库初始化时炸掉，
  // 所以先在这里给出可读的提示再加载应用模块。
  const required = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_APP_URL",
    "SCOPES",
  ] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(
      `[worker] Missing environment variables: ${missing.join(", ")}. Run \`shopify app env pull\` to fill .env, then start the worker again.`,
    );
    process.exit(1);
  }

  const [
    { schedule, validate },
    prismaModule, shopifyModule, inventoryModule, jobsModule] =
    await Promise.all([
      import("node-cron"),
      import("../app/db.server"),
      import("../app/shopify.server"),
      import("../app/inventory.server"),
      import("../app/sync-jobs.server"),
    ]);
  const prisma = prismaModule.default;
  const { unauthenticated } = shopifyModule;

  const sweepSnapshots = async (): Promise<void> => {
    const shops = await installedShops(prisma);
    log(`snapshot sweep over ${shops.length} shop(s)`);
    for (const shop of shops) {
      try {
        if (await jobsModule.hasRunningJob(shop, "inventory-snapshot")) {
          log(`skip ${shop}: snapshot job already running`);
          continue;
        }
        const { admin } = await unauthenticated.admin(shop);
        const result = await inventoryModule.captureDailySnapshots(
          admin,
          shop,
          "cron",
        );
        log(`snapshot done for ${shop}`, result);
      } catch (error) {
        logError(`snapshot failed for ${shop}`, error);
      }
    }
  };

  const sweepSales = async (): Promise<void> => {
    const shops = await installedShops(prisma);
    log(`sales sweep over ${shops.length} shop(s)`);
    for (const shop of shops) {
      try {
        if (await jobsModule.hasRunningJob(shop, "sales-daily")) {
          log(`skip ${shop}: sales job already running`);
          continue;
        }
        const { admin, session } = await unauthenticated.admin(shop);
        const canReadAllOrders =
          session.scope
            ?.split(",")
            .map((scope) => scope.trim())
            .includes("read_all_orders") ?? false;
        const result = await inventoryModule.refreshSalesWindow(
          admin,
          shop,
          canReadAllOrders,
          "cron",
        );
        log(`sales refresh done for ${shop}`, result);
      } catch (error) {
        logError(`sales refresh failed for ${shop}`, error);
      }
    }
  };

  for (const [label, pattern] of [
    ["snapshot", SNAPSHOT_CRON],
    ["sales", SALES_CRON],
  ] as const) {
    if (!validate(pattern)) {
      console.error(`[worker] Invalid cron expression for ${label}: ${pattern}`);
      process.exit(1);
    }
  }

  log(
    `worker started (snapshot: ${SNAPSHOT_CRON}, sales: ${SALES_CRON}, pid: ${process.pid})`,
  );

  // noOverlap 防止同一进程内上一次扫描还没跑完就被下一个调度点重入。
  schedule(SNAPSHOT_CRON, () => void sweepSnapshots(), {
    name: "inventory-snapshot",
    noOverlap: true,
  });
  schedule(SALES_CRON, () => void sweepSales(), {
    name: "sales-daily",
    noOverlap: true,
  });

  // 启动即补跑一次：worker 停机期间错过的整点不必等到下一个调度点。
  await sweepSnapshots();
  await sweepSales();
}

main().catch((error) => {
  logError("worker crashed on startup", error);
  process.exitCode = 1;
});

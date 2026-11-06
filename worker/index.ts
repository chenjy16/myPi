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
import { createLogger } from "../app/lib/logger";

/** 快照节奏：每小时第 15 分钟。同日重复抓是 upsert，天然幂等且能让当日数据保持新鲜。 */
const SNAPSHOT_CRON = process.env.WORKER_SNAPSHOT_CRON ?? "15 * * * *";
/** 销量重建节奏：默认每天 03:00（UTC）。 */
const SALES_CRON = process.env.WORKER_SALES_CRON ?? "0 3 * * *";
/** V2 自动化事件消费节奏（P1-10）：默认每 2 分钟；Phase 1 只认领+记日志，执行器是 no-op stub。 */
const AUTOMATION_CRON = process.env.WORKER_AUTOMATION_CRON ?? "*/2 * * * *";
/** 投递去重表 TTL 清理节奏（P1-11）：默认每小时第 45 分钟。 */
const DELIVERY_PRUNE_CRON = process.env.WORKER_DELIVERY_PRUNE_CRON ?? "45 * * * *";
/** 执行史保留清理节奏（P4-10）：默认每天 04:30（UTC），错开 03:00 的销量重建。 */
const RETENTION_PRUNE_CRON = process.env.WORKER_RETENTION_PRUNE_CRON ?? "30 4 * * *";
/** 漏投对账节奏（P4-13）：默认每 30 分钟；实际是否执行由 RECONCILE_ENABLED 决定（默认关）。 */
const RECONCILE_CRON = process.env.WORKER_RECONCILE_CRON ?? "*/30 * * * *";

// worker 侧一条绑定了 component 的结构化 logger；log/logError 只是保留原调用签名的薄封装。
const logger = createLogger({ component: "worker" });

function log(message: string, detail?: unknown): void {
  logger.info(message, detail === undefined ? undefined : { detail });
}

function logError(message: string, error: unknown): void {
  logger.error(message, { error });
}

/** 优雅退出所需的两类句柄：cron 排程（stop 后不再触发新任务）与共享 Prisma 池（disconnect 释放连接）。 */
type StoppableTask = { stop: () => void };
const scheduledTasks: StoppableTask[] = [];
let prismaClient: typeof import("../app/db.server").default | null = null;
let shuttingDown = false;

/**
 * 收到 SIGTERM/SIGINT：停止排程 → 断开共享池 → 干净退出。
 * 兜底定时器 unref，绝不因为等待断开而把进程钉住（容器停机有硬超时）。
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down gracefully`);
  for (const task of scheduledTasks) task.stop();

  const graceMs = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 10_000);
  const force = setTimeout(() => {
    logError("shutdown timed out, forcing exit", new Error("grace exceeded"));
    process.exit(1);
  }, Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 10_000);
  force.unref();

  const finish = () => {
    clearTimeout(force);
    process.exit(0);
  };
  if (!prismaClient) {
    finish();
    return;
  }
  prismaClient
    .$disconnect()
    .catch((error: unknown) => logError("prisma disconnect failed", error))
    .finally(finish);
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
    prismaModule, shopifyModule, inventoryModule, jobsModule, queueModule, deliveryModule, consumeModule, retentionModule, reconcileModule, reconcilePolicyModule] =
    await Promise.all([
      import("node-cron"),
      import("../app/db.server"),
      import("../app/shopify.server"),
      import("../app/inventory.server"),
      import("../app/sync-jobs.server"),
      import("../app/execution-queue.server"),
      import("../app/webhook-delivery.server"),
      import("../app/automation-engine/consume.server"),
      import("../app/execution-log.server"),
      import("../app/reconcile.server"),
      import("../app/lib/reconcile-policy"),
    ]);
  const prisma = prismaModule.default;
  prismaClient = prisma;
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

  /**
   * P1-10：消费自动化执行队列。Phase 1 只做「认领→记日志→收尾」，执行器是 no-op stub；
   * AUTOMATION_EXECUTION_ENABLED=true 之前不会有任何副作用动作（PRD P6 Safe by Default）。
   * 一次排程最多消化 BATCH 条，防止单轮扫描把池子占死；超租约残留由 claimNextEvent 内部回收。
   */
  const AUTOMATION_BATCH = Number(process.env.WORKER_AUTOMATION_BATCH ?? 20);
  const sweepAutomations = async (): Promise<void> => {
    const shops = await installedShops(prisma);
    const executionEnabled = process.env.AUTOMATION_EXECUTION_ENABLED === "true";
    let claimedTotal = 0;
    for (const shop of shops) {
      for (let i = 0; i < AUTOMATION_BATCH; i += 1) {
        try {
          const claimed = await queueModule.claimNextEvent(shop);
          if (!claimed) break;
          claimedTotal += 1;
          log(
            `automation claimed event for ${shop}: ${claimed.event.topic} ${claimed.event.entityId ?? "-"}`,
            { jobId: claimed.jobId, executorEnabled: executionEnabled },
          );
          // 执行器开关（PRD P6 Safe by Default）：关闭时只认领+收尾，绝不发任何 Mutation；
          // 打开时才走 P2-12 全链路（匹配→防循环前置→逐步执行→落库）。
          if (executionEnabled) {
            const { admin } = await unauthenticated.admin(shop);
            const outcomes = await consumeModule.processClaimedEvent(claimed.event, {
              admin,
              requestSource: `automation:worker:${claimed.jobId}`,
            });
            log(`automation executed for ${shop}`, {
              jobId: claimed.jobId,
              results: outcomes.map((o) => o.status),
            });
          }
          await queueModule.completeExecutionJob(claimed.jobId, true);
        } catch (error) {
          logError(`automation sweep failed for ${shop}`, error);
          break;
        }
      }
    }
    if (claimedTotal > 0) log(`automation sweep claimed ${claimedTotal} event(s)`);
  };

  /** P1-11：投递去重表按 TTL（默认 24h）瘦身，防无界增长。 */
  const pruneDeliveries = async (): Promise<void> => {
    try {
      const count = await deliveryModule.pruneOldDeliveries();
      if (count > 0) log(`pruned ${count} expired webhook deliveries`);
    } catch (error) {
      logError("delivery prune failed", error);
    }
  };

  /** P4-10：执行史超出保留窗口（EXECUTION_RETENTION_DAYS，默认 180 天）的旧行先掩蔽客户引用再删除。 */
  const pruneExecutions = async (): Promise<void> => {
    try {
      const result = await retentionModule.pruneOldExecutions();
      if (result.deleted > 0) {
        log(
          `pruned ${result.deleted} execution(s) older than ${result.retentionDays}d`
          + ` (masked ${result.masked}, batchCap: ${result.hitBatchCap})`,
          { cutoff: result.cutoff.toISOString() },
        );
      }
    } catch (error) {
      logError("execution retention prune failed", error);
    }
  };

  /**
   * P4-13：漏投对账。RECONCILE_ENABLED 默认关（Safe by Default）；开启后按店拉时间窗内
   * 商品变更，与已落执行/往轮补投比对，只把真正漏掉的重新入队（三层幂等，绝不重复执行）。
   */
  const reconcileConfig = reconcilePolicyModule.parseReconcileConfig(process.env);
  const reconcileSweep = async (): Promise<void> => {
    if (!reconcileConfig.enabled) return;
    const shops = await installedShops(prisma);
    const { since, until } = reconcilePolicyModule.reconcileWindow(
      new Date(),
      reconcileConfig.lookbackMinutes,
    );
    let requeuedTotal = 0;
    for (const shop of shops) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const result = await reconcileModule.reconcileShop({ admin, shopDomain: shop, since, until });
        requeuedTotal += result.requeued;
        if (result.requeued > 0) {
          log(`reconcile re-queued ${result.requeued} event(s) for ${shop}`, {
            scanned: result.scanned,
            skipped: result.skipped,
          });
        }
      } catch (error) {
        logError(`reconcile failed for ${shop}`, error);
      }
    }
    if (requeuedTotal > 0) log(`reconcile sweep re-queued ${requeuedTotal} event(s)`);
  };

  for (const [label, pattern] of [
    ["snapshot", SNAPSHOT_CRON],
    ["sales", SALES_CRON],
    ["automation", AUTOMATION_CRON],
    ["delivery-prune", DELIVERY_PRUNE_CRON],
    ["retention-prune", RETENTION_PRUNE_CRON],
    ["reconcile", RECONCILE_CRON],
  ] as const) {
    if (!validate(pattern)) {
      console.error(`[worker] Invalid cron expression for ${label}: ${pattern}`);
      process.exit(1);
    }
  }

  log(
    `worker started (snapshot: ${SNAPSHOT_CRON}, sales: ${SALES_CRON}, automation: ${AUTOMATION_CRON}, delivery-prune: ${DELIVERY_PRUNE_CRON}, retention-prune: ${RETENTION_PRUNE_CRON}, reconcile: ${RECONCILE_CRON} enabled=${reconcileConfig.enabled}, pid: ${process.pid})`,
  );

  // noOverlap 防止同一进程内上一次扫描还没跑完就被下一个调度点重入。
  scheduledTasks.push(
    schedule(SNAPSHOT_CRON, () => void sweepSnapshots(), {
      name: "inventory-snapshot",
      noOverlap: true,
    }),
    schedule(SALES_CRON, () => void sweepSales(), {
      name: "sales-daily",
      noOverlap: true,
    }),
    schedule(AUTOMATION_CRON, () => void sweepAutomations(), {
      name: "automation-execute",
      noOverlap: true,
    }),
    schedule(DELIVERY_PRUNE_CRON, () => void pruneDeliveries(), {
      name: "webhook-delivery-prune",
      noOverlap: true,
    }),
    schedule(RETENTION_PRUNE_CRON, () => void pruneExecutions(), {
      name: "execution-retention-prune",
      noOverlap: true,
    }),
  );

  // 对账仅在显式开启时排程：默认关时连 cron 句柄都不建，零开销、零副作用。
  if (reconcileConfig.enabled) {
    scheduledTasks.push(
      schedule(RECONCILE_CRON, () => void reconcileSweep(), {
        name: "webhook-reconcile",
        noOverlap: true,
      }),
    );
  }

  // 排程就绪后才接管停机信号：此时可以安全地 stop 排程并断池。
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // 启动即补跑一次：worker 停机期间错过的整点不必等到下一个调度点。
  await sweepSnapshots();
  await sweepSales();
  await sweepAutomations();
  await pruneExecutions();
}

main().catch((error) => {
  logError("worker crashed on startup", error);
  process.exitCode = 1;
});

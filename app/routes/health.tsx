import { type HeadersFunction } from "react-router";
import db from "../db.server";
import { collectAutomationHealth } from "../health-automation.server";
import { buildAutomationHealth, parseHeartbeatStaleMs, parseMetricWindowMs } from "../lib/health-automation";
import { createLogger } from "../lib/logger";

const logger = createLogger({ component: "health" });

/**
 * 供负载均衡、容器编排与滚动发布使用的存活/就绪探针。
 *
 * 两条硬性要求：
 *   1. 不做 Shopify 鉴权 —— 探针没有 session，也不该被 app-bridge 重定向；
 *   2. 有超时上限 —— DATABASE_URL 里的 connect_timeout 是 20s，直接 await 会让
 *      探针在数据库卡住时超过探测窗口，把「慢」误报成「健康检查失败」以外的东西。
 */

/** 单次探测的数据库等待上限（毫秒），超过即判定不可用。 */
function pingTimeoutMs(): number {
  const configured = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 3000);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 10_000)
    : 3000;
}

/** 版本优先取部署注入的环境变量，本地开发回落到 package.json。 */
function appVersion(): string {
  return process.env.APP_VERSION || process.env.npm_package_version || "dev";
}

async function pingDatabase(): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("database ping timed out")),
          pingTimeoutMs(),
        );
      }),
    ]);
    return true;
  } catch (error) {
    logger.error("database ping failed", { error });
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** GET /health → 200 存活且就绪；数据库不可用返回 503（就绪失败，应摘除流量）。 */
export const loader = async () => {
  const databaseReachable = await pingDatabase();
  // 自动化态势只在 DB 可达时采集；任一子查询失败已在编排层降级为 null，
  // 这里给纯函数喂全 null 得到「unknown 快照」。DB 断连时同样呈现 unknown，
  // 但整体仍是 503（摘流量判据只由 database 决定，automation 维度永不影响状态码）。
  const automation = databaseReachable
    ? await collectAutomationHealth(db)
    : buildAutomationHealth({
        windowMs: parseMetricWindowMs(),
        heartbeatStaleMs: parseHeartbeatStaleMs(),
        now: new Date(),
        queueDepth: null,
        statusCounts: null,
        awaitingConfirmation: null,
        lastHeartbeatAt: null,
      });
  const body = {
    status: databaseReachable ? "ok" : "degraded",
    database: databaseReachable ? "up" : "down",
    version: appVersion(),
    uptimeSeconds: Math.round(process.uptime()),
    automation,
    checkedAt: new Date().toISOString(),
  };
  return Response.json(body, { status: databaseReachable ? 200 : 503 });
};

export const headers: HeadersFunction = () => ({
  // 探针结果不允许被 CDN 或浏览器缓存，否则滚动发布时会读到上一轮的健康状态。
  "Cache-Control": "no-store, max-age=0",
});

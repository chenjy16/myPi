export type DataHealthTone = "ok" | "warn" | "critical";

/** 数据健康的整体结论：paused 是「不该照建议下单」，不只是「有点问题」。 */
export type DataHealthState = "healthy" | "degraded" | "paused";

export type DataHealthCheck = {
  key: string;
  label: string;
  tone: DataHealthTone;
  detail: string;
  /** true 表示这一项不达标就不该把建议递给商家，Action Board 整页进 Paused。 */
  blocksRecommendations: boolean;
};

export type DataHealth = {
  state: DataHealthState;
  paused: boolean;
  pauseReasons: string[];
  checks: DataHealthCheck[];
  snapshotAgeHours: number | null;
};

export type DataHealthInput = {
  hasOfflineSession: boolean;
  locationName: string | null;
  /** 最新快照日的 capturedAt，用于算数据新鲜度。 */
  snapshotCapturedAt: Date | null;
  newestSnapshotDate: string | null;
  trackedVariantCount: number;
  lastInventorySyncAt: Date | null;
  lastSalesSyncAt: Date | null;
  salesHistoryComplete: boolean;
  /** 最近一批同步任务里连续失败的次数（按任务类型取最大值）。 */
  consecutiveFailures: number;
  /** 读不到单位成本的变体占比（0~1），null 表示还没算过。 */
  costCoverage: number | null;
  today: string;
  now: Date;
};

/** 快照超过这个小时数即视为过期，与补货置信度用同一把尺。 */
const SNAPSHOT_STALE_HOURS = 48;

function ageHours(capturedAt: Date, now: Date): number {
  return (now.getTime() - capturedAt.getTime()) / 3_600_000;
}

/**
 * 数据健康评估：只认事实，不做推测。
 * 任何 blocksRecommendations 的检查不达标就整页暂停，避免拿脏数据出补货建议。
 */
export function evaluateDataHealth(input: DataHealthInput): DataHealth {
  const checks: DataHealthCheck[] = [];

  checks.push(
    input.hasOfflineSession
      ? {
          key: "authorization",
          label: "Store authorization",
          tone: "ok",
          detail:
            "A background session is stored, so syncs and webhooks can run.",
          blocksRecommendations: true,
        }
      : {
          key: "authorization",
          label: "Store authorization",
          tone: "critical",
          detail:
            "No stored background session for this store. Re-authorize the app.",
          blocksRecommendations: true,
        },
  );

  checks.push(
    input.locationName
      ? {
          key: "primary_location",
          label: "Primary location",
          tone: "ok",
          detail: `Stock coverage reads ${input.locationName}.`,
          blocksRecommendations: true,
        }
      : {
          key: "primary_location",
          label: "Primary location",
          tone: "critical",
          detail: "No inventory location selected, so nothing can be measured.",
          blocksRecommendations: true,
        },
  );

  const snapshotAgeHours = input.snapshotCapturedAt
    ? ageHours(input.snapshotCapturedAt, input.now)
    : null;

  if (!input.newestSnapshotDate) {
    checks.push({
      key: "inventory_snapshot",
      label: "Inventory snapshot",
      tone: "critical",
      detail:
        "No inventory snapshot captured yet. Run a sync to start the daily series.",
      blocksRecommendations: true,
    });
  } else if (
    snapshotAgeHours !== null &&
    snapshotAgeHours > SNAPSHOT_STALE_HOURS
  ) {
    checks.push({
      key: "inventory_snapshot",
      label: "Inventory snapshot",
      tone: "critical",
      detail: `The newest snapshot is ${Math.round(snapshotAgeHours)} hours old (taken ${input.newestSnapshotDate}). Stock numbers are too stale to base a purchase on.`,
      blocksRecommendations: true,
    });
  } else if (input.newestSnapshotDate !== input.today) {
    checks.push({
      key: "inventory_snapshot",
      label: "Inventory snapshot",
      tone: "warn",
      detail: `The newest snapshot is dated ${input.newestSnapshotDate}; today is ${input.today}. The next scheduled sync will close the gap.`,
      blocksRecommendations: false,
    });
  } else {
    checks.push({
      key: "inventory_snapshot",
      label: "Inventory snapshot",
      tone: "ok",
      detail: `${input.trackedVariantCount} trackable variants captured for ${input.newestSnapshotDate}.`,
      blocksRecommendations: true,
    });
  }

  if (!input.lastSalesSyncAt) {
    checks.push({
      key: "sales_history",
      label: "Sales history",
      tone: "critical",
      detail: "No order history synced yet, so observed demand is empty.",
      blocksRecommendations: true,
    });
  } else if (!input.salesHistoryComplete) {
    checks.push({
      key: "sales_history",
      label: "Sales history",
      tone: "warn",
      detail:
        "Only the last 60 days of orders are readable with the current authorization, so long-run demand stays unverified.",
      blocksRecommendations: false,
    });
  } else {
    checks.push({
      key: "sales_history",
      label: "Sales history",
      tone: "ok",
      detail: "At least 90 days of paid order history is available.",
      blocksRecommendations: true,
    });
  }

  checks.push(
    input.consecutiveFailures >= 2
      ? {
          key: "sync_failures",
          label: "Background sync",
          tone: "critical",
          detail: `${input.consecutiveFailures} recent sync attempts failed. Recommendations stay paused until one succeeds.`,
          blocksRecommendations: true,
        }
      : input.consecutiveFailures === 1
        ? {
            key: "sync_failures",
            label: "Background sync",
            tone: "warn",
            detail: "The latest sync attempt failed. The scheduler will retry.",
            blocksRecommendations: false,
          }
        : {
            key: "sync_failures",
            label: "Background sync",
            tone: "ok",
            detail: "Scheduled and webhook syncs are completing.",
            blocksRecommendations: false,
          },
  );

  checks.push(
    input.costCoverage === null || input.costCoverage < 1
      ? {
          key: "product_cost",
          label: "Product costs",
          tone: "warn",
          detail:
            input.costCoverage === null
              ? "Product costs haven't been read yet, so inventory value is unavailable."
              : `Costs are readable for ${Math.round(input.costCoverage * 100)}% of variants, so inventory value is an incomplete estimate.`,
          blocksRecommendations: false,
        }
      : {
          key: "product_cost",
          label: "Product costs",
          tone: "ok",
          detail: "Product costs are readable for every tracked variant.",
          blocksRecommendations: false,
        },
  );

  const pauseReasons = checks
    .filter((check) => check.tone === "critical" && check.blocksRecommendations)
    .map((check) => `${check.label}: ${check.detail}`);
  const paused = pauseReasons.length > 0;
  const degraded = checks.some((check) => check.tone !== "ok");

  return {
    state: paused ? "paused" : degraded ? "degraded" : "healthy",
    paused,
    pauseReasons,
    checks,
    snapshotAgeHours,
  };
}

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import db from "./db.server";
import { adminGraphql } from "./lib/admin-graphql.server";
import { AppError } from "./lib/app-error";
import {
  calculateInventoryHealth,
  countDaysInclusive,
  formatDateInTimeZone,
  shiftDate,
  DEFAULT_DEMAND_WINDOW_DAYS,
  INVENTORY_STATUS_LABELS,
  type InventoryHealth,
  type VariantSupplyTerms,
} from "./lib/inventory-calculations";
import {
  evaluateDataHealth,
  type DataHealth,
  type DataHealthInput,
} from "./lib/data-health";
import {
  calculateAdoptionMetrics,
  resolveActionBoardState,
  summarizeActionBoard,
  ACTION_BOARD_LABELS,
  type ActionBoardCounts,
  type ActionBoardState,
} from "./lib/reorder-action-board";
import {
  buildReorderCsv,
  buildReorderFileName,
  type ReorderExportRow,
} from "./lib/reorder-export";
import {
  calculateReorderConfidence,
  isReorderConfidenceLevel,
  type ReorderConfidence,
  type ReorderConfidenceLevel,
} from "./lib/reorder-confidence";
import {
  AUDIT_ACTION_BY_DECISION_STATUS,
  AUDIT_OPERATOR_SYSTEM,
  isReorderDecisionStatus,
  type ReorderDecisionStatus,
} from "./lib/reorder-recommendations";
import {
  DEFAULT_REPLENISHMENT_SETTINGS,
  hasReplenishmentChange,
  type ReplenishmentSettings,
} from "./lib/settings-validation";
import {
  withSyncJob,
  consecutiveFailures,
  type SyncTrigger,
} from "./sync-jobs.server";

const LOCATIONS_QUERY = `#graphql
  query StockPilotLocations($after: String) {
    locations(first: 250, after: $after, includeInactive: false) {
      nodes {
        id
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

const SHOP_SETTINGS_QUERY = `#graphql
  query StockPilotShopSettings {
    shop {
      currencyCode
      ianaTimezone
    }
  }`;

const VARIANTS_QUERY = `#graphql
  query StockPilotVariants($after: String) {
    productVariants(first: 250, after: $after) {
      nodes {
        id
        title
        sku
        product {
          id
          title
          status
        }
        inventoryItem {
          tracked
          unitCost {
            amount
          }
          inventoryLevels(first: 250) {
            nodes {
              location {
                id
              }
              quantities(names: ["available", "incoming", "on_hand"]) {
                name
                quantity
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

const ORDERS_QUERY = `#graphql
  query StockPilotOrders($after: String, $query: String!) {
    orders(first: 250, after: $after, sortKey: PROCESSED_AT, query: $query) {
      nodes {
        processedAt
        cancelledAt
        displayFinancialStatus
        lineItems(first: 250) {
          nodes {
            quantity
            variant {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

/** webhook 只带订单 id，销量重算以 Admin API 读回的单张订单为准（避开 payload 字段形状变动）。 */
const ORDER_BY_ID_QUERY = `#graphql
  query StockPilotOrder($id: ID!) {
    order(id: $id) {
      processedAt
      cancelledAt
      displayFinancialStatus
      lineItems(first: 250) {
        nodes {
          quantity
          variant {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }`;

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type Location = { id: string; name: string };

type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  product: { id: string; title: string; status: string };
  inventoryItem: {
    tracked: boolean;
    unitCost: { amount: string } | null;
    inventoryLevels: {
      nodes: Array<{
        location: { id: string };
        quantities: Array<{ name: string; quantity: number }>;
      }>;
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
};

type OrderNode = {
  processedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  lineItems: {
    nodes: Array<{ quantity: number; variant: { id: string } | null }>;
    pageInfo: { hasNextPage: boolean };
  };
};

/**
 * 分页响应的具名类型。分页游标以对象简写（`{ after }`）传参时，TS 需要借助
 * 「返回值 → 游标赋值 → 参数类型」才能解出类型，会退化成隐式 any（TS7022）；
 * 显式命名并标注绑定即可断开这条推断环。
 */
type LocationsPayload = {
  locations: { nodes: Location[]; pageInfo: PageInfo };
};

type VariantsPayload = {
  productVariants: { nodes: VariantNode[]; pageInfo: PageInfo };
};

type OrdersPayload = {
  orders: { nodes: OrderNode[]; pageInfo: PageInfo };
};

type InventoryRow = {
  id: string;
  shop: string;
  locationId: string;
  variantId: string;
  snapshotDate: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  tracked: boolean;
  available: number;
  incoming: number;
  onHand: number | null;
  unitCost: number | null;
  capturedAt: Date;
};

export type InventoryLocation = Location;

export type InventorySyncResult = {
  variantCount: number;
  orderCount: number;
  historyDaysAvailable: number;
  costCoverage: number;
  /** 本次同步新登记成待办的正数建议条数；0 表示没产生可操作的新建议，UI 据此如实措辞。 */
  pendingSuggestionsRegistered: number;
  syncedAt: string;
};

export type DashboardSettings = {
  locationId: string | null;
  locationName: string | null;
  timezone: string;
  currencyCode: string;
  leadTimeDays: number;
  safetyStockDays: number;
  reviewPeriodDays: number;
  lastInventorySyncAt: Date | null;
  lastSalesSyncAt: Date | null;
  salesHistoryComplete: boolean;
  salesWindowStart: string | null;
  /** 商家保存过补货参数的时间；null 表示三列还是 schema 默认值，UI 据此标注参数来源。 */
  replenishmentSettingsSavedAt: Date | null;
};

/** 已落库的商家决策，needsReview 表示同步后建议量已经与当初确认的不一致。 */
export type SavedRecommendation = {
  status: ReorderDecisionStatus;
  suggestedQuantity: number;
  quantity: number;
  needsReview: boolean;
  confidence: ReorderConfidenceLevel;
  computedAt: Date;
  /** 商家改量/忽略时留下的理由；无则 null。 */
  decisionReason: string | null;
};

export type DashboardVariant = InventoryHealth & {
  id: string;
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  snapshotDate: string;
  confidence: ReorderConfidence;
  actionState: ActionBoardState | null;
  recommendation: SavedRecommendation | null;
};

/** 六态 Action Board 的计数与采纳指标，首页与库存页共用。 */
export type ActionBoardSummary = {
  counts: ActionBoardCounts;
  adoption: {
    adoptionRate: number | null;
    reviewedRate: number | null;
    actionableCount: number;
  };
};

export type InventoryDashboard = {
  settings: DashboardSettings | null;
  locations: InventoryLocation[];
  metrics: {
    totalSkus: number;
    availableStock: number;
    lowStock: number;
    atRisk: number;
    overstock: number;
    deadStock: number;
    inventoryValue: number;
    variantsMissingCost: number;
  };
  variants: DashboardVariant[];
  dataHealth: DataHealth;
  historyDaysAvailable: number;
  snapshotDate: string | null;
  board: ActionBoardSummary;
};

/** 分页读取店铺全部启用中的库存地点。 */
export async function fetchInventoryLocations(
  admin: AdminApiContext,
): Promise<InventoryLocation[]> {
  const locations: InventoryLocation[] = [];
  let after: string | null = null;

  do {
    const data: LocationsPayload = await adminGraphql<LocationsPayload>(
      admin,
      LOCATIONS_QUERY,
      { variables: { after } },
    );
    locations.push(...data.locations.nodes);
    after = data.locations.pageInfo.hasNextPage
      ? data.locations.pageInfo.endCursor
      : null;
  } while (after);

  return locations;
}

/** 把店铺全部地点写入 Location 表，作为多地点数据模型的基础目录。 */
async function syncLocations(
  shop: string,
  locations: InventoryLocation[],
  syncedAt: Date,
): Promise<void> {
  for (const location of locations) {
    await db.location.upsert({
      where: {
        shop_shopifyLocationId: {
          shop,
          shopifyLocationId: location.id,
        },
      },
      create: {
        shop,
        shopifyLocationId: location.id,
        name: location.name,
        syncedAt,
      },
      update: {
        name: location.name,
        isActive: true,
        syncedAt,
      },
    });
  }
}

/**
 * 统一的交互式事务入口。数据库是远程 Postgres，每条语句都要一次网络往返，
 * 整批快照/销量写入很容易顶穿 Prisma 默认的 5s 超时（P2028: Transaction already closed），
 * 所以这里统一放宽事务预算，而不是让某个同步任务在店铺变大后随机失败。
 */
async function withTransaction<T>(
  run: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(run, { timeout: 30_000, maxWait: 10_000 });
}

/** 保存本店选中的库存地点（业务单地点）；快照按地点分开保留，切换地点不再清空历史。 */
export async function saveInventoryLocation(
  shop: string,
  location: InventoryLocation,
): Promise<void> {
  const settings = await db.inventorySettings.findUnique({ where: { shop } });
  if (settings?.locationId === location.id) {
    await db.inventorySettings.update({
      where: { shop },
      data: { locationName: location.name },
    });
    return;
  }

  await withTransaction(async (transaction) => {
    await transaction.inventorySettings.upsert({
      where: { shop },
      create: {
        shop,
        locationId: location.id,
        locationName: location.name,
      },
      update: {
        locationId: location.id,
        locationName: location.name,
        lastInventorySyncAt: null,
      },
    });
  });
}

/** 保存结果的口径：参数是否真的变了、重算影响到多少行建议。 */
export type ReplenishmentSettingsSaveResult = {
  changed: boolean;
  registered: number;
  refreshed: number;
};

/**
 * 保存商家设定的补货参数 —— 这三列此前只有 schema 默认值、全仓零写入路径，
 * 页面上的 "System estimate" 因此永远名不副实。这里把校验过的值真正落库，
 * 并记下保存时间，让 UI 能区分「商家设置」与「系统估计」。
 * 只有参数真的变了才重算建议：没变也重算会把商家刚做过决策的数字搅动，
 * 那是最难解释的体验；重算本身复用 registerReorderSuggestions，
 * 已表态的行只刷新计算口径、不覆盖商家选的量和状态。
 */
export async function saveReplenishmentSettings(
  shop: string,
  next: ReplenishmentSettings,
): Promise<ReplenishmentSettingsSaveResult> {
  const row = await db.inventorySettings.findUnique({ where: { shop } });
  const current: ReplenishmentSettings = row
    ? {
        leadTimeDays: row.leadTimeDays,
        safetyStockDays: row.safetyStockDays,
        reviewPeriodDays: row.reviewPeriodDays,
      }
    : DEFAULT_REPLENISHMENT_SETTINGS;
  const changed = hasReplenishmentChange(current, next);

  // 同步任务的 upsert 从不带这三列，所以这里的写入不会被后续同步覆盖回去。
  const savedAt = new Date();
  await db.inventorySettings.upsert({
    where: { shop },
    create: { shop, ...next, replenishmentSettingsSavedAt: savedAt },
    update: { ...next, replenishmentSettingsSavedAt: savedAt },
  });

  if (!changed) {
    return { changed: false, registered: 0, refreshed: 0 };
  }
  const { registered, refreshed } = await registerReorderSuggestions(
    shop,
    savedAt,
  );
  return { changed: true, registered, refreshed };
}

/** 按 (shop, locationId, variantId) 写入或更新商家补货决策，不调用 Shopify。 */
/**
 * 保存商家的一次补货决策：更新当前态并在审计流水里追加一行。
 * 两件工作在同一个事务里提交，避免「状态改了但审计丢了」这种不可审计的中间态。
 * 只改本应用数据，不写 Shopify、不建采购单。
 */
export async function saveReorderRecommendation(input: {
  shop: string;
  locationId: string;
  variantId: string;
  suggestedQuantity: number;
  quantity: number;
  status: ReorderDecisionStatus;
  confidence: ReorderConfidenceLevel;
  demandWindowDays: number;
  demandPerDay: number;
  demandSampleDays: number;
  operator: string | null;
  /** 商家理由（edit/ignore 时收集），随本次决策覆盖当前态并落审计。 */
  reason?: string | null;
  /** 请求级幂等键；同键重复提交会撞审计表唯一索引（P2002）。 */
  requestKey?: string | null;
}): Promise<void> {
  const key = {
    shop: input.shop,
    locationId: input.locationId,
    variantId: input.variantId,
  };
  const existing = await db.reorderRecommendation.findUnique({
    where: { shop_locationId_variantId: key },
    select: { status: true },
  });
  const computedAt = new Date();
  const calculation = {
    suggestedQuantity: input.suggestedQuantity,
    confidence: input.confidence,
    demandWindowDays: input.demandWindowDays,
    demandPerDay: input.demandPerDay,
    demandSampleDays: input.demandSampleDays,
    computedAt,
  };

  await withTransaction(async (transaction) => {
    await transaction.reorderRecommendation.upsert({
      where: { shop_locationId_variantId: key },
      create: {
        ...key,
        quantity: input.quantity,
        status: input.status,
        decisionReason: input.reason ?? null,
        ...calculation,
      },
      update: {
        quantity: input.quantity,
        status: input.status,
        decisionReason: input.reason ?? null,
        ...calculation,
      },
    });

    await transaction.recommendationAudit.create({
      data: {
        ...key,
        action: AUDIT_ACTION_BY_DECISION_STATUS[input.status],
        fromStatus: existing?.status ?? null,
        toStatus: input.status,
        suggestedQuantity: input.suggestedQuantity,
        quantity: input.quantity,
        confidence: input.confidence,
        operator: input.operator,
        reason: input.reason ?? null,
        requestKey: input.requestKey ?? null,
      },
    });
  });
}

/**
 * 同步后登记待办：每个给出正数建议的变体保留一行决策记录，首次登记为 pending 并写 created 审计。
 * 已表态的行只刷新计算口径，绝不覆盖商家选的量和状态，避免同步把人工决策冲掉。
 * 只面向主地点计算，与看板口径一致；没选地点时直接返回空。
 */
export async function registerReorderSuggestions(
  shop: string,
  now = new Date(),
): Promise<{ registered: number; refreshed: number }> {
  const settingsRow = await db.inventorySettings.findUnique({
    where: { shop },
  });
  const locationId = settingsRow?.locationId;
  if (!settingsRow || !locationId) {
    return { registered: 0, refreshed: 0 };
  }

  const settings = toDashboardSettings(settingsRow);
  const today = formatDateInTimeZone(now, settings.timezone);
  const [newest, savedRecommendations] = await Promise.all([
    db.inventorySnapshot.findFirst({
      where: { shop, locationId },
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true, capturedAt: true },
    }),
    db.reorderRecommendation.findMany({ where: { shop, locationId } }),
  ]);
  if (!newest) return { registered: 0, refreshed: 0 };

  const [inventory, sales] = await Promise.all([
    db.inventorySnapshot.findMany({
      where: {
        shop,
        locationId,
        tracked: true,
        snapshotDate: newest.snapshotDate,
      },
      select: {
        id: true,
        locationId: true,
        variantId: true,
        snapshotDate: true,
        productId: true,
        productTitle: true,
        variantTitle: true,
        sku: true,
        available: true,
        incoming: true,
        unitCost: true,
      },
    }),
    db.salesDaily.findMany({
      where: { shop, date: { gte: shiftDate(today, -89), lte: today } },
    }),
  ]);

  const plans = buildVariantPlans({
    settings,
    rows: inventory,
    salesByVariant: groupSalesByVariant(sales),
    recommendationsByVariant: newMapByKey(
      savedRecommendations,
      (item) => item.variantId,
    ),
    supplyTermsByVariant: await loadSupplyTermsMap(shop),
    snapshotAgeHours: (now.getTime() - newest.capturedAt.getTime()) / 3_600_000,
    historyDaysAvailable: settings.salesHistoryComplete ? 90 : 60,
    // 登记阶段不掺入暂停判定，paused 只在展示时派生，不写进商家可见的历史决策。
    dataPaused: false,
    today,
  });
  const suggestions = plans.filter((plan) => plan.suggestedReorderQuantity > 0);
  const existingVariantIds = new Set(
    savedRecommendations.map((item) => item.variantId),
  );
  const toRegister = suggestions.filter(
    (plan) => !existingVariantIds.has(plan.variantId),
  );
  const toRefresh = suggestions.filter((plan) =>
    existingVariantIds.has(plan.variantId),
  );

  if (toRegister.length === 0 && toRefresh.length === 0) {
    return { registered: 0, refreshed: 0 };
  }

  const calculationOf = (plan: DashboardVariant) => ({
    suggestedQuantity: plan.suggestedReorderQuantity,
    confidence: plan.confidence.level,
    demandWindowDays: plan.observedDemand.windowDays,
    demandPerDay: plan.observedDemand.perDay,
    demandSampleDays: plan.observedDemand.sampleDaysAvailable,
    computedAt: now,
  });

  await withTransaction(async (transaction) => {
    if (toRegister.length > 0) {
      await transaction.reorderRecommendation.createMany({
        data: toRegister.map((plan) => ({
          shop,
          locationId,
          variantId: plan.variantId,
          status: "pending" satisfies ReorderDecisionStatus,
          quantity: plan.suggestedReorderQuantity,
          ...calculationOf(plan),
        })),
      });
      await transaction.recommendationAudit.createMany({
        data: toRegister.map((plan) => ({
          shop,
          locationId,
          variantId: plan.variantId,
          action: AUDIT_ACTION_BY_DECISION_STATUS.pending,
          fromStatus: null,
          toStatus: "pending",
          suggestedQuantity: plan.suggestedReorderQuantity,
          quantity: plan.suggestedReorderQuantity,
          confidence: plan.confidence.level,
          operator: AUDIT_OPERATOR_SYSTEM,
          createdAt: now,
        })),
      });
    }

    for (const plan of toRefresh) {
      await transaction.reorderRecommendation.updateMany({
        where: { shop, locationId, variantId: plan.variantId },
        data: calculationOf(plan),
      });
    }
  });

  return { registered: toRegister.length, refreshed: toRefresh.length };
}

/** 取某变体的决策审计流水，最新的在前。 */
export async function getRecommendationAuditTrail(
  shop: string,
  locationId: string,
  variantId: string,
  take = 20,
) {
  return db.recommendationAudit.findMany({
    where: { shop, locationId, variantId },
    orderBy: { createdAt: "desc" },
    take,
    select: AUDIT_TRAIL_FIELDS,
  });
}

/** 本店铺最近的决策流水，给库存页的审计面板直接展示。 */
export async function getRecentRecommendationAudit(shop: string, take = 20) {
  return db.recommendationAudit.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
    select: AUDIT_TRAIL_FIELDS,
  });
}

/** 审计面板只读展示这些字段，token/内部主键一概不外泄。 */
const AUDIT_TRAIL_FIELDS = {
  action: true,
  fromStatus: true,
  toStatus: true,
  suggestedQuantity: true,
  quantity: true,
  confidence: true,
  operator: true,
  reason: true,
  createdAt: true,
  variantId: true,
} satisfies Prisma.RecommendationAuditSelect;

export type RecommendationAuditTrailEntry =
  Prisma.RecommendationAuditGetPayload<{
    select: typeof AUDIT_TRAIL_FIELDS;
  }>;

/**
 * 组装当前 Action Board 的 CSV 导出：重跑一次看板计算，保证导出的数字与页面看到的同源。
 * 只导出进入 Action Board 的行（有正数建议或已表过态），不把全部健库存变体塞进去。
 */
export async function buildReorderExport(
  shop: string,
  canReadAllOrders: boolean,
  now = new Date(),
): Promise<{ fileName: string; csv: string; rowCount: number }> {
  const dashboard = await getInventoryDashboard(
    shop,
    [],
    canReadAllOrders,
    now,
  );
  const today = formatDateInTimeZone(
    now,
    dashboard.settings?.timezone ?? "UTC",
  );
  const syncedAt =
    dashboard.settings?.lastInventorySyncAt?.toISOString() ?? null;
  const rows = dashboard.variants
    .filter((variant) => variant.actionState !== null)
    .map((variant) =>
      toReorderExportRow(variant, {
        shop,
        currencyCode: dashboard.settings?.currencyCode ?? "USD",
        syncedAt,
      }),
    );

  return {
    fileName: buildReorderFileName(today),
    csv: buildReorderCsv(rows),
    rowCount: rows.length,
  };
}

/** 把一行看板数据摊平成导出行：诊断、公式输入、置信度理由与商家决策一起写进文件。 */
function toReorderExportRow(
  variant: DashboardVariant,
  meta: { shop: string; currencyCode: string; syncedAt: string | null },
): ReorderExportRow {
  const { observedDemand, replenishment } = variant;
  return {
    store: meta.shop,
    productTitle: variant.productTitle,
    variantTitle: variant.variantTitle,
    sku: variant.sku,
    healthStatus: INVENTORY_STATUS_LABELS[variant.status],
    actionState: variant.actionState
      ? ACTION_BOARD_LABELS[variant.actionState]
      : "Not on board",
    available: variant.available,
    incoming: variant.incoming,
    observedDemandQuantity: observedDemand.quantity,
    observedDemandWindowDays: observedDemand.windowDays,
    observedDemandSampleDays: observedDemand.sampleDaysAvailable,
    observedDailySales: round2(observedDemand.perDay),
    daysOfInventory:
      variant.daysOfInventory === null ? null : round2(variant.daysOfInventory),
    estimatedStockoutDate: variant.estimatedStockoutDate,
    leadTimeDays: replenishment.leadTimeDays,
    reviewPeriodDays: replenishment.reviewPeriodDays,
    safetyStockDays: replenishment.safetyStockDays,
    coverageDays: replenishment.coverageDays,
    reorderPoint:
      variant.reorderPoint === null ? null : round2(variant.reorderPoint),
    targetStock:
      variant.targetStock === null ? null : round2(variant.targetStock),
    suggestedQuantity: variant.suggestedReorderQuantity,
    decidedQuantity: variant.recommendation?.quantity ?? null,
    confidence: variant.confidence.level,
    confidenceReasons: variant.confidence.reasons.map((reason) => reason.label),
    unitCost: variant.unitCost,
    inventoryValue:
      variant.inventoryValue === null ? null : round2(variant.inventoryValue),
    currencyCode: meta.currencyCode,
    snapshotDate: variant.snapshotDate,
    syncedAt: meta.syncedAt,
  };
}

/** 导出里的金额与日均统一保留 2 位，避免长小数把表格挤坏。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function newMapByKey<T>(
  items: T[],
  keyOf: (item: T) => string,
): Map<string, T> {
  return new Map(items.map((item) => [keyOf(item), item]));
}

/**
 * 全量同步入口：拉齐地点、库存与订单销量，快照按店铺时区写成当日一行，日销量整窗重建。
 * 写入在同一个事务中提交，拉取失败不会留下半份新数据；每次执行都登记进 DataSyncJob 台账。
 * 只读 Shopify，不改库存、不建采购单。
 */
export async function syncInventoryAndSales(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  canReadAllOrders: boolean,
  triggeredBy: SyncTrigger = "manual",
): Promise<InventorySyncResult> {
  return withSyncJob(
    { shop, jobType: "inventory-snapshot", triggeredBy },
    async () => {
      const result = await runInventorySync(
        admin,
        shop,
        locationId,
        canReadAllOrders,
      );
      return { result, recordsProcessed: result.variantCount };
    },
  );
}

async function runInventorySync(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  canReadAllOrders: boolean,
): Promise<InventorySyncResult> {
  const locations = await fetchInventoryLocations(admin);
  const selectedLocation = locations.find(({ id }) => id === locationId);
  if (!selectedLocation) {
    throw new AppError(
      "validation",
      "The selected inventory location is no longer available. Please choose a location again and sync.",
    );
  }

  const shopData = await adminGraphql<{
    shop: { currencyCode: string; ianaTimezone: string };
  }>(admin, SHOP_SETTINGS_QUERY);
  const { currencyCode, ianaTimezone } = shopData.shop;
  const now = new Date();
  const today = formatDateInTimeZone(now, ianaTimezone);
  const historyDaysAvailable = canReadAllOrders ? 90 : 60;
  const startDate = shiftDate(today, -(historyDaysAvailable - 1));
  await syncLocations(shop, locations, now);
  const inventoryRows = await fetchInventory(
    admin,
    shop,
    [locationId],
    today,
    now,
  );
  const { salesRows, orderCount } = await fetchSales(
    admin,
    shop,
    startDate,
    ianaTimezone,
  );
  const trackedVariants = inventoryRows.filter((row) => row.tracked);
  const costCoverage =
    trackedVariants.length === 0
      ? 1
      : trackedVariants.filter((row) => row.unitCost !== null).length /
        trackedVariants.length;

  await withTransaction(async (transaction) => {
    // 日销量按「只重建刚读到的窗口」处理，绝不整表抹掉本店铺全部历史：
    // - 只有真的读到行时才删窗口 + 重建，避免一次读不到订单（无 read_all_orders、
    //   限流、或暂时 0 成交）就把商家已有的需求证据清零、连带瘫痪整条建议链；
    // - 删除范围限定在 startDate 之后，窗口外的历史日期原样保留，供时间序列与解释使用。
    if (salesRows.length > 0) {
      await transaction.salesDaily.deleteMany({
        where: { shop, date: { gte: startDate } },
      });
      for (const batch of chunk(salesRows, 500)) {
        await transaction.salesDaily.createMany({ data: batch });
      }
    }

    await persistSnapshotRows(transaction, inventoryRows);

    await transaction.inventorySettings.upsert({
      where: { shop },
      create: {
        shop,
        locationId,
        locationName: selectedLocation.name,
        timezone: ianaTimezone,
        currencyCode,
        lastInventorySyncAt: now,
        lastSalesSyncAt: now,
        salesHistoryComplete: canReadAllOrders,
        salesWindowStart: startDate,
      },
      update: {
        locationId,
        locationName: selectedLocation.name,
        timezone: ianaTimezone,
        currencyCode,
        lastInventorySyncAt: now,
        lastSalesSyncAt: now,
        salesHistoryComplete: canReadAllOrders,
        salesWindowStart: startDate,
      },
    });
  });

  // 同步完就把正数建议登记成待办行，Action Board 的 Pending 不依赖商家手动点什么。
  const { registered } = await registerReorderSuggestions(shop, now);

  return {
    variantCount: trackedVariants.length,
    orderCount,
    historyDaysAvailable,
    costCoverage,
    pendingSuggestionsRegistered: registered,
    syncedAt: now.toISOString(),
  };
}

export type DailySnapshotResult = {
  snapshotDate: string;
  locationCount: number;
  rowCount: number;
  eventCount: number;
};

/**
 * 后台定时任务用：为店铺全部启用地点抓当日快照，并把相对上一快照日的可售变化
 * 追写进 InventoryEvent。只读 Shopify，不改库存、不重建销量。
 */
export async function captureDailySnapshots(
  admin: AdminApiContext,
  shop: string,
  triggeredBy: SyncTrigger = "cron",
): Promise<DailySnapshotResult> {
  return withSyncJob(
    { shop, jobType: "inventory-snapshot", triggeredBy },
    async () => {
      const result = await runDailySnapshots(admin, shop, triggeredBy);
      return { result, recordsProcessed: result.rowCount };
    },
  );
}

async function runDailySnapshots(
  admin: AdminApiContext,
  shop: string,
  triggeredBy: SyncTrigger,
): Promise<DailySnapshotResult> {
  const now = new Date();
  const [locations, shopData] = await Promise.all([
    fetchInventoryLocations(admin),
    adminGraphql<{ shop: { ianaTimezone: string } }>(
      admin,
      SHOP_SETTINGS_QUERY,
    ),
  ]);
  const snapshotDate = formatDateInTimeZone(now, shopData.shop.ianaTimezone);
  const locationIds = locations.map(({ id }) => id);

  await syncLocations(shop, locations, now);

  if (locationIds.length === 0) {
    return { snapshotDate, locationCount: 0, rowCount: 0, eventCount: 0 };
  }

  const rows = await fetchInventory(
    admin,
    shop,
    locationIds,
    snapshotDate,
    now,
  );

  // 上一快照日：拿它同一批地点/变体的可售值作差，得出当日变化事件。
  const priorDay = await db.inventorySnapshot.findFirst({
    where: { shop, snapshotDate: { lt: snapshotDate } },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  const priorAvailable = new Map<string, number>();
  if (priorDay) {
    const priors = await db.inventorySnapshot.findMany({
      where: { shop, snapshotDate: priorDay.snapshotDate },
      select: { locationId: true, variantId: true, available: true },
    });
    for (const prior of priors) {
      priorAvailable.set(
        `${prior.locationId}|${prior.variantId}`,
        prior.available,
      );
    }
  }

  const events = rows.flatMap((row) => {
    if (!row.tracked) return [];
    const before = priorAvailable.get(`${row.locationId}|${row.variantId}`);
    if (before === undefined || before === row.available) return [];
    return [
      {
        shop,
        locationId: row.locationId,
        variantId: row.variantId,
        changeType: "available-delta",
        delta: row.available - before,
        availableAfter: row.available,
        source: triggeredBy,
        externalId: `${snapshotDate}:${row.locationId}:${row.variantId}`,
        occurredAt: now,
        createdAt: now,
      },
    ];
  });

  await withTransaction(async (transaction) => {
    await persistSnapshotRows(transaction, rows);
    for (const batch of chunk(events, 500)) {
      await transaction.inventoryEvent.createMany({ data: batch });
    }
  });

  // 快照落库后重排一次主地点的待办建议，cron 与 webhook 两条链路都不会漏下 Pending 行。
  await registerReorderSuggestions(shop, now);

  return {
    snapshotDate,
    locationCount: locationIds.length,
    rowCount: rows.length,
    eventCount: events.length,
  };
}

export type SalesRefreshResult = {
  orderCount: number;
  salesRowCount: number;
  historyDaysAvailable: number;
};

/**
 * 后台定时任务用：按权限窗口（有 read_all_orders 则 90 天，否则 60 天）
 * 整窗重建日销量，并刷新 settings.lastSalesSyncAt。不碰快照。
 */
export async function refreshSalesWindow(
  admin: AdminApiContext,
  shop: string,
  canReadAllOrders: boolean,
  triggeredBy: SyncTrigger = "cron",
): Promise<SalesRefreshResult> {
  return withSyncJob(
    { shop, jobType: "sales-daily", triggeredBy },
    async () => {
      const result = await runSalesRefresh(admin, shop, canReadAllOrders);
      return { result, recordsProcessed: result.salesRowCount };
    },
  );
}

async function runSalesRefresh(
  admin: AdminApiContext,
  shop: string,
  canReadAllOrders: boolean,
): Promise<SalesRefreshResult> {
  const now = new Date();
  const shopData = await adminGraphql<{ shop: { ianaTimezone: string } }>(
    admin,
    SHOP_SETTINGS_QUERY,
  );
  const timeZone = shopData.shop.ianaTimezone;
  const today = formatDateInTimeZone(now, timeZone);
  const historyDaysAvailable = canReadAllOrders ? 90 : 60;
  const startDate = shiftDate(today, -(historyDaysAvailable - 1));
  const { salesRows, orderCount } = await fetchSales(
    admin,
    shop,
    startDate,
    timeZone,
  );

  await withTransaction(async (transaction) => {
    // 与手动同步同一口径：只在真读到行时按窗口重建，空读保留上一版需求，
    // 删除范围限定 startDate 之后，窗口外历史保留。
    if (salesRows.length > 0) {
      await transaction.salesDaily.deleteMany({
        where: { shop, date: { gte: startDate } },
      });
      for (const batch of chunk(salesRows, 500)) {
        await transaction.salesDaily.createMany({ data: batch });
      }
    }
    await transaction.inventorySettings.updateMany({
      where: { shop },
      data: {
        lastSalesSyncAt: now,
        salesHistoryComplete: canReadAllOrders,
      },
    });
  });

  return { orderCount, salesRowCount: salesRows.length, historyDaysAvailable };
}

/**
 * webhook 增量入口：只重算某一个地点的当日快照，并把与库里当前值不同的可售变化追写进事件流。
 * 数值一律从 Admin API 重读， payload 只用作「哪个地点变了」的失效信号，所以 webhook 重试天然幂等。
 */
export async function refreshLocationSnapshot(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  triggeredBy: SyncTrigger = "webhook",
): Promise<DailySnapshotResult> {
  return withSyncJob(
    { shop, jobType: "inventory-snapshot", triggeredBy },
    async () => {
      const result = await runRefreshLocationSnapshot(
        admin,
        shop,
        locationId,
        triggeredBy,
      );
      return { result, recordsProcessed: result.rowCount };
    },
  );
}

async function runRefreshLocationSnapshot(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  triggeredBy: SyncTrigger,
): Promise<DailySnapshotResult> {
  const now = new Date();
  const shopData = await adminGraphql<{ shop: { ianaTimezone: string } }>(
    admin,
    SHOP_SETTINGS_QUERY,
  );
  const snapshotDate = formatDateInTimeZone(now, shopData.shop.ianaTimezone);
  const rows = await fetchInventory(
    admin,
    shop,
    [locationId],
    snapshotDate,
    now,
  );

  // 事件用库里已有值作差，而不是拿上一快照日：同一天内的多次 webhook 也能留下真实轨迹。
  const priors = await db.inventorySnapshot.findMany({
    where: { shop, locationId, snapshotDate },
    select: { variantId: true, available: true },
  });
  const priorAvailable = new Map(
    priors.map((prior) => [prior.variantId, prior.available]),
  );

  const events = rows.flatMap((row) => {
    if (!row.tracked) return [];
    const before = priorAvailable.get(row.variantId);
    if (before === undefined || before === row.available) return [];
    return [
      {
        shop,
        locationId: row.locationId,
        variantId: row.variantId,
        changeType: "available-delta",
        delta: row.available - before,
        availableAfter: row.available,
        source: triggeredBy,
        externalId: `${snapshotDate}:${locationId}:${row.variantId}`,
        occurredAt: now,
        createdAt: now,
      },
    ];
  });

  await withTransaction(async (transaction) => {
    await persistSnapshotRows(transaction, rows);
    for (const batch of chunk(events, 500)) {
      await transaction.inventoryEvent.createMany({ data: batch });
    }
  });

  // 快照落库后重排一次主地点的待办建议，cron 与 webhook 两条链路都不会漏下 Pending 行。
  await registerReorderSuggestions(shop, now);

  return {
    snapshotDate,
    locationCount: 1,
    rowCount: rows.length,
    eventCount: events.length,
  };
}

export type OrderDaySyncResult = {
  salesDate: string | null;
  salesRowCount: number;
};

/**
 * webhook 增量入口：按订单 GID 重读一张单，定位它在店铺时区下归属的销售日，
 * 然后整日重算该日销量（先删后建），因此 create/cancel/重试都得到同一结果。
 * 单日重算而不只加减该单，是为了避开「创建时未计入、取消时扣减」把销量算负的问题。
 */
export async function syncOrderDay(
  admin: AdminApiContext,
  shop: string,
  orderId: string,
  canReadAllOrders: boolean,
  triggeredBy: SyncTrigger = "webhook",
): Promise<OrderDaySyncResult> {
  return withSyncJob(
    { shop, jobType: "sales-daily", triggeredBy, cursor: orderId },
    async () => {
      const result = await runSyncOrderDay(
        admin,
        shop,
        orderId,
        canReadAllOrders,
      );
      return { result, recordsProcessed: result.salesRowCount };
    },
  );
}

async function runSyncOrderDay(
  admin: AdminApiContext,
  shop: string,
  orderId: string,
  canReadAllOrders: boolean,
): Promise<OrderDaySyncResult> {
  const now = new Date();
  const [shopData, orderData] = await Promise.all([
    adminGraphql<{ shop: { ianaTimezone: string } }>(
      admin,
      SHOP_SETTINGS_QUERY,
    ),
    adminGraphql<{ order: OrderNode | null }>(admin, ORDER_BY_ID_QUERY, {
      variables: { id: orderId },
    }),
  ]);

  const timeZone = shopData.shop.ianaTimezone;
  const order = orderData.order;
  if (!order) {
    return { salesDate: null, salesRowCount: 0 };
  }

  const today = formatDateInTimeZone(now, timeZone);
  const salesDate = formatDateInTimeZone(new Date(order.processedAt), timeZone);
  const historyDaysAvailable = canReadAllOrders ? 90 : 60;
  const windowStart = shiftDate(today, -(historyDaysAvailable - 1));

  // 超出权限窗口或属于未来日期的单子读不全，整日重算会误删当天数据，直接跳过。
  if (salesDate > today || salesDate < windowStart) {
    return { salesDate, salesRowCount: 0 };
  }

  const { salesRows } = await fetchSales(
    admin,
    shop,
    salesDate,
    timeZone,
    shiftDate(salesDate, 1),
  );

  await withTransaction(async (transaction) => {
    await transaction.salesDaily.deleteMany({
      where: { shop, date: salesDate },
    });
    for (const batch of chunk(salesRows, 500)) {
      await transaction.salesDaily.createMany({ data: batch });
    }
    await transaction.inventorySettings.updateMany({
      where: { shop },
      data: { lastSalesSyncAt: now },
    });
  });

  return { salesDate, salesRowCount: salesRows.length };
}

/**
 * 分页读取 active 变体在给定地点集合内的可售/在途/在手库存和尽力读取的单位成本，
 * 每个 (变体, 地点) 吐一行；变体未关联某地点时计作 0，保证看板覆盖全部地点。
 */
async function fetchInventory(
  admin: AdminApiContext,
  shop: string,
  locationIds: string[],
  snapshotDate: string,
  capturedAt: Date,
): Promise<InventoryRow[]> {
  const rows: InventoryRow[] = [];
  let after: string | null = null;

  do {
    const data: VariantsPayload = await adminGraphql<VariantsPayload>(
      admin,
      VARIANTS_QUERY,
      {
        variables: { after },
        allowUnitCostAccessError: true,
      },
    );

    for (const variant of data.productVariants.nodes) {
      if (variant.product.status !== "ACTIVE") continue;
      const item = variant.inventoryItem;
      if (item?.inventoryLevels.pageInfo.hasNextPage) {
        throw new AppError(
          "validation",
          "Some products are linked to more than 250 inventory locations, which the current sync can't read safely. Please contact support.",
        );
      }
      const levelsByLocation = new Map(
        (item?.inventoryLevels.nodes ?? []).map((level) => [
          level.location.id,
          level,
        ]),
      );
      const unitCostAmount = item?.unitCost?.amount;
      const unitCost =
        unitCostAmount === undefined || unitCostAmount === null
          ? null
          : Number(unitCostAmount);

      for (const locationId of locationIds) {
        const level = levelsByLocation.get(locationId);
        const quantities = new Map(
          (level?.quantities ?? []).map(({ name, quantity }) => [
            name,
            quantity,
          ]),
        );

        rows.push({
          id: `${shop}:${locationId}:${variant.id}:${snapshotDate}`,
          shop,
          locationId,
          variantId: variant.id,
          snapshotDate,
          productId: variant.product.id,
          productTitle: variant.product.title,
          variantTitle: variant.title,
          sku: variant.sku,
          tracked: item?.tracked ?? false,
          available: item?.tracked ? (quantities.get("available") ?? 0) : 0,
          incoming: item?.tracked ? (quantities.get("incoming") ?? 0) : 0,
          onHand: item?.tracked ? (quantities.get("on_hand") ?? null) : null,
          unitCost:
            unitCost !== null && Number.isFinite(unitCost) ? unitCost : null,
          capturedAt,
        });
      }
    }
    after = data.productVariants.pageInfo.hasNextPage
      ? data.productVariants.pageInfo.endCursor
      : null;
  } while (after);

  return rows;
}

/**
 * 把快照行按日 upsert：同日重算覆盖数值，历史日期原样保留。
 * 分片提交，避开单事务语句数过大。
 */
async function persistSnapshotRows(
  transaction: Prisma.TransactionClient,
  rows: InventoryRow[],
): Promise<void> {
  for (const batch of chunk(rows, 200)) {
    await Promise.all(
      batch.map((row) =>
        transaction.inventorySnapshot.upsert({
          where: {
            shop_locationId_variantId_snapshotDate: {
              shop: row.shop,
              locationId: row.locationId,
              variantId: row.variantId,
              snapshotDate: row.snapshotDate,
            },
          },
          create: row,
          update: {
            productId: row.productId,
            productTitle: row.productTitle,
            variantTitle: row.variantTitle,
            sku: row.sku,
            tracked: row.tracked,
            available: row.available,
            incoming: row.incoming,
            onHand: row.onHand,
            unitCost: row.unitCost,
            capturedAt: row.capturedAt,
          },
        }),
      ),
    );
  }
}

/**
 * 分页拉取 processedAt 落在窗口内、未取消且已支付/部分退款/已退款的订单行，
 * 按店铺时区汇总为每日销量。退货数量不扣减。
 * 传入 endDateExclusive 时只统计 [startDate, endDateExclusive) 单日，供 webhook 增量重算使用。
 */
async function fetchSales(
  admin: AdminApiContext,
  shop: string,
  startDate: string,
  timeZone: string,
  endDateExclusive?: string,
): Promise<{
  salesRows: Array<{
    id: string;
    shop: string;
    variantId: string;
    date: string;
    quantity: number;
  }>;
  orderCount: number;
}> {
  const quantities = new Map<string, number>();
  const searchQuery = endDateExclusive
    ? `processed_at:>=${startDate} processed_at:<${endDateExclusive}`
    : `processed_at:>=${startDate}`;
  let after: string | null = null;
  let orderCount = 0;

  do {
    const data: OrdersPayload = await adminGraphql<OrdersPayload>(
      admin,
      ORDERS_QUERY,
      { variables: { after, query: searchQuery } },
    );

    for (const order of data.orders.nodes) {
      if (order.cancelledAt) continue;
      if (
        !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
          order.displayFinancialStatus ?? "",
        )
      ) {
        continue;
      }
      if (order.lineItems.pageInfo.hasNextPage) {
        throw new AppError(
          "validation",
          "An order contains more than 250 line items, which the current sync can't fully account for when calculating sales.",
        );
      }
      orderCount += 1;
      const salesDate = formatDateInTimeZone(
        new Date(order.processedAt),
        timeZone,
      );
      for (const lineItem of order.lineItems.nodes) {
        if (!lineItem.variant) continue;
        const key = `${lineItem.variant.id}|${salesDate}`;
        quantities.set(key, (quantities.get(key) ?? 0) + lineItem.quantity);
      }
    }
    after = data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null;
  } while (after);

  const salesRows = Array.from(quantities, ([key, quantity]) => {
    const separator = key.lastIndexOf("|");
    const variantId = key.slice(0, separator);
    const date = key.slice(separator + 1);
    return {
      id: `${shop}:${variantId}:${date}`,
      shop,
      variantId,
      date,
      quantity,
    };
  });

  return { salesRows, orderCount };
}

/** 用库中快照、日销量和补货决策组装看板，并调用确定性公式计算每个变体的健康指标。 */
export async function getInventoryDashboard(
  shop: string,
  locations: InventoryLocation[],
  canReadAllOrders: boolean,
  now = new Date(),
): Promise<InventoryDashboard> {
  const [settingsRow, offlineSession, snapshotFailures, salesFailures] =
    await Promise.all([
      db.inventorySettings.findUnique({ where: { shop } }),
      db.session.findFirst({
        where: { shop, isOnline: false },
        select: { id: true },
      }),
      consecutiveFailures(shop, "inventory-snapshot"),
      consecutiveFailures(shop, "sales-daily"),
    ]);

  const settings = settingsRow ? toDashboardSettings(settingsRow) : null;
  const timezone = settingsRow?.timezone ?? "UTC";
  const today = formatDateInTimeZone(now, timezone);
  const historyDaysAvailable = canReadAllOrders ? 90 : 60;
  const assessment = {
    offlineSession,
    settings,
    snapshotFailures,
    salesFailures,
    today,
    now,
  };

  const newest = settings?.locationId
    ? await db.inventorySnapshot.findFirst({
        where: { shop, locationId: settings.locationId },
        orderBy: { snapshotDate: "desc" },
        select: { snapshotDate: true, capturedAt: true },
      })
    : null;

  const trackedRows =
    newest && settings?.locationId
      ? await db.inventorySnapshot.count({
          where: {
            shop,
            locationId: settings.locationId,
            snapshotDate: newest.snapshotDate,
            tracked: true,
          },
        })
      : 0;

  // 成本覆盖率只有在读到快照行之后才算得出来，所以健康判定统一推迟到取数完成后一次性评估。
  if (!settings?.locationId || !newest) {
    const dataHealth = evaluateDataHealth(
      healthInput(assessment, {
        newestSnapshotDate: newest?.snapshotDate ?? null,
        snapshotCapturedAt: newest?.capturedAt ?? null,
        trackedVariantCount: trackedRows,
        costCoverage: null,
      }),
    );
    return {
      settings,
      locations,
      metrics: emptyMetrics(),
      variants: [],
      dataHealth,
      historyDaysAvailable,
      snapshotDate: newest?.snapshotDate ?? null,
      board: summarizeBoard([]),
    };
  }

  // 看板只看最新快照日：快照表已是每日时间序列，历史行不参与当期健康度计算。
  const [inventory, sales, savedRecommendations, supplyTermsByVariant] =
    await Promise.all([
      db.inventorySnapshot.findMany({
        where: {
          shop,
          locationId: settings.locationId,
          tracked: true,
          snapshotDate: newest.snapshotDate,
        },
        orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
      }),
      db.salesDaily.findMany({
        where: { shop, date: { gte: shiftDate(today, -89), lte: today } },
      }),
      db.reorderRecommendation.findMany({
        where: { shop, locationId: settings.locationId },
      }),
      loadSupplyTermsMap(shop),
    ]);

  const dataHealth = evaluateDataHealth(
    healthInput(assessment, {
      newestSnapshotDate: newest.snapshotDate,
      snapshotCapturedAt: newest.capturedAt,
      trackedVariantCount: trackedRows,
      costCoverage: costCoverageOf(inventory),
    }),
  );

  const recommendationsByVariant = new Map(
    savedRecommendations.map((recommendation) => [
      recommendation.variantId,
      recommendation,
    ]),
  );
  const salesByVariant = groupSalesByVariant(sales);
  const variants = buildVariantPlans({
    settings,
    rows: inventory,
    salesByVariant,
    recommendationsByVariant,
    supplyTermsByVariant,
    snapshotAgeHours: dataHealth.snapshotAgeHours,
    historyDaysAvailable,
    dataPaused: dataHealth.paused,
    today,
  });

  const metrics = variants.reduce((result, variant) => {
    result.totalSkus += 1;
    result.availableStock += variant.available;
    if (variant.status === "low_stock") result.lowStock += 1;
    if (["stockout", "critical", "stockout_risk"].includes(variant.status)) {
      result.atRisk += 1;
    }
    if (variant.status === "overstock") result.overstock += 1;
    if (variant.status === "dead_stock") result.deadStock += 1;
    if (variant.inventoryValue === null) {
      result.variantsMissingCost += 1;
    } else {
      result.inventoryValue += variant.inventoryValue;
    }
    return result;
  }, emptyMetrics());

  return {
    settings,
    locations,
    metrics,
    variants,
    dataHealth,
    historyDaysAvailable,
    snapshotDate: newest.snapshotDate,
    board: summarizeBoard(variants.map((variant) => variant.actionState)),
  };
}

/** 算健康检查所需的店铺级事实，与最新快照无关的部分只组装一次。 */
function healthInput(
  assessment: {
    offlineSession: { id: string } | null;
    settings: DashboardSettings | null;
    snapshotFailures: number;
    salesFailures: number;
    today: string;
    now: Date;
  },
  snapshot: {
    newestSnapshotDate: string | null;
    snapshotCapturedAt: Date | null;
    trackedVariantCount: number;
    costCoverage: number | null;
  },
): DataHealthInput {
  return {
    hasOfflineSession: Boolean(assessment.offlineSession),
    locationName: assessment.settings?.locationName ?? null,
    newestSnapshotDate: snapshot.newestSnapshotDate,
    snapshotCapturedAt: snapshot.snapshotCapturedAt,
    trackedVariantCount: snapshot.trackedVariantCount,
    lastInventorySyncAt: assessment.settings?.lastInventorySyncAt ?? null,
    lastSalesSyncAt: assessment.settings?.lastSalesSyncAt ?? null,
    salesHistoryComplete: assessment.settings?.salesHistoryComplete ?? false,
    consecutiveFailures: Math.max(
      assessment.snapshotFailures,
      assessment.salesFailures,
    ),
    costCoverage: snapshot.costCoverage,
    today: assessment.today,
    now: assessment.now,
  };
}

/** 能读到单位成本的变体占比；一行都没有时返回 null，让检查项显示「还没读过」。 */
function costCoverageOf(
  rows: Array<{ unitCost: number | null }>,
): number | null {
  if (rows.length === 0) return null;
  return rows.filter((row) => row.unitCost !== null).length / rows.length;
}

/** 只保留 dashboard 需要的设置字段，避免把 shop/updatedAt 之类的行结构泄给前端。 */
function toDashboardSettings(
  row: Prisma.InventorySettingsGetPayload<object>,
): DashboardSettings {
  return {
    locationId: row.locationId,
    locationName: row.locationName,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
    leadTimeDays: row.leadTimeDays,
    safetyStockDays: row.safetyStockDays,
    reviewPeriodDays: row.reviewPeriodDays,
    lastInventorySyncAt: row.lastInventorySyncAt,
    lastSalesSyncAt: row.lastSalesSyncAt,
    salesHistoryComplete: row.salesHistoryComplete,
    salesWindowStart: row.salesWindowStart,
    replenishmentSettingsSavedAt: row.replenishmentSettingsSavedAt,
  };
}

function groupSalesByVariant(
  sales: Array<{ variantId: string; date: string; quantity: number }>,
): Map<string, Map<string, number>> {
  const salesByVariant = new Map<string, Map<string, number>>();
  for (const sale of sales) {
    const byDate =
      salesByVariant.get(sale.variantId) ?? new Map<string, number>();
    byDate.set(sale.date, sale.quantity);
    salesByVariant.set(sale.variantId, byDate);
  }
  return salesByVariant;
}

/**
 * 装载本店生效的供货条款：变体 → 供应商 MOQ / case pack / 交期。
 * 只纳入未停用的供应商 —— 停用即让已绑定的变体安静地回到店铺默认口径，
 * 档案与绑定保留，重新启用后取整口径原样恢复。
 */
async function loadSupplyTermsMap(
  shop: string,
): Promise<Map<string, VariantSupplyTerms>> {
  const bindings = await db.variantSupplier.findMany({
    where: { shop, supplier: { isActive: true } },
    select: {
      variantId: true,
      minOrderQuantity: true,
      casePack: true,
      supplier: { select: { name: true, leadTimeDays: true } },
    },
  });
  return new Map(
    bindings.map((binding) => [
      binding.variantId,
      {
        supplierName: binding.supplier.name,
        leadTimeDays: binding.supplier.leadTimeDays,
        minOrderQuantity: binding.minOrderQuantity,
        casePack: binding.casePack,
      },
    ]),
  );
}

function summarizeBoard(
  states: (ActionBoardState | null)[],
): ActionBoardSummary {
  const counts = summarizeActionBoard(states);
  return { counts, adoption: calculateAdoptionMetrics(counts) };
}

/** 快照行里做补货计算需要的字段。 */
type SnapshotPlanRow = {
  id: string;
  locationId: string;
  variantId: string;
  snapshotDate: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  available: number;
  incoming: number;
  unitCost: number | null;
};

type VariantPlanInput = {
  settings: DashboardSettings;
  rows: SnapshotPlanRow[];
  salesByVariant: Map<string, Map<string, number>>;
  recommendationsByVariant: Map<
    string,
    {
      status: string;
      suggestedQuantity: number;
      quantity: number;
      confidence: string;
      computedAt: Date;
      decisionReason: string | null;
    }
  >;
  /** 变体绑定的生效供货条款（MOQ / case pack / 供应商交期）；无绑定的行按店铺口径。 */
  supplyTermsByVariant: Map<string, VariantSupplyTerms>;
  snapshotAgeHours: number | null;
  historyDaysAvailable: number;
  dataPaused: boolean;
  today: string;
};

/**
 * 把快照行 + 日销量 + 商家已有决策折算成看板行：Observed Demand、补货公式、置信度与六态。
 * 纯函数不碰数据库，同步入口与看板读取共用同一套算法，保证两边数字永远一致。
 */
function buildVariantPlans(input: VariantPlanInput): DashboardVariant[] {
  const { settings, today } = input;
  const demandWindowStart = shiftDate(today, -(DEFAULT_DEMAND_WINDOW_DAYS - 1));
  // 可见样本起点：取「窗口起点」与「当前授权可读起点」里更晚的那个，读不到的天数不计入分母。
  const visibleStart =
    settings.salesWindowStart && settings.salesWindowStart > demandWindowStart
      ? settings.salesWindowStart
      : demandWindowStart;
  const sampleDaysAvailable = countDaysInclusive(visibleStart, today);

  return input.rows.map((row) => {
    const byDate = input.salesByVariant.get(row.variantId) ?? new Map();
    const sales30Days = sumSince(byDate, demandWindowStart, today);
    const sales60Days = sumSince(byDate, shiftDate(today, -59), today);
    const sales90Days = settings.salesHistoryComplete
      ? sumSince(byDate, shiftDate(today, -89), today)
      : null;
    const daysWithSales = countDaysWithSales(byDate, demandWindowStart, today);

    const health = calculateInventoryHealth({
      available: row.available,
      incoming: row.incoming,
      unitCost: row.unitCost,
      sales30Days,
      sales60Days,
      sales90Days,
      leadTimeDays: settings.leadTimeDays,
      safetyStockDays: settings.safetyStockDays,
      reviewPeriodDays: settings.reviewPeriodDays,
      today,
      demandWindowDays: DEFAULT_DEMAND_WINDOW_DAYS,
      sampleDaysAvailable,
      daysWithSales,
      supplyTerms: input.supplyTermsByVariant.get(row.variantId) ?? null,
    });

    const confidence = calculateReorderConfidence({
      snapshotAgeHours: input.snapshotAgeHours,
      observedDemand: health.observedDemand,
      historyDaysAvailable: input.historyDaysAvailable,
      unitCostMissing: row.unitCost === null,
      dataPaused: input.dataPaused,
    });

    const savedRecommendation = input.recommendationsByVariant.get(
      row.variantId,
    );
    let recommendation: SavedRecommendation | null = null;
    if (savedRecommendation) {
      if (!isReorderDecisionStatus(savedRecommendation.status)) {
        throw new AppError(
          "validation",
          "An invalid reorder recommendation status was found. Please contact support.",
        );
      }
      recommendation = {
        status: savedRecommendation.status,
        suggestedQuantity: savedRecommendation.suggestedQuantity,
        quantity: savedRecommendation.quantity,
        needsReview:
          savedRecommendation.suggestedQuantity !==
          health.suggestedReorderQuantity,
        confidence: isReorderConfidenceLevel(savedRecommendation.confidence)
          ? savedRecommendation.confidence
          : "medium",
        computedAt: savedRecommendation.computedAt,
        decisionReason: savedRecommendation.decisionReason,
      };
    }

    return {
      ...health,
      id: row.id,
      variantId: row.variantId,
      productId: row.productId,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      sku: row.sku,
      snapshotDate: row.snapshotDate,
      confidence,
      recommendation,
      actionState: resolveActionBoardState({
        hasLiveSuggestion: health.suggestedReorderQuantity > 0,
        status: recommendation?.status ?? null,
        needsReview: recommendation?.needsReview ?? false,
        paused: input.dataPaused,
      }),
    };
  });
}

/** 把某变体在 [start, end] 闭区间内的日销量加总。 */
function sumSince(
  sales: Map<string, number>,
  start: string,
  end: string,
): number {
  let sum = 0;
  for (const [date, quantity] of sales) {
    if (date >= start && date <= end) sum += quantity;
  }
  return sum;
}

/**
 * 数出窗口内真的有销量的天数。销量行只在有订单时写入，所以行数就是天数。
 * 天数占比用来识别「偶尔卖一件」的稀疏需求，避免日均被当成稳定信号。
 */
function countDaysWithSales(
  sales: Map<string, number>,
  start: string,
  end: string,
): number {
  let days = 0;
  for (const [date, quantity] of sales) {
    if (date >= start && date <= end && quantity > 0) days += 1;
  }
  return days;
}

/** 未选地点或尚无数据时的零指标。 */
function emptyMetrics(): InventoryDashboard["metrics"] {
  return {
    totalSkus: 0,
    availableStock: 0,
    lowStock: 0,
    atRisk: 0,
    overstock: 0,
    deadStock: 0,
    inventoryValue: 0,
    variantsMissingCost: 0,
  };
}

/** 把大批插入拆成小批次，避开单次写入语句数/参数数超限。 */
function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

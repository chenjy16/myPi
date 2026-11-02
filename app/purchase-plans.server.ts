/**
 * Purchase Plans 服务端模块：从 accepted/edited 建议生成计划、并量、改量、状态流转。
 * 所有查询都带 shop 谓词（应用可能同时服务多家店），跨店 id 一律视为不存在。
 * 建议决策的复用走 inventory.server 的 saveReorderRecommendation（同一条审计链路），
 * 本模块只负责计划自身的数据。
 */
import db from "./db.server";
import { AppError } from "./lib/app-error";
import {
  AUDIT_OPERATOR_SYSTEM,
  isReorderDecisionStatus,
  type ReorderDecisionStatus,
} from "./lib/reorder-recommendations";
import {
  isReorderConfidenceLevel,
  type ReorderConfidenceLevel,
} from "./lib/reorder-confidence";
import { saveReorderRecommendation } from "./inventory.server";
import {
  buildPlanReference,
  canTransitionPlanStatus,
  groupAdviceBySupplier,
  isPurchasePlanStatus,
  type AdviceDraftLine,
  type PurchasePlanStatus,
} from "./lib/purchase-plans";
import {
  buildPurchasePlanCsv,
  buildPurchasePlanFileName,
  type PurchasePlanExportRow,
} from "./lib/purchase-plan-export";

/** 建议池里可勾选进计划的一行。quantity 是商家确认量，不是系统建议量。 */
export type AdvicePoolEntry = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantity: number;
  suggestedQuantity: number;
  decisionStatus: ReorderDecisionStatus;
  supplierId: string | null;
  supplierName: string | null;
  unitCost: number | null;
};

export type AdvicePool = {
  locationId: string | null;
  entries: AdvicePoolEntry[];
  /** 池为空时给商家一个说得通的原因（而不是假装一切正常）。 */
  notice: string | null;
};

/**
 * 可生成计划的建议池：accepted/edited 且还没被任何 open 计划收走。
 * 展示信息与供应商条款从最新快照日和绑定表取，取不到就退化为「Store default」。
 */
export async function getAdvicePool(shop: string): Promise<AdvicePool> {
  const settings = await db.inventorySettings.findUnique({
    where: { shop },
    select: { locationId: true },
  });
  const locationId = settings?.locationId ?? null;
  if (!locationId) {
    return {
      locationId: null,
      entries: [],
      notice:
        "No inventory location selected yet. Sync in the Replenishment page first; purchase plans build on accepted reorder advice.",
    };
  }

  const recommendations = await db.reorderRecommendation.findMany({
    where: {
      shop,
      locationId,
      status: { in: ["accepted", "edited"] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (recommendations.length === 0) {
    return {
      locationId,
      entries: [],
      notice: null,
    };
  }

  const variantIds = recommendations.map((row) => row.variantId);
  const [latestSnapshot, bindings, plannedRows] = await Promise.all([
    db.inventorySnapshot.findFirst({
      where: { shop, locationId, tracked: true },
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true },
    }),
    db.variantSupplier.findMany({
      where: { shop, variantId: { in: variantIds } },
      include: {
        supplier: { select: { id: true, name: true, isActive: true } },
      },
    }),
    db.purchasePlanLine.findMany({
      where: { shop, variantId: { in: variantIds }, plan: { status: "open" } },
      select: { variantId: true },
    }),
  ]);

  const snapshotRows = latestSnapshot
    ? await db.inventorySnapshot.findMany({
        where: {
          shop,
          locationId,
          snapshotDate: latestSnapshot.snapshotDate,
          variantId: { in: variantIds },
        },
      })
    : [];
  const snapshotByVariant = new Map(
    snapshotRows.map((row) => [row.variantId, row]),
  );
  const bindingByVariant = new Map(
    bindings
      .filter((row) => row.supplier.isActive)
      .map((row) => [row.variantId, row]),
  );
  const alreadyPlanned = new Set(plannedRows.map((row) => row.variantId));

  const entries: AdvicePoolEntry[] = [];
  for (const recommendation of recommendations) {
    if (alreadyPlanned.has(recommendation.variantId)) continue;
    const snapshot = snapshotByVariant.get(recommendation.variantId);
    // 快照行没了（下架/停止跟踪）就别编数据，用建议行自身能确定的信息展示。
    const binding = bindingByVariant.get(recommendation.variantId);
    entries.push({
      variantId: recommendation.variantId,
      productTitle: snapshot?.productTitle ?? "Untracked variant",
      variantTitle: snapshot?.variantTitle ?? recommendation.variantId,
      sku: snapshot?.sku ?? null,
      quantity: recommendation.quantity,
      suggestedQuantity: recommendation.suggestedQuantity,
      decisionStatus: isReorderDecisionStatus(recommendation.status)
        ? recommendation.status
        : "accepted",
      supplierId: binding?.supplierId ?? null,
      supplierName: binding?.supplier.name ?? null,
      unitCost: binding?.unitCost ?? snapshot?.unitCost ?? null,
    });
  }

  return {
    locationId,
    entries,
    notice:
      entries.length === 0
        ? "Every accepted or edited suggestion is already covered by an open plan. Mark that plan ordered (or cancel it) to free the rows up."
        : null,
  };
}

/** 店内最大编号 + 1。编号只增不回收，删掉的计划也不复用旧号，避免对账歧义。 */
async function nextPlanSequence(shop: string): Promise<number> {
  const last = await db.purchasePlan.findFirst({
    where: { shop, reference: { startsWith: "PP-" } },
    orderBy: { reference: "desc" },
    select: { reference: true },
  });
  if (!last) return 1;
  const parsed = Number(last.reference.slice(3));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed + 1 : 1;
}

export type PlanCreateResult = {
  reference: string;
  supplierName: string;
  lineCount: number;
  totalUnits: number;
};

/**
 * 从勾选的建议生成计划：只认服务端重新算出的池（不信任客户端提交的数量与供应商），
 * 按供应商归并成一个或多个计划，同变体重复出现时并量。
 */
export async function createPlansFromAdvice(
  shop: string,
  variantIds: string[],
): Promise<PlanCreateResult[]> {
  if (variantIds.length === 0) {
    throw new AppError("validation", "Select at least one suggestion.");
  }
  const pool = await getAdvicePool(shop);
  if (!pool.locationId) {
    throw new AppError(
      "validation",
      "No inventory location selected yet. Sync in the Replenishment page first.",
    );
  }
  const requested = new Set(variantIds);
  const drafts: AdviceDraftLine[] = pool.entries
    .filter((entry) => requested.has(entry.variantId))
    .map((entry) => ({
      variantId: entry.variantId,
      productTitle: entry.productTitle,
      variantTitle: entry.variantTitle,
      sku: entry.sku,
      quantity: entry.quantity,
      supplierId: entry.supplierId,
      supplierName: entry.supplierName,
      unitCost: entry.unitCost,
    }));
  if (drafts.length === 0) {
    throw new AppError(
      "validation",
      "Those suggestions can't be planned right now — they were already planned, ignored, or the data changed. Refresh and try again.",
    );
  }

  const groups = groupAdviceBySupplier(drafts);
  const results: PlanCreateResult[] = [];
  const supplierNameOf = (group: { supplierName: string | null }) =>
    group.supplierName ?? "Store default";
  // 同一批计划共用一个起始编号；逐计划提交，单个计划头+行在一次 create 里原子落库。
  let sequence = await nextPlanSequence(shop);
  for (const group of groups) {
    const reference = buildPlanReference(sequence);
    sequence += 1;
    const supplierName = supplierNameOf(group);
    const createData = {
      shop,
      reference,
      supplierId: group.supplierId,
      supplierName,
      locationId: pool.locationId,
      lines: {
        create: group.lines.map((line) => ({
          shop,
          variantId: line.variantId,
          productTitle: line.productTitle,
          variantTitle: line.variantTitle,
          sku: line.sku,
          quantity: line.quantity,
          unitCost: line.unitCost,
        })),
      },
    };
    try {
      await db.purchasePlan.create({ data: createData });
    } catch (error) {
      // (shop, reference) 撞唯一约束说明并发里有人抢了号，重取一次再试；其余错误原样上抛。
      const safeError = error instanceof Error ? error : new Error(String(error));
      if (!safeError.message.includes("Unique constraint failed")) throw safeError;
      const freshReference = buildPlanReference(await nextPlanSequence(shop) + 1);
      await db.purchasePlan.create({
        data: { ...createData, reference: freshReference },
      });
      results.push({
        reference: freshReference,
        supplierName,
        lineCount: group.lines.length,
        totalUnits: group.lines.reduce((sum, line) => sum + line.quantity, 0),
      });
      continue;
    }
    results.push({
      reference,
      supplierName,
      lineCount: group.lines.length,
      totalUnits: group.lines.reduce((sum, line) => sum + line.quantity, 0),
    });
  }
  return results;
}

/** 计划列表（带明细），最新在前；50 份封顶，Beta 阶段够用，分页等真实需求出现再做。 */
export async function listPurchasePlans(shop: string) {
  return db.purchasePlan.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      lines: { orderBy: { createdAt: "asc" } },
    },
  });
}

/** 按 id 取本店计划；跨店或不存在都给同一句可行动的拒绝。 */
async function getOwnedPlan(shop: string, planId: string) {
  const plan = await db.purchasePlan.findFirst({
    where: { shop, id: planId },
    include: { lines: true },
  });
  if (!plan) {
    throw new AppError(
      "validation",
      "This plan no longer exists. Refresh the page and try again.",
    );
  }
  return plan;
}

/** open 之外的计划是已定账目，不能再改明细；给出商家听得懂的下一步。 */
function assertPlanOpen(
  plan: { status: string },
  action: string,
): void {
  if (isPurchasePlanStatus(plan.status) && plan.status === "open") return;
  throw new AppError(
    "validation",
    `This plan is ${plan.status === "ordered" ? "already ordered" : "cancelled"}, so it can't be ${action}. Create a new plan from the suggestions instead.`,
  );
}

/** 改计划行数量（商家压价、凑箱等场景）。 */
export async function updatePlanLineQuantity(
  shop: string,
  planId: string,
  lineId: string,
  quantity: number,
): Promise<void> {
  const plan = await getOwnedPlan(shop, planId);
  assertPlanOpen(plan, "edited");
  const line = plan.lines.find(
    (row) => row.id === lineId && row.shop === shop,
  );
  if (!line) {
    throw new AppError(
      "validation",
      "That line isn't part of this plan anymore. Refresh and try again.",
    );
  }
  await db.purchasePlanLine.update({
    where: { id: line.id },
    data: { quantity },
  });
}

/** 从计划里移除一行（留在建议池里，之后还能再选）。 */
export async function removePlanLine(
  shop: string,
  planId: string,
  lineId: string,
): Promise<void> {
  const plan = await getOwnedPlan(shop, planId);
  assertPlanOpen(plan, "edited");
  const line = plan.lines.find(
    (row) => row.id === lineId && row.shop === shop,
  );
  if (!line) {
    throw new AppError(
      "validation",
      "That line isn't part of this plan anymore. Refresh and try again.",
    );
  }
  await db.purchasePlanLine.delete({ where: { id: line.id } });
}

/** 采购日期与备注（计划级）。日期为 null 表示清空。 */
export async function updatePlanMeta(
  shop: string,
  planId: string,
  meta: { purchaseDate: string | null; notes: string | null },
): Promise<void> {
  const plan = await getOwnedPlan(shop, planId);
  assertPlanOpen(plan, "edited");
  await db.purchasePlan.update({
    where: { id: plan.id },
    data: { purchaseDate: meta.purchaseDate, notes: meta.notes },
  });
}

/** 计划状态流转的唯一入口：非法流转（open 之外再动、终态互转）直接拒。 */
async function transitionPlan(
  shop: string,
  planId: string,
  to: PurchasePlanStatus,
): Promise<Awaited<ReturnType<typeof getOwnedPlan>>> {
  const plan = await getOwnedPlan(shop, planId);
  if (
    !isPurchasePlanStatus(plan.status) ||
    !canTransitionPlanStatus(plan.status, to)
  ) {
    throw new AppError(
      "validation",
      `This plan is already ${plan.status === "ordered" ? "ordered" : "cancelled"} — status can't change again. Adjust quantities in a new plan if the order changed.`,
    );
  }
  return plan;
}

/**
 * 标记已下采购单：计划 open → ordered，同时把每条行对应的建议决策同步为 ordered
 * （沿用 saveReorderRecommendation，和 Replenishment 页逐行 Mark ordered 走同一条审计链路）。
 * 建议已被后续同步刷成 pending 或行消失时跳过，不为此失败整笔操作。
 */
export async function markPlanOrdered(
  shop: string,
  planId: string,
): Promise<{ reference: string; synced: number; skipped: number }> {
  const plan = await transitionPlan(shop, planId, "ordered");
  await db.purchasePlan.update({
    where: { id: plan.id },
    data: { status: "ordered", orderedAt: new Date() },
  });

  let synced = 0;
  let skipped = 0;
  for (const line of plan.lines) {
    try {
      const recommendation = await db.reorderRecommendation.findUnique({
        where: {
          shop_locationId_variantId: {
            shop,
            locationId: plan.locationId,
            variantId: line.variantId,
          },
        },
      });
      if (
        !recommendation ||
        !isReorderDecisionStatus(recommendation.status) ||
        recommendation.status === "ordered" ||
        recommendation.status === "ignored"
      ) {
        skipped += 1;
        continue;
      }
      const confidence: ReorderConfidenceLevel = isReorderConfidenceLevel(
        recommendation.confidence,
      )
        ? recommendation.confidence
        : "medium";
      await saveReorderRecommendation({
        shop,
        locationId: plan.locationId,
        variantId: line.variantId,
        suggestedQuantity: recommendation.suggestedQuantity,
        // 回写计划里的真实下单量（可能在计划行被改过），而不是旧建议数量，
        // 否则 Replenishment / Recent decisions 会与计划对不上。
        quantity: line.quantity,
        status: "ordered",
        confidence,
        demandWindowDays: recommendation.demandWindowDays,
        demandPerDay: recommendation.demandPerDay,
        demandSampleDays: recommendation.demandSampleDays,
        // 这条 ordered 是「标记计划下单」时代系统自动同步的，不是商家在建议行上点的，
        // 所以 operator 记为 system，避免审计里把系统流转误读成商家手工决策。
        operator: AUDIT_OPERATOR_SYSTEM,
      });
      synced += 1;
    } catch {
      // 单行同步失败不拖垮整笔流转：计划状态已改，行数据仍在审计里可查。
      skipped += 1;
    }
  }
  return { reference: plan.reference, synced, skipped };
}

/** 作废计划：open → cancelled。建议决策保持不变，行会重新回到建议池。 */
export async function cancelPlan(
  shop: string,
  planId: string,
): Promise<{ reference: string }> {
  const plan = await transitionPlan(shop, planId, "cancelled");
  await db.purchasePlan.update({
    where: { id: plan.id },
    data: { status: "cancelled" },
  });
  // 说明：cancel 只作废计划本身。建议行因 status 仍是 accepted/edited 且不再被
  // open 计划占用，会重新出现在建议池里，商家可以再次规划——这正是想要的回退。
  return { reference: plan.reference };
}

/** 组装采购计划 CSV。planId 省略时导出全部计划；金额列没有成本就留空，不编数。 */
export async function buildPurchasePlanExport(
  shop: string,
  planId?: string,
): Promise<{ fileName: string; csv: string; rowCount: number }> {
  const [settings, plans] = await Promise.all([
    db.inventorySettings.findUnique({
      where: { shop },
      select: { currencyCode: true },
    }),
    planId
      ? db.purchasePlan.findMany({
          where: { shop, id: planId },
          include: { lines: { orderBy: { createdAt: "asc" } } },
        })
      : db.purchasePlan.findMany({
          where: { shop },
          orderBy: { createdAt: "desc" },
          include: { lines: { orderBy: { createdAt: "asc" } } },
        }),
  ]);
  const currencyCode = settings?.currencyCode ?? "USD";

  const rows: PurchasePlanExportRow[] = [];
  for (const plan of plans) {
    for (const line of plan.lines) {
      rows.push({
        reference: plan.reference,
        planStatus: plan.status,
        supplierName: plan.supplierName ?? "Store default",
        productTitle: line.productTitle,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        unitCost: line.unitCost,
        lineValue:
          line.unitCost === null ? null : line.quantity * line.unitCost,
        currencyCode,
        purchaseDate: plan.purchaseDate,
        planNotes: plan.notes,
        createdAt: plan.createdAt.toISOString(),
      });
    }
  }

  const fileName = buildPurchasePlanFileName(
    new Date().toISOString().slice(0, 10),
    plans.length === 1 && planId ? plans[0]?.reference : undefined,
  );
  return { fileName, csv: buildPurchasePlanCsv(rows), rowCount: rows.length };
}

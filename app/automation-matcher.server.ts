// 自动化匹配器（P2-02）：按店铺 + trigger 类型找 active 自动化，并带出其当前编译版本。
// 多租户铁律：两段查询都必带 shopId（Automation 走 (shopId,status) 索引；AutomationVersion
// 无 shop 列，用本店已知的 currentVersionId 集合圈定——跨店绝不串）。
// 引擎只消费编译冻结的 definition（P2-18 产物）——本模块不做任何 DSL 解释。
import type { CompiledPlan } from "./lib/automation-compiler.ts";

export type MatchedAutomation = {
  automationId: string;
  version: number;
  plan: CompiledPlan;
};

type AutomationRow = { id: string; currentVersionId: string | null };
type VersionRow = { id: string; automationId: string; version: number; definition: unknown };

type MatcherClient = {
  automation: {
    findMany: (args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => Promise<AutomationRow[]>;
  };
  automationVersion: {
    findMany: (args: {
      where: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => Promise<VersionRow[]>;
  };
};

/** trigger 匹配键：编译期固化在计划里（matcherKey = type 或 type|topic）。 */
function matchesTriggerKey(plan: CompiledPlan, triggerType: string): boolean {
  return plan.triggerMatcherKey === triggerType || plan.triggerType === triggerType;
}

function isCompiledPlanShape(value: unknown): value is CompiledPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<CompiledPlan>;
  // 编译产物最小形状：matcherKey + 动作数组；旧数据/半成品引擎拒绝消费
  return typeof plan.triggerMatcherKey === "string" && Array.isArray(plan.actions);
}

/**
 * 命中规则：shopId + status=active + currentVersionId 非空；trigger 归属由编译计划判定。
 * status=active 但版本缺失/形状坏的自动化跳过——宁可不执行，不带病执行。
 */
export async function matchAutomations(
  client: MatcherClient,
  shopId: string,
  triggerType: string,
): Promise<MatchedAutomation[]> {
  if (!shopId) throw new Error("matchAutomations requires a shopId (multi-tenant guard)");
  const rows = await client.automation.findMany({
    where: { shopId, status: "active", currentVersionId: { not: null } },
    select: { id: true, currentVersionId: true },
  });
  const wantedVersionIds = rows
    .map((row) => row.currentVersionId)
    .filter((id): id is string => Boolean(id));
  if (wantedVersionIds.length === 0) return [];

  // 版本按本店已知的 currentVersionId 圈定：等价于强制了 shopId 边界
  const versions = await client.automationVersion.findMany({
    where: { id: { in: wantedVersionIds } },
    select: { id: true, automationId: true, version: true, definition: true },
  });
  const byId = new Map(versions.map((v) => [v.id, v]));

  const matched: MatchedAutomation[] = [];
  for (const row of rows) {
    const version = row.currentVersionId ? byId.get(row.currentVersionId) : undefined;
    if (!version || version.automationId !== row.id) continue; // 悬空指针/串指：跳过
    if (!isCompiledPlanShape(version.definition)) continue;
    const plan = version.definition;
    if (matchesTriggerKey(plan, triggerType))
      matched.push({ automationId: row.id, version: version.version, plan });
  }
  // 命中多条同类自动化各自独立执行（不得合并）：稳定排序保证确定性
  return matched.sort((a, b) => a.automationId.localeCompare(b.automationId));
}

// 带扩展名是故意的：本模块要能被 `node --test` 直接加载（与 shop-directory.ts 同一约定）。
// 自动化管理的服务核（PRD §22 / P3-04）：一切读写先按 shopId 校验归属，跨店不可读写。
// client 注入而非 import db —— 便于脱库单测如实复现 Prisma 的版本/唯一约束行为。
// 定义以 P2-18 编译产物（CompiledPlan）冻结入库；编辑生成新 version，绝不覆写旧版
// （历史执行仍按旧快照回放）。DSL 非法一律被拒、不写库。
import type { Automation, PrismaClient } from "@prisma/client";
import { validateDefinition } from "./automation-dsl.ts";
import { compile, type CompiledPlan } from "./automation-compiler.ts";
import { fieldWhitelist } from "./trigger-registry.ts";
import {
  defaultParams,
  getTemplate,
  type TemplateDefinition,
} from "./template-catalog.ts";

export type AutomationClient = Pick<
  PrismaClient,
  "automation" | "automationVersion" | "executionLog"
>;

/** 参数/定义非法：携带商家可读错误清单，UI 直读展示，绝不透传堆栈。 */
export class AutomationValidationError extends Error {
  readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "AutomationValidationError";
    this.errors = errors;
  }
}

export class AutomationNotFoundError extends Error {
  constructor() {
    super("Automation not found");
    this.name = "AutomationNotFoundError";
  }
}

// —— 目录呈现辅助（复用触发器/参数）——

function templateOrThrow(templateId: string): TemplateDefinition {
  const template = getTemplate(templateId);
  if (!template)
    throw new AutomationValidationError(`Unknown template: ${templateId}`);
  return template;
}

/** 把参数喂给模板 → 白名单校验 → 编译冻结；任一步失败抛结构化错误。 */
export function buildPlanFromTemplate(
  template: TemplateDefinition,
  params: Record<string, unknown>,
): CompiledPlan {
  const merged = { ...defaultParams(template), ...params };
  const dsl = template.definitionTemplate(merged);
  const whitelist = fieldWhitelist(template.triggerType);
  const validation = validateDefinition(
    dsl,
    whitelist.size > 0 ? whitelist : undefined,
  );
  if (!validation.ok)
    throw new AutomationValidationError(
      "Template definition is invalid",
      validation.errors,
    );
  try {
    return compile(dsl);
  } catch (error) {
    const flat =
      error instanceof AggregateError
        ? error.errors.map((e) => String(e))
        : [error instanceof Error ? error.message : String(error)];
    throw new AutomationValidationError("Template failed to compile", flat);
  }
}

// —— 读 ——

export type AutomationListItem = {
  id: string;
  name: string;
  status: string;
  triggerType: string | null;
  currentVersion: number | null;
  templateId: string | null;
  /** 当前版本定义里的动作 id 清单，供写 scope 缺口判定（P4-06）；无版本时为空。 */
  actionIds: string[];
  updatedAt: Date;
};

export async function listAutomations(
  client: AutomationClient,
  shopId: string,
): Promise<AutomationListItem[]> {
  const rows = await client.automation.findMany({
    where: { shopId, status: { not: "deleted" } },
    include: {
      versions: true,
      logs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map((row) => {
    const current = row.versions.find((v) => v.id === row.currentVersionId);
    const plan = current ? (current.definition as unknown as CompiledPlan) : null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      triggerType: plan?.triggerType ?? null,
      currentVersion: current?.version ?? null,
      templateId: current?.templateId ?? null,
      actionIds: plan?.actions.map((a) => a.actionId) ?? [],
      updatedAt: row.updatedAt,
    };
  });
}

export type AutomationDetail = {
  id: string;
  name: string;
  status: string;
  currentVersion: {
    version: number;
    plan: CompiledPlan;
    templateId: string | null;
    templateVersion: string | null;
  } | null;
  recentExecution: { id: string; status: string; createdAt: Date } | null;
  requiresProtectedData: boolean;
};

export async function getAutomation(
  client: AutomationClient,
  shopId: string,
  id: string,
): Promise<AutomationDetail> {
  // 归属校验：where 同时锁 id + shopId，跨店查不到即视为不存在。
  const row = await client.automation.findFirst({
    where: { id, shopId, status: { not: "deleted" } },
    include: {
      versions: true,
      logs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!row) throw new AutomationNotFoundError();
  const current = row.versions.find((v) => v.id === row.currentVersionId) ?? null;
  const plan = current ? (current.definition as unknown as CompiledPlan) : null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    currentVersion: current
      ? {
          version: current.version,
          plan: plan as CompiledPlan,
          templateId: current.templateId,
          templateVersion: current.templateVersion,
        }
      : null,
    recentExecution: row.logs[0]
      ? { id: row.logs[0].id, status: row.logs[0].status, createdAt: row.logs[0].createdAt }
      : null,
    requiresProtectedData: plan
      ? fieldWhitelistRequiresData(plan.triggerType)
      : false,
  };
}

/** 触发器是否属 Protected Customer Data（诚实边界口径，供徽标）。 */
function fieldWhitelistRequiresData(triggerType: string): boolean {
  try {
    // 复用注册表派生：无白名单字段但 protected 的（order/customer）也需数据权限
    return protectedTriggers.has(triggerType);
  } catch {
    return false;
  }
}
const protectedTriggers = new Set([
  "order.created",
  "order.paid",
  "order.cancelled",
  "customer.created",
]);

// —— 写 ——

export type CreateFromTemplateInput = {
  templateId: string;
  params?: Record<string, unknown>;
  name?: string;
};

export async function createFromTemplate(
  client: AutomationClient,
  shopId: string,
  input: CreateFromTemplateInput,
): Promise<Automation> {
  const template = templateOrThrow(input.templateId);
  const plan = buildPlanFromTemplate(template, input.params ?? {});
  const name = (input.name && input.name.trim()) || template.name;

  const automation = await client.automation.create({
    data: { shopId, name, status: "active" },
  });
  const version = await client.automationVersion.create({
    data: {
      automationId: automation.id,
      version: 1,
      definition: plan as unknown as object,
      templateId: template.id,
      templateVersion: "1",
    },
  });
  return client.automation.update({
    where: { id: automation.id },
    data: { currentVersionId: version.id },
  });
}

/** 参数编辑：新 version = max+1，不覆写历史；切 currentVersionId 生效。 */
export async function updateParams(
  client: AutomationClient,
  shopId: string,
  id: string,
  params: Record<string, unknown>,
): Promise<Automation> {
  const automation = await client.automation.findFirst({
    where: { id, shopId, status: { not: "deleted" } },
  });
  if (!automation) throw new AutomationNotFoundError();

  const latest = await client.automationVersion.findFirst({
    where: { automationId: automation.id },
    orderBy: { version: "desc" },
  });
  const templateId = latest?.templateId;
  if (!templateId)
    throw new AutomationValidationError(
      "This automation was not created from a template and cannot be edited by parameters",
    );
  const template = templateOrThrow(templateId);
  const plan = buildPlanFromTemplate(template, params);

  const nextVersion = await client.automationVersion.create({
    data: {
      automationId: automation.id,
      version: (latest?.version ?? 0) + 1,
      definition: plan as unknown as object,
      templateId: template.id,
      templateVersion: "1",
    },
  });
  return client.automation.update({
    where: { id: automation.id },
    data: { currentVersionId: nextVersion.id },
  });
}

async function setStatus(
  client: AutomationClient,
  shopId: string,
  id: string,
  status: string,
): Promise<Automation> {
  const automation = await client.automation.findFirst({
    where: { id, shopId },
    select: { id: true },
  });
  if (!automation) throw new AutomationNotFoundError();
  return client.automation.update({ where: { id }, data: { status } });
}

export function setActive(client: AutomationClient, shopId: string, id: string) {
  return setStatus(client, shopId, id, "active");
}
export function pause(client: AutomationClient, shopId: string, id: string) {
  return setStatus(client, shopId, id, "paused");
}
/** 软删：status=deleted，历史执行/版本保留可审计。 */
export function softDelete(client: AutomationClient, shopId: string, id: string) {
  return setStatus(client, shopId, id, "deleted");
}

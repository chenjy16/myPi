import type { Prisma } from "@prisma/client";
import db from "./db.server";
import { AppError } from "./lib/app-error";
import type {
  SupplierProfile,
  VariantBinding,
} from "./lib/supplier-validation";

/**
 * 供应商档案与 SKU 供货绑定的读写入口。全部按 `shop` 谓词隔离，与其余
 * 本应用数据同一租户口径；只做本应用数据，不写 Shopify。
 * 建议量重算不在这里触发——由路由层在保存成功后调用 registerReorderSuggestions，
 * 避免本模块与 inventory.server 形成循环依赖。
 */

export type SupplierRow = Prisma.SupplierGetPayload<{
  select: typeof SUPPLIER_LIST_SELECT;
}>;

const SUPPLIER_LIST_SELECT = {
  id: true,
  name: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  leadTimeDays: true,
  notes: true,
  isActive: true,
  updatedAt: true,
  _count: { select: { variants: true } },
} satisfies Prisma.SupplierSelect;

/** 本店供应商列表，按名称排序；附带绑定 SKU 数。 */
export async function listSuppliers(shop: string): Promise<SupplierRow[]> {
  return db.supplier.findMany({
    where: { shop },
    orderBy: { name: "asc" },
    select: SUPPLIER_LIST_SELECT,
  });
}

/** 新建供应商。(shop, name) 唯一：重名不是系统故障，是商家要当场解决的输入问题。 */
export async function createSupplier(
  shop: string,
  profile: SupplierProfile,
): Promise<string> {
  const existing = await db.supplier.findUnique({
    where: { shop_name: { shop, name: profile.name } },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      "validation",
      `A supplier named “${profile.name}” already exists. Names must be unique per store.`,
    );
  }
  const created = await db.supplier.create({
    data: { shop, ...profile },
    select: { id: true },
  });
  return created.id;
}

/** 更新档案；限定 (shop, id)，跨店改不到任何行。 */
export async function updateSupplier(
  shop: string,
  supplierId: string,
  profile: SupplierProfile,
): Promise<void> {
  await ensureSupplierOwned(shop, supplierId);
  const clash = await db.supplier.findUnique({
    where: { shop_name: { shop, name: profile.name } },
    select: { id: true },
  });
  if (clash && clash.id !== supplierId) {
    throw new AppError(
      "validation",
      `Another supplier is already named “${profile.name}”. Names must be unique per store.`,
    );
  }
  await db.supplier.update({
    where: { id: supplierId },
    data: { ...profile },
  });
}

/** 停用/启用供应商。停用即从计算与绑定候选里退出，但保留档案与绑定关系。 */
export async function setSupplierActive(
  shop: string,
  supplierId: string,
  isActive: boolean,
): Promise<void> {
  await ensureSupplierOwned(shop, supplierId);
  await db.supplier.update({
    where: { id: supplierId },
    data: { isActive },
  });
}

/**
 * 删除供应商；外键会级联解绑其全部 SKU。返回受影响绑定数，
 * 让 UI 能把「删掉的同时有哪些变体回到店铺默认口径」说清楚。
 */
export async function deleteSupplier(
  shop: string,
  supplierId: string,
): Promise<{ removedBindings: number }> {
  await ensureSupplierOwned(shop, supplierId);
  const [bindingCount] = await db.$transaction([
    db.variantSupplier.count({
      where: { shop, supplierId },
    }),
    db.supplier.delete({ where: { id: supplierId } }),
  ]);
  return { removedBindings: bindingCount };
}

export type BindingRow = Prisma.VariantSupplierGetPayload<{
  select: typeof BINDING_LIST_SELECT;
}>;

const BINDING_LIST_SELECT = {
  id: true,
  variantId: true,
  supplierId: true,
  minOrderQuantity: true,
  casePack: true,
  unitCost: true,
  supplier: { select: { name: true, isActive: true, leadTimeDays: true } },
} satisfies Prisma.VariantSupplierSelect;

/** 本店全部 SKU 供货绑定（含供应商名，供列表与计算共用）。 */
export async function listVariantBindings(
  shop: string,
): Promise<BindingRow[]> {
  return db.variantSupplier.findMany({
    where: { shop },
    select: BINDING_LIST_SELECT,
    orderBy: { variantId: "asc" },
  });
}

/**
 * 绑定或更新变体的供货条款。(shop, variantId) 唯一 —— MVP 一个变体一个主供应商，
 * 已存在即整条改写（换供应商也走这里）。目标供应商必须属于本店且未停用。
 */
export async function bindVariantSupplier(
  shop: string,
  variantId: string,
  supplierId: string,
  binding: VariantBinding,
): Promise<void> {
  await ensureSupplierOwned(shop, supplierId, { requireActive: true });
  await db.variantSupplier.upsert({
    where: { shop_variantId: { shop, variantId } },
    create: { shop, variantId, supplierId, ...binding },
    update: { supplierId, ...binding },
  });
}

/** 解绑变体；没绑过就静默成功（幂等，商家重复点取消不该看到报错）。 */
export async function unbindVariantSupplier(
  shop: string,
  variantId: string,
): Promise<void> {
  await db.variantSupplier.deleteMany({ where: { shop, variantId } });
}

/** 读取供应商档案（编辑表单回填用）；限定本店。 */
export async function getSupplier(
  shop: string,
  supplierId: string,
): Promise<SupplierProfile & { isActive: boolean }> {
  const row = await db.supplier.findFirst({
    where: { shop, id: supplierId },
    select: {
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      leadTimeDays: true,
      notes: true,
      isActive: true,
    },
  });
  if (!row) {
    throw new AppError(
      "validation",
      "That supplier no longer exists for this store.",
    );
  }
  return row;
}

async function ensureSupplierOwned(
  shop: string,
  supplierId: string,
  options: { requireActive?: boolean } = {},
): Promise<void> {
  const supplier = await db.supplier.findFirst({
    where: { shop, id: supplierId },
    select: { id: true, isActive: true, name: true },
  });
  if (!supplier) {
    throw new AppError(
      "validation",
      "That supplier no longer exists for this store.",
    );
  }
  if (options.requireActive && !supplier.isActive) {
    throw new AppError(
      "validation",
      `“${supplier.name}” is paused. Activate it before binding SKUs to it.`,
    );
  }
}

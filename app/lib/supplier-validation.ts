// 带扩展名是故意的：与 settings-validation 一样，本文件要能被 `node --test` 直接加载。
import { parseInteger } from "./settings-validation.ts";

/**
 * 供应商档案与 SKU 绑定的表单校验层。
 * 规则全部是纯函数：不碰数据库，错误按字段返回文案，UI 能把问题贴回对应输入框。
 */

export const SUPPLIER_LIMITS = {
  name: { max: 120 },
  contactName: { max: 80 },
  contactEmail: { max: 160 },
  contactPhone: { max: 40 },
  notes: { max: 500 },
  leadTimeDays: { min: 0, max: 180 },
  minOrderQuantity: { min: 0, max: 100_000 },
  casePack: { min: 0, max: 100_000 },
  unitCost: { min: 0, max: 1_000_000 },
} as const;

export type SupplierProfile = {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** null = 跟随店铺级补货参数。 */
  leadTimeDays: number | null;
  notes: string | null;
};

export type SupplierFieldErrors = Record<string, string>;

export type SupplierValidation =
  | { ok: true; value: SupplierProfile; errors: Record<string, never> }
  | { ok: false; value: null; errors: SupplierFieldErrors };

/** 文本字段收口：空串折成 null，超长报错。 */
function readText(
  field: keyof typeof SUPPLIER_LIMITS,
  label: string,
  raw: unknown,
  errors: SupplierFieldErrors,
): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  const max = SUPPLIER_LIMITS[field].max;
  if (text.length > max) {
    errors[field] = `${label} must be ${max} characters or fewer.`;
  }
  return text;
}

/** 可选整数字段：留空即 null（表示「跟随默认」），填了就必须是区间内的整数。 */
function readOptionalInteger(
  field: "leadTimeDays" | "minOrderQuantity" | "casePack",
  label: string,
  raw: unknown,
  errors: SupplierFieldErrors,
): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return null;
  const parsed = parseInteger(text);
  if (parsed === null) {
    errors[field] = `${label} must be a whole number.`;
    return null;
  }
  const { min, max } = SUPPLIER_LIMITS[field];
  if (parsed < min || parsed > max) {
    errors[field] = `${label} must be between ${min} and ${max}.`;
    return null;
  }
  return parsed;
}

/**
 * 校验供应商档案。email 只做宽松格式检查：校验太严会把真实存在的海外供应商
 * 邮箱挡在门外，太松又让拼写错误安静入库，这里取「有 @ 和点」的中间态。
 */
export function validateSupplierProfile(raw: {
  name?: unknown;
  contactName?: unknown;
  contactEmail?: unknown;
  contactPhone?: unknown;
  leadTimeDays?: unknown;
  notes?: unknown;
}): SupplierValidation {
  const errors: SupplierFieldErrors = {};

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") {
    errors.name = "Supplier name is required.";
  } else if (name.length > SUPPLIER_LIMITS.name.max) {
    errors.name = `Supplier name must be ${SUPPLIER_LIMITS.name.max} characters or fewer.`;
  }

  const contactName = readText("contactName", "Contact name", raw.contactName, errors);
  const contactEmailRaw = readText(
    "contactEmail",
    "Contact email",
    raw.contactEmail,
    errors,
  );
  if (
    contactEmailRaw !== null &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmailRaw)
  ) {
    errors.contactEmail = "Contact email doesn't look like an email address.";
  }
  const contactPhone = readText("contactPhone", "Contact phone", raw.contactPhone, errors);
  const leadTimeDays = readOptionalInteger(
    "leadTimeDays",
    "Supplier lead time",
    raw.leadTimeDays,
    errors,
  );
  const notes = readText("notes", "Notes", raw.notes, errors);

  if (Object.keys(errors).length > 0) {
    return { ok: false, value: null, errors };
  }
  return {
    ok: true,
    value: {
      name,
      contactName,
      contactEmail: contactEmailRaw,
      contactPhone,
      leadTimeDays,
      notes,
    },
    errors: {},
  };
}

export type VariantBinding = {
  minOrderQuantity: number;
  casePack: number;
  unitCost: number | null;
};

export type BindingValidation =
  | { ok: true; value: VariantBinding; errors: Record<string, never> }
  | { ok: false; value: null; errors: SupplierFieldErrors };

/**
 * 校验 SKU 供货条款：MOQ / case pack 留空按 0（无门槛、不按箱）处理；
 * unitCost 接受最多两位小数，负数与天书一律拒绝。
 */
export function validateVariantBinding(raw: {
  minOrderQuantity?: unknown;
  casePack?: unknown;
  unitCost?: unknown;
}): BindingValidation {
  const errors: SupplierFieldErrors = {};

  const readRequiredInteger = (
    field: "minOrderQuantity" | "casePack",
    label: string,
    value: unknown,
  ): number => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") return 0;
    const parsed = readOptionalInteger(field, label, text, errors);
    return parsed ?? 0;
  };
  const minOrderQuantity = readRequiredInteger(
    "minOrderQuantity",
    "Minimum order quantity",
    raw.minOrderQuantity,
  );
  const casePack = readRequiredInteger(
    "casePack",
    "Case pack",
    raw.casePack,
  );

  let unitCost: number | null = null;
  const costText = typeof raw.unitCost === "string" ? raw.unitCost.trim() : "";
  if (costText !== "") {
    if (!/^\d+(\.\d{1,2})?$/.test(costText)) {
      errors.unitCost = "Unit cost must be a number with up to 2 decimals.";
    } else {
      const parsed = Number(costText);
      if (parsed < SUPPLIER_LIMITS.unitCost.min || parsed > SUPPLIER_LIMITS.unitCost.max) {
        errors.unitCost = `Unit cost must be between ${SUPPLIER_LIMITS.unitCost.min} and ${SUPPLIER_LIMITS.unitCost.max}.`;
      } else {
        unitCost = parsed;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, value: null, errors };
  }
  return { ok: true, value: { minOrderQuantity, casePack, unitCost }, errors: {} };
}

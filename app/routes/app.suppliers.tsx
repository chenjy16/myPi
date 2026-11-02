import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import {
  SUPPLIER_LIMITS,
  validateSupplierProfile,
  validateVariantBinding,
} from "../lib/supplier-validation";
import {
  bindVariantSupplier,
  createSupplier,
  deleteSupplier,
  listSuppliers,
  listVariantBindings,
  setSupplierActive,
  unbindVariantSupplier,
  updateSupplier,
} from "../suppliers.server";
import { registerReorderSuggestions } from "../inventory.server";
import { trackEvent } from "../analytics.server";

/** 未绑定供应商的快照变体，作为绑定表单的下拉候选。 */
type VariantCandidate = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
};

function variantLabel(candidate: VariantCandidate): string {
  const title = candidate.variantTitle
    ? `${candidate.productTitle} — ${candidate.variantTitle}`
    : candidate.productTitle;
  return candidate.sku ? `${title} (${candidate.sku})` : title;
}

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settingsRow = await db.inventorySettings.findUnique({
    where: { shop },
    select: { locationId: true, locationName: true },
  });
  const [suppliers, bindings] = await Promise.all([
    listSuppliers(shop),
    listVariantBindings(shop),
  ]);

  // 候选与已绑定行信息都取最新快照日的 tracked 变体。
  let candidates: VariantCandidate[] = [];
  const boundVariantInfo = new Map<string, VariantCandidate>();
  const bindingsByVariant = new Map(
    bindings.map((binding) => [binding.variantId, binding]),
  );
  if (settingsRow?.locationId) {
    const newest = await db.inventorySnapshot.findFirst({
      where: { shop, locationId: settingsRow.locationId },
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true },
    });
    if (newest) {
      const rows = await db.inventorySnapshot.findMany({
        where: {
          shop,
          locationId: settingsRow.locationId,
          tracked: true,
          snapshotDate: newest.snapshotDate,
        },
        select: {
          variantId: true,
          productTitle: true,
          variantTitle: true,
          sku: true,
        },
        orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
      });
      candidates = rows
        .filter((row) => !bindingsByVariant.has(row.variantId))
        .map((row) => ({ ...row }));
      for (const variantId of bindingsByVariant.keys()) {
        const info = rows.find((row) => row.variantId === variantId);
        if (info) boundVariantInfo.set(variantId, { ...info });
      }
    }
  }

  return {
    locationName: settingsRow?.locationName ?? null,
    hasSnapshot: candidates.length > 0 || boundVariantInfo.size > 0,
    suppliers,
    bindings,
    candidates,
    boundVariantInfo: Array.from(boundVariantInfo.entries()),
  };
});

/** 保存类操作之后统一重算建议口径，让取整与交期变化当场反映到建议量上。 */
async function recalcAdvice(shop: string): Promise<string> {
  const { registered, refreshed } = await registerReorderSuggestions(shop);
  const affected = registered + refreshed;
  return affected > 0
    ? ` Reorder advice refreshed (${affected} rows).`
    : " No advice rows were affected.";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const fail = (error: unknown) => {
    const safe = toSafeError(error);
    console.error("[mypi] supplier action failed", {
      intent,
      kind: safe.kind,
      detail: safe.detail,
    });
    return { error: safe.message };
  };

  try {
    switch (intent) {
      case "create-supplier": {
        const validation = validateSupplierProfile({
          name: formData.get("name"),
          contactName: formData.get("contactName"),
          contactEmail: formData.get("contactEmail"),
          contactPhone: formData.get("contactPhone"),
          leadTimeDays: formData.get("leadTimeDays"),
          notes: formData.get("notes"),
        });
        if (!validation.ok) {
          return { fieldErrors: validation.errors, scope: "supplier" };
        }
        await createSupplier(shop, validation.value);
        trackEvent(shop, "supplier_saved", { action: "created" });
        return {
          notice: `Supplier “${validation.value.name}” created.` +
            (await recalcAdvice(shop)),
        };
      }
      case "update-supplier": {
        const supplierId = String(formData.get("supplierId") ?? "");
        const validation = validateSupplierProfile({
          name: formData.get("name"),
          contactName: formData.get("contactName"),
          contactEmail: formData.get("contactEmail"),
          contactPhone: formData.get("contactPhone"),
          leadTimeDays: formData.get("leadTimeDays"),
          notes: formData.get("notes"),
        });
        if (!validation.ok) {
          return { fieldErrors: validation.errors, scope: "supplier" };
        }
        await updateSupplier(shop, supplierId, validation.value);
        trackEvent(shop, "supplier_saved", { action: "updated" });
        return {
          notice: `Supplier “${validation.value.name}” updated.` +
            (await recalcAdvice(shop)),
        };
      }
      case "toggle-supplier": {
        const supplierId = String(formData.get("supplierId") ?? "");
        const activate = formData.get("activate") === "true";
        await setSupplierActive(shop, supplierId, activate);
        trackEvent(shop, "supplier_saved", {
          action: activate ? "activated" : "paused",
        });
        return {
          notice:
            (activate
              ? "Supplier activated; its terms apply to advice again."
              : "Supplier paused; its bound SKUs fall back to store settings.") +
            (await recalcAdvice(shop)),
        };
      }
      case "delete-supplier": {
        const supplierId = String(formData.get("supplierId") ?? "");
        const { removedBindings } = await deleteSupplier(shop, supplierId);
        return {
          notice: `Supplier deleted${
            removedBindings > 0
              ? ` and ${removedBindings} SKU binding(s) removed`
              : ""
          }.` + (await recalcAdvice(shop)),
        };
      }
      case "bind-variant": {
        const variantId = String(formData.get("variantId") ?? "");
        const supplierId = String(formData.get("supplierId") ?? "");
        if (!variantId || !supplierId) {
          return {
            fieldErrors: { variantId: "Pick a variant and a supplier." },
            scope: "binding",
          };
        }
        const validation = validateVariantBinding({
          minOrderQuantity: formData.get("minOrderQuantity"),
          casePack: formData.get("casePack"),
          unitCost: formData.get("unitCost"),
        });
        if (!validation.ok) {
          return { fieldErrors: validation.errors, scope: "binding" };
        }
        await bindVariantSupplier(shop, variantId, supplierId, validation.value);
        trackEvent(shop, "supplier_saved", { action: "bound" });
        return {
          notice: "Supply terms saved." + (await recalcAdvice(shop)),
        };
      }
      case "unbind-variant": {
        const variantId = String(formData.get("variantId") ?? "");
        await unbindVariantSupplier(shop, variantId);
        trackEvent(shop, "supplier_saved", { action: "unbound" });
        return {
          notice: "Variant unbound; it follows store settings again." +
            (await recalcAdvice(shop)),
        };
      }
      default:
        return { error: "Unsupported operation." };
    }
  } catch (error) {
    return fail(error);
  }
};

export default function SuppliersPage() {
  const {
    locationName,
    hasSnapshot,
    suppliers,
    bindings,
    candidates,
    boundVariantInfo,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  const data = fetcher.data;
  const notice = data && "notice" in data ? data.notice : undefined;
  const error = data && "error" in data ? data.error : undefined;
  const fieldErrors =
    data && "fieldErrors" in data ? data.fieldErrors : undefined;
  const errorScope = data && "scope" in data ? data.scope : undefined;
  const variantInfoById = new Map(boundVariantInfo);

  return (
    <s-page heading="Suppliers">
      <div className="workspace secondaryWorkspace">
        <div className="pageIntro">
          <span className="eyebrow">Supply relationships</span>
          <h1>Suppliers</h1>
          <p>
            Record who supplies each SKU and on what terms. Bound suppliers
            override store-wide advice with their own lead time, and reorder
            quantities round up to full case packs and minimum order
            quantities.
          </p>
          {locationName && (
            <p className="settingsHelp">
              Terms apply to variants observed at {locationName}; everything is
              stored inside this app only and never written to Shopify.
            </p>
          )}
        </div>

        {notice && <div className="settingsSuccess">{notice}</div>}
        {error && <div className="settingsError">{error}</div>}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ▤
              </span>
              <h2>Supplier list</h2>
            </div>
            <span className="historyCount">{suppliers.length} total</span>
          </div>
          {suppliers.length === 0 ? (
            <p className="dsEmptyRow">
              No suppliers yet. Add the first one below — advice keeps using
              store settings until SKUs are bound.
            </p>
          ) : (
            suppliers.map((supplier) => (
              <div className="supplierRow" key={supplier.id}>
                <div className="supplierRowMain">
                  <strong>{supplier.name}</strong>
                  <span>
                    {[
                      supplier.contactName,
                      supplier.contactEmail,
                      supplier.contactPhone,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No contact recorded"}
                  </span>
                  <span>
                    {supplier.leadTimeDays !== null
                      ? `Lead time ${supplier.leadTimeDays} days`
                      : "Lead time follows store settings"}{" "}
                    · {supplier._count.variants} SKU
                    {supplier._count.variants === 1 ? "" : "s"} bound
                  </span>
                </div>
                <span
                  className={`connectionPill ${
                    supplier.isActive ? "isConfigured" : "needsSetup"
                  }`}
                >
                  <span aria-hidden="true">●</span>
                  {supplier.isActive ? "Active" : "Paused"}
                </span>
                <fetcher.Form method="post" className="supplierRowActions">
                  <input type="hidden" name="intent" value="toggle-supplier" />
                  <input
                    type="hidden"
                    name="supplierId"
                    value={supplier.id}
                  />
                  <input
                    type="hidden"
                    name="activate"
                    value={supplier.isActive ? "false" : "true"}
                  />
                  <s-button type="submit" disabled={isBusy}>
                    {supplier.isActive ? "Pause" : "Activate"}
                  </s-button>
                </fetcher.Form>
                <fetcher.Form
                  method="post"
                  className="supplierRowActions"
                  onSubmit={(event) => {
                    if (
                      !window.confirm(
                        `Delete “${supplier.name}”? ${supplier._count.variants} SKU binding(s) will fall back to store settings.`,
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="delete-supplier" />
                  <input
                    type="hidden"
                    name="supplierId"
                    value={supplier.id}
                  />
                  <s-button type="submit" disabled={isBusy}>
                    Delete
                  </s-button>
                </fetcher.Form>
                <details className="supplierEdit">
                  <summary>Edit</summary>
                  <fetcher.Form method="post" className="supplierEditForm">
                    <input type="hidden" name="intent" value="update-supplier" />
                    <input
                      type="hidden"
                      name="supplierId"
                      value={supplier.id}
                    />
                    <label>
                      <span>Name</span>
                      <input
                        name="name"
                        maxLength={SUPPLIER_LIMITS.name.max}
                        required
                        defaultValue={supplier.name}
                      />
                    </label>
                    <label>
                      <span>Contact name</span>
                      <input
                        name="contactName"
                        maxLength={SUPPLIER_LIMITS.contactName.max}
                        defaultValue={supplier.contactName ?? ""}
                      />
                    </label>
                    <label>
                      <span>Contact email</span>
                      <input
                        name="contactEmail"
                        type="email"
                        maxLength={SUPPLIER_LIMITS.contactEmail.max}
                        defaultValue={supplier.contactEmail ?? ""}
                      />
                    </label>
                    <label>
                      <span>Contact phone</span>
                      <input
                        name="contactPhone"
                        maxLength={SUPPLIER_LIMITS.contactPhone.max}
                        defaultValue={supplier.contactPhone ?? ""}
                      />
                    </label>
                    <label>
                      <span>Lead time (days, blank = store setting)</span>
                      <input
                        name="leadTimeDays"
                        type="number"
                        min={SUPPLIER_LIMITS.leadTimeDays.min}
                        max={SUPPLIER_LIMITS.leadTimeDays.max}
                        step="1"
                        defaultValue={supplier.leadTimeDays ?? ""}
                      />
                    </label>
                    <label>
                      <span>Notes</span>
                      <input
                        name="notes"
                        maxLength={SUPPLIER_LIMITS.notes.max}
                        defaultValue={supplier.notes ?? ""}
                      />
                    </label>
                    <s-button type="submit" variant="primary" disabled={isBusy}>
                      Save changes
                    </s-button>
                  </fetcher.Form>
                </details>
              </div>
            ))
          )}
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ＋
              </span>
              <h2>Add supplier</h2>
            </div>
          </div>
          <fetcher.Form method="post" className="supplierEditForm">
            <input type="hidden" name="intent" value="create-supplier" />
            <label>
              <span>Name</span>
              <input
                name="name"
                maxLength={SUPPLIER_LIMITS.name.max}
                required
                placeholder="e.g. Guangzhou Textiles Co."
              />
            </label>
            <label>
              <span>Contact name</span>
              <input
                name="contactName"
                maxLength={SUPPLIER_LIMITS.contactName.max}
              />
            </label>
            <label>
              <span>Contact email</span>
              <input
                name="contactEmail"
                type="email"
                maxLength={SUPPLIER_LIMITS.contactEmail.max}
              />
            </label>
            <label>
              <span>Contact phone</span>
              <input
                name="contactPhone"
                maxLength={SUPPLIER_LIMITS.contactPhone.max}
              />
            </label>
            <label>
              <span>Lead time (days, blank = store setting)</span>
              <input
                name="leadTimeDays"
                type="number"
                min={SUPPLIER_LIMITS.leadTimeDays.min}
                max={SUPPLIER_LIMITS.leadTimeDays.max}
                step="1"
              />
            </label>
            <label>
              <span>Notes</span>
              <input name="notes" maxLength={SUPPLIER_LIMITS.notes.max} />
            </label>
            {fieldErrors && errorScope === "supplier" && (
              <div className="settingsError">
                {Object.values(fieldErrors).join(" ")}
              </div>
            )}
            <s-button type="submit" variant="primary" disabled={isBusy}>
              Add supplier
            </s-button>
          </fetcher.Form>
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ⛓
              </span>
              <h2>SKU supply terms</h2>
            </div>
            <span className="historyCount">{bindings.length} bound</span>
          </div>
          {bindings.length === 0 ? (
            <p className="dsEmptyRow">
              No SKUs are bound to a supplier yet, so every suggestion uses the
              store-wide lead time without MOQ rounding.
            </p>
          ) : (
            bindings.map((binding) => {
              const info = variantInfoById.get(binding.variantId);
              return (
                <div className="supplierRow" key={binding.id}>
                  <div className="supplierRowMain">
                    <strong>
                      {info
                        ? variantLabel(info)
                        : `Variant ${binding.variantId.slice(-8)} (not in current snapshot)`}
                    </strong>
                    <span>
                      {binding.supplier.name}
                      {!binding.supplier.isActive && " (paused — inactive in calculations)"}
                    </span>
                    <span>
                      MOQ {binding.minOrderQuantity || "none"} ·{" "}
                      {binding.casePack > 1
                        ? `case pack ${binding.casePack}`
                        : "no case rounding"}
                      {binding.unitCost !== null
                        ? ` · unit cost ${binding.unitCost}`
                        : ""}
                    </span>
                  </div>
                  <fetcher.Form
                    method="post"
                    className="supplierRowActions"
                    onSubmit={(event) => {
                      if (
                        !window.confirm(
                          "Unbind this variant? Advice for it falls back to store settings.",
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="unbind-variant" />
                    <input
                      type="hidden"
                      name="variantId"
                      value={binding.variantId}
                    />
                    <s-button type="submit" disabled={isBusy}>
                      Unbind
                    </s-button>
                  </fetcher.Form>
                </div>
              );
            })
          )}
          {suppliers.length === 0 || !hasSnapshot ? (
            <p className="settingsNotice">
              {suppliers.length === 0
                ? "Add a supplier first, then bind SKUs to it."
                : "No inventory snapshot is available yet. Run a Sync on the Replenishment page before binding SKUs."}
            </p>
          ) : (
            <fetcher.Form method="post" className="supplierEditForm">
              <input type="hidden" name="intent" value="bind-variant" />
              <label>
                <span>Variant</span>
                <select name="variantId" required defaultValue="">
                  <option value="" disabled>
                    Choose a variant…
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.variantId} value={candidate.variantId}>
                      {variantLabel(candidate)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Supplier</span>
                <select name="supplierId" required defaultValue="">
                  <option value="" disabled>
                    Choose a supplier…
                  </option>
                  {suppliers
                    .filter((supplier) => supplier.isActive)
                    .map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Minimum order quantity (units)</span>
                <input
                  name="minOrderQuantity"
                  type="number"
                  min={SUPPLIER_LIMITS.minOrderQuantity.min}
                  max={SUPPLIER_LIMITS.minOrderQuantity.max}
                  step="1"
                  placeholder="0"
                />
              </label>
              <label>
                <span>Case pack (units per case)</span>
                <input
                  name="casePack"
                  type="number"
                  min={SUPPLIER_LIMITS.casePack.min}
                  max={SUPPLIER_LIMITS.casePack.max}
                  step="1"
                  placeholder="0"
                />
              </label>
              <label>
                <span>Unit cost (supplier quote)</span>
                <input
                  name="unitCost"
                  type="text"
                  inputMode="decimal"
                  maxLength={12}
                  placeholder="e.g. 4.50"
                />
              </label>
              {fieldErrors && errorScope === "binding" && (
                <div className="settingsError">
                  {Object.values(fieldErrors).join(" ")}
                </div>
              )}
              <s-button type="submit" variant="primary" disabled={isBusy}>
                Save supply terms
              </s-button>
            </fetcher.Form>
          )}
        </section>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

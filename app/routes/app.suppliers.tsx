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
import { formatMoney, formatQuantity } from "../lib/format";
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
import { ConfirmFetchForm } from "../components/ui/confirm-fetch-form";
import { EmptyState } from "../components/ui/empty-state";
import { LoadingState } from "../components/ui/loading-state";
import { SupplierActivityBadge } from "../components/ui/status-badge";

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
    select: {
      locationId: true,
      locationName: true,
      currencyCode: true,
      timezone: true,
    },
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
    currencyCode: settingsRow?.currencyCode ?? "USD",
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

/** 反馈按提交来源分桶：供应商操作的结果只出现在供应商区，绑定操作只出现在供货条款区。 */
const SUPPLIER_INTENTS = [
  "create-supplier",
  "update-supplier",
  "toggle-supplier",
  "delete-supplier",
];
const BINDING_INTENTS = ["bind-variant", "unbind-variant"];

const EMAIL_MAX_LENGTH = SUPPLIER_LIMITS.contactEmail.max;

export default function SuppliersPage() {
  const {
    locationName,
    currencyCode,
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
  const variantInfoById = new Map(boundVariantInfo);

  const currentIntent = fetcher.formData?.get("intent");
  // 结果只跟着刚提交的那一类操作出现，供应商报错不盖到供货条款区。
  const supplierSubmit =
    typeof currentIntent === "string" && SUPPLIER_INTENTS.includes(currentIntent);
  const bindingSubmit =
    typeof currentIntent === "string" && BINDING_INTENTS.includes(currentIntent);
  // 字段错误贴回「刚提交的那张表单」：多个供应商编辑表单共用一个 fetcher，
  // 用隐藏的 formKey 区分，才不会一个供应商的校验错误同时点亮所有编辑抽屉。
  const submittedFormKey = fetcher.formData?.get("formKey");
  const fieldErrorFor = (formKey: string, field: string) =>
    fieldErrors && submittedFormKey === formKey ? fieldErrors[field] : undefined;

  const activeSupplierOptions = suppliers.filter((s) => s.isActive);

  return (
    <s-page heading="Suppliers">
      <s-section heading="Supply relationships">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Record who supplies each SKU and on what terms. Bound suppliers
            override store-wide advice with their own lead time, and reorder
            quantities round up to full case packs and minimum order
            quantities.
          </s-paragraph>
          {locationName && (
            <s-paragraph>
              Terms apply to variants observed at {locationName}; everything is
              stored inside this app only and never written to Shopify.
            </s-paragraph>
          )}
          {/* s-page 只接受 s-section 直接子节点，反馈横幅放进本节，不裸挂在页面层。 */}
          {supplierSubmit && notice && (
            <s-banner tone="success" heading="Saved">
              {notice}
            </s-banner>
          )}
          {supplierSubmit && error && (
            <s-banner tone="critical" heading="Couldn't save">
              {error}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Supplier list (${suppliers.length})`}>
        {suppliers.length === 0 ? (
          <EmptyState
            heading="No suppliers yet"
            body="Add the first one below. Reorder advice keeps using the store-wide lead time and has no MOQ rounding until a SKU is bound to a supplier."
          />
        ) : (
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))"
            gap="base"
          >
            {suppliers.map((supplier) => {
              const contactLine = [
                supplier.contactName,
                supplier.contactEmail,
                supplier.contactPhone,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <s-box
                  key={supplier.id}
                  padding="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small">
                      <s-text type="strong">{supplier.name}</s-text>
                      <SupplierActivityBadge
                        kind={supplier.isActive ? "active" : "paused"}
                      />
                    </s-stack>
                    <s-paragraph>
                      {contactLine || "No contact recorded"}
                    </s-paragraph>
                    <s-paragraph>
                      {supplier.leadTimeDays !== null
                        ? `Lead time ${formatQuantity(supplier.leadTimeDays)} days`
                        : "Lead time follows store settings"}{" "}
                      ·{" "}
                      {formatQuantity(supplier._count.variants)} SKU
                      {supplier._count.variants === 1 ? "" : "s"} bound
                    </s-paragraph>
                    {supplier.notes && <s-paragraph>{supplier.notes}</s-paragraph>}

                    <s-stack direction="inline" gap="small">
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="toggle-supplier"
                        />
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
                        <s-button type="submit" variant="secondary" disabled={isBusy}>
                          {supplier.isActive ? "Pause" : "Activate"}
                        </s-button>
                      </fetcher.Form>
                      <ConfirmFetchForm
                        fetcher={fetcher}
                        confirm={{
                          heading: `Delete ${supplier.name}`,
                          body: `${supplier._count.variants} SKU binding(s) will fall back to store settings. This can't be undone from here.`,
                          confirmLabel: "Delete supplier",
                          danger: true,
                        }}
                      >
                        <input
                          type="hidden"
                          name="intent"
                          value="delete-supplier"
                        />
                        <input
                          type="hidden"
                          name="supplierId"
                          value={supplier.id}
                        />
                        <s-button type="submit" variant="tertiary" disabled={isBusy}>
                          Delete
                        </s-button>
                      </ConfirmFetchForm>
                    </s-stack>

                    <details>
                      <summary>Edit details</summary>
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="update-supplier" />
                        <input
                          type="hidden"
                          name="supplierId"
                          value={supplier.id}
                        />
                        <input
                          type="hidden"
                          name="formKey"
                          value={supplier.id}
                        />
                        <s-stack direction="block" gap="base">
                          <s-text-field
                            label="Name"
                            name="name"
                            maxLength={SUPPLIER_LIMITS.name.max}
                            required
                            error={fieldErrorFor(supplier.id, "name")}
                            defaultValue={supplier.name}
                          />
                          <s-text-field
                            label="Contact name"
                            name="contactName"
                            maxLength={SUPPLIER_LIMITS.contactName.max}
                            error={fieldErrorFor(supplier.id, "contactName")}
                            defaultValue={supplier.contactName ?? ""}
                          />
                          <s-email-field
                            label="Contact email"
                            name="contactEmail"
                            maxLength={EMAIL_MAX_LENGTH}
                            error={fieldErrorFor(supplier.id, "contactEmail")}
                            defaultValue={supplier.contactEmail ?? ""}
                          />
                          <s-text-field
                            label="Contact phone"
                            name="contactPhone"
                            maxLength={SUPPLIER_LIMITS.contactPhone.max}
                            error={fieldErrorFor(supplier.id, "contactPhone")}
                            defaultValue={supplier.contactPhone ?? ""}
                          />
                          <s-number-field
                            label="Lead time (days)"
                            name="leadTimeDays"
                            details="Leave blank to follow the store-wide lead time."
                            min={SUPPLIER_LIMITS.leadTimeDays.min}
                            max={SUPPLIER_LIMITS.leadTimeDays.max}
                            step={1}
                            error={fieldErrorFor(supplier.id, "leadTimeDays")}
                            defaultValue={
                              supplier.leadTimeDays !== null
                                ? String(supplier.leadTimeDays)
                                : ""
                            }
                          />
                          <s-text-area
                            label="Notes"
                            name="notes"
                            maxLength={SUPPLIER_LIMITS.notes.max}
                            error={fieldErrorFor(supplier.id, "notes")}
                            defaultValue={supplier.notes ?? ""}
                          />
                          {submittedFormKey === supplier.id &&
                            supplierSubmit && (
                              <LoadingState label="Saving supplier…" />
                            )}
                          <s-button
                            type="submit"
                            variant="primary"
                            disabled={isBusy}
                          >
                            Save changes
                          </s-button>
                        </s-stack>
                      </fetcher.Form>
                    </details>
                  </s-stack>
                </s-box>
              );
            })}
          </s-grid>
        )}
      </s-section>

      <s-section heading="Add supplier">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="create-supplier" />
          <input type="hidden" name="formKey" value="new" />
          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
              gap="base"
            >
              <s-text-field
                label="Name"
                name="name"
                maxLength={SUPPLIER_LIMITS.name.max}
                required
                placeholder="e.g. Guangzhou Textiles Co."
                error={fieldErrorFor("new", "name")}
              />
              <s-text-field
                label="Contact name"
                name="contactName"
                maxLength={SUPPLIER_LIMITS.contactName.max}
                error={fieldErrorFor("new", "contactName")}
              />
              <s-email-field
                label="Contact email"
                name="contactEmail"
                maxLength={EMAIL_MAX_LENGTH}
                error={fieldErrorFor("new", "contactEmail")}
              />
              <s-text-field
                label="Contact phone"
                name="contactPhone"
                maxLength={SUPPLIER_LIMITS.contactPhone.max}
                error={fieldErrorFor("new", "contactPhone")}
              />
              <s-number-field
                label="Lead time (days)"
                name="leadTimeDays"
                details="Leave blank to follow the store-wide lead time."
                min={SUPPLIER_LIMITS.leadTimeDays.min}
                max={SUPPLIER_LIMITS.leadTimeDays.max}
                step={1}
                error={fieldErrorFor("new", "leadTimeDays")}
              />
            </s-grid>
            <s-text-area
              label="Notes"
              name="notes"
              maxLength={SUPPLIER_LIMITS.notes.max}
              error={fieldErrorFor("new", "notes")}
            />
            {submittedFormKey === "new" && supplierSubmit && isBusy && (
              <LoadingState label="Adding supplier…" />
            )}
            <s-button type="submit" variant="primary" disabled={isBusy}>
              Add supplier
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading={`SKU supply terms (${bindings.length} bound)`}>
        <s-stack direction="block" gap="base">
          {bindingSubmit && notice && (
            <s-banner tone="success" heading="Saved">
              {notice}
            </s-banner>
          )}
          {bindingSubmit && error && (
            <s-banner tone="critical" heading="Couldn't save">
              {error}
            </s-banner>
          )}
          {bindings.length === 0 ? (
            <EmptyState
              heading="No SKUs are bound to a supplier"
              body="Every suggestion currently uses the store-wide lead time without MOQ or case-pack rounding. Bind a SKU below once you have at least one supplier."
            />
          ) : (
            <s-table variant="list">
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header listSlot="labeled">Supplier</s-table-header>
                <s-table-header listSlot="labeled">Terms</s-table-header>
                <s-table-header listSlot="inline">Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {bindings.map((binding) => {
                  const info = variantInfoById.get(binding.variantId);
                  const termsLine = [
                    binding.minOrderQuantity > 0
                      ? `MOQ ${formatQuantity(binding.minOrderQuantity)}`
                      : "No MOQ",
                    binding.casePack > 1
                      ? `case pack ${formatQuantity(binding.casePack)}`
                      : "No case rounding",
                    `unit cost ${formatMoney(binding.unitCost, currencyCode)}`,
                  ].join(" · ");
                  return (
                    <s-table-row key={binding.id}>
                      <s-table-cell>
                        {info
                          ? variantLabel(info)
                          : `Variant ${binding.variantId.slice(-8)} (not in current snapshot)`}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack direction="inline" gap="small">
                          <s-text>{binding.supplier.name}</s-text>
                          {!binding.supplier.isActive && (
                            <SupplierActivityBadge kind="paused" />
                          )}
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>{termsLine}</s-table-cell>
                      <s-table-cell>
                        <ConfirmFetchForm
                          fetcher={fetcher}
                          confirm={{
                            heading: "Unbind this SKU",
                            body: "Reorder advice for this variant falls back to the store-wide settings. You can bind it again at any time.",
                            confirmLabel: "Unbind",
                            danger: true,
                          }}
                        >
                          <input
                            type="hidden"
                            name="intent"
                            value="unbind-variant"
                          />
                          <input
                            type="hidden"
                            name="variantId"
                            value={binding.variantId}
                          />
                          <s-button type="submit" variant="tertiary" disabled={isBusy}>
                            Unbind
                          </s-button>
                        </ConfirmFetchForm>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Bind a SKU to a supplier">
        {suppliers.length === 0 || !hasSnapshot ? (
          <s-banner tone="info" heading="Nothing to bind yet">
            {suppliers.length === 0
              ? "Add a supplier first, then bind SKUs to it."
              : "No inventory snapshot is available yet. Run a Sync on the Replenishment page before binding SKUs."}
          </s-banner>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="bind-variant" />
            <input type="hidden" name="formKey" value="binding" />
            <s-stack direction="block" gap="base">
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                gap="base"
              >
                <s-select
                  label="Variant"
                  name="variantId"
                  required
                  value=""
                  error={fieldErrorFor("binding", "variantId")}
                >
                  <s-option value="" disabled>
                    Choose a variant…
                  </s-option>
                  {candidates.map((candidate) => (
                    <s-option key={candidate.variantId} value={candidate.variantId}>
                      {variantLabel(candidate)}
                    </s-option>
                  ))}
                </s-select>
                <s-select
                  label="Supplier"
                  name="supplierId"
                  required
                  value=""
                  error={fieldErrorFor("binding", "supplierId")}
                >
                  <s-option value="" disabled>
                    Choose a supplier…
                  </s-option>
                  {activeSupplierOptions.map((supplier) => (
                    <s-option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </s-option>
                  ))}
                </s-select>
                <s-number-field
                  label="Minimum order quantity (units)"
                  name="minOrderQuantity"
                  placeholder="0"
                  min={SUPPLIER_LIMITS.minOrderQuantity.min}
                  max={SUPPLIER_LIMITS.minOrderQuantity.max}
                  step={1}
                  error={fieldErrorFor("binding", "minOrderQuantity")}
                />
                <s-number-field
                  label="Case pack (units per case)"
                  name="casePack"
                  placeholder="0"
                  min={SUPPLIER_LIMITS.casePack.min}
                  max={SUPPLIER_LIMITS.casePack.max}
                  step={1}
                  error={fieldErrorFor("binding", "casePack")}
                />
                <s-number-field
                  label={`Unit cost (${currencyCode})`}
                  name="unitCost"
                  details="Supplier’s quoted price per unit, up to 2 decimals."
                  placeholder="4.50"
                  min={SUPPLIER_LIMITS.unitCost.min}
                  max={SUPPLIER_LIMITS.unitCost.max}
                  step={0.01}
                  error={fieldErrorFor("binding", "unitCost")}
                />
              </s-grid>
              {submittedFormKey === "binding" && bindingSubmit && isBusy && (
                <LoadingState label="Saving supply terms…" />
              )}
              <s-button type="submit" variant="primary" disabled={isBusy}>
                Save supply terms
              </s-button>
            </s-stack>
          </fetcher.Form>
        )}
      </s-section>

      <s-section heading="App navigation">
        <s-stack direction="inline" gap="base">
          <s-link href="/app/inventory">Replenishment</s-link>
          <s-link href="/app/settings">Settings</s-link>
          <s-link href="/app">Back to workspace</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

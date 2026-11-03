/**
 * Purchase Plans 页：从 accepted/edited 建议勾选生成计划（按供应商归并、多 SKU 合并），
 * 支持改量、删行、采购日期与备注、open → ordered / cancelled 流转、CSV 导出。
 * 数字只来自建议池与计划行，本页不重算补货——口径永远在 Replenishment 页那一份。
 */
import { useEffect, useRef } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { trackEvent } from "../analytics.server";
import { toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import {
  parsePlanQuantity,
  parsePurchaseDate,
  PURCHASE_PLAN_STATUS_LABELS,
  type PurchasePlanStatus,
} from "../lib/purchase-plans";
import {
  buildPurchasePlanExport,
  cancelPlan,
  createPlansFromAdvice,
  getAdvicePool,
  listPurchasePlans,
  markPlanOrdered,
  removePlanLine,
  updatePlanLineQuantity,
  updatePlanMeta,
} from "../purchase-plans.server";

const PLAN_NOTES_MAX_LENGTH = 500;

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [pool, plans] = await Promise.all([
    getAdvicePool(session.shop),
    listPurchasePlans(session.shop),
  ]);
  return { pool, plans };
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "create-plans") {
      const variantIds = formData
        .getAll("variantIds")
        .filter((value): value is string => typeof value === "string");
      if (variantIds.length === 0) {
        return { error: "Tick at least one suggestion first." };
      }
      const created = await createPlansFromAdvice(shop, variantIds);
      trackEvent(shop, "purchase_plan_created", {
        plans: created.length,
        lines: created.reduce((sum, plan) => sum + plan.lineCount, 0),
      });
      const summary = created
        .map(
          (plan) =>
            `${plan.reference} (${plan.supplierName}, ${plan.lineCount} line${plan.lineCount === 1 ? "" : "s"}, ${plan.totalUnits} units)`,
        )
        .join("; ");
      return {
        notice: `Created ${created.length} plan${created.length === 1 ? "" : "s"}: ${summary}`,
      };
    }

    if (intent === "update-line") {
      const planId = String(formData.get("planId") ?? "");
      const lineId = String(formData.get("lineId") ?? "");
      const quantity = parsePlanQuantity(formData.get("quantity"));
      if (quantity === null) {
        return { error: "Quantity must be a whole number above zero." };
      }
      await updatePlanLineQuantity(shop, planId, lineId, quantity);
      return { notice: "Line quantity updated." };
    }

    if (intent === "remove-line") {
      const planId = String(formData.get("planId") ?? "");
      const lineId = String(formData.get("lineId") ?? "");
      await removePlanLine(shop, planId, lineId);
      return {
        notice: "Line removed. The suggestion goes back to the planning pool.",
      };
    }

    if (intent === "update-meta") {
      const planId = String(formData.get("planId") ?? "");
      const rawDate = formData.get("purchaseDate");
      const rawNotes = formData.get("notes");
      const dateText = typeof rawDate === "string" ? rawDate.trim() : "";
      const purchaseDate =
        dateText === "" ? null : parsePurchaseDate(dateText);
      if (dateText !== "" && purchaseDate === null) {
        return { error: "Purchase date must be a valid calendar date." };
      }
      const notesText = typeof rawNotes === "string" ? rawNotes.trim() : "";
      if (notesText.length > PLAN_NOTES_MAX_LENGTH) {
        return {
          error: `Notes are limited to ${PLAN_NOTES_MAX_LENGTH} characters.`,
        };
      }
      await updatePlanMeta(shop, planId, {
        purchaseDate,
        notes: notesText === "" ? null : notesText,
      });
      return { notice: "Plan details saved." };
    }

    if (intent === "mark-ordered") {
      const planId = String(formData.get("planId") ?? "");
      const result = await markPlanOrdered(shop, planId);
      trackEvent(shop, "purchase_plan_ordered", {
        reference: result.reference,
        synced: result.synced,
      });
      const skippedNote =
        result.skipped > 0
          ? ` ${result.skipped} line${result.skipped === 1 ? "" : "s"} couldn't sync (the suggestion changed or is already ordered) — check the Replenishment page.`
          : "";
      return {
        notice: `${result.reference} marked as ordered. ${result.synced} suggestion${result.synced === 1 ? "" : "s"} synced to Ordered.${skippedNote}`,
      };
    }

    if (intent === "cancel-plan") {
      const planId = String(formData.get("planId") ?? "");
      const { reference } = await cancelPlan(shop, planId);
      return {
        notice: `${reference} cancelled. Its suggestions are back in the planning pool.`,
      };
    }

    if (intent === "export-csv") {
      const rawPlanId = formData.get("planId");
      const planId = typeof rawPlanId === "string" && rawPlanId ? rawPlanId : undefined;
      const exportResult = await buildPurchasePlanExport(shop, planId);
      if (exportResult.rowCount === 0) {
        return { error: "There are no plan lines to export yet." };
      }
      trackEvent(shop, "csv_exported", {
        kind: "purchase_plan",
        rows: exportResult.rowCount,
      });
      // 专用漏斗事件：区分「导出的是采购计划」这一步，与通用 csv_exported 并存。
      trackEvent(shop, "purchase_plan_exported", {
        planId: planId ?? null,
        rows: exportResult.rowCount,
      });
      return { exportResult };
    }

    return { error: "Unsupported operation." };
  } catch (error) {
    const safe = toSafeError(error);
    console.error("[mypi] purchase plans action failed", {
      shop,
      intent: typeof intent === "string" ? intent : "unknown",
      kind: safe.kind,
      detail: safe.detail,
    });
    return { error: safe.message, errorKind: safe.kind };
  }
};

function formatCreated(value: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function statusPill(status: string): { label: string; tone: string } {
  if (!["open", "ordered", "cancelled"].includes(status)) {
    return { label: status, tone: "neutral" };
  }
  const typed = status as PurchasePlanStatus;
  const tone = typed === "open" ? "info" : typed === "ordered" ? "success" : "neutral";
  return { label: PURCHASE_PLAN_STATUS_LABELS[typed], tone };
}

export default function PurchasePlansPage() {
  const { pool, plans } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const downloadedExport = useRef<string | null>(null);

  const errorMessage =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  const noticeMessage =
    fetcher.data && "notice" in fetcher.data ? fetcher.data.notice : undefined;
  const exportResult =
    fetcher.data && "exportResult" in fetcher.data
      ? fetcher.data.exportResult
      : undefined;

  // 与 Replenishment 页同一套下载方式：action 拿文本，浏览器里落盘，不整页跳转。
  useEffect(() => {
    if (!exportResult) return;
    const fingerprint = `${exportResult.fileName}:${exportResult.rowCount}:${exportResult.csv.length}`;
    if (downloadedExport.current === fingerprint) return;
    downloadedExport.current = fingerprint;

    const url = URL.createObjectURL(
      // 前置 UTF-8 BOM，Excel 双击打开才不会把中文商品名/备注识别成乱码。
      new Blob(["\uFEFF" + exportResult.csv], { type: "text/csv;charset=utf-8;" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportResult.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [exportResult]);

  return (
    <div className="ds">
      <s-page heading="Purchase Plans">
        <s-section heading="How planning works">
          <s-paragraph>
            Tick accepted or edited suggestions here and create plans — lines
            are merged per supplier, quantities come from your confirmed
            numbers on the Replenishment page. Adjust quantities, add a
            purchase date and notes, then mark the plan ordered: the matching
            suggestions move to Ordered too. Ordered and cancelled plans are
            kept as records and cannot be edited.
          </s-paragraph>
          {errorMessage && (
            <s-banner tone="critical" heading="Couldn't continue">
              {errorMessage}
            </s-banner>
          )}
          {noticeMessage && (
            <s-banner tone="success" heading="Done">
              {noticeMessage}
            </s-banner>
          )}
          {exportResult && (
            <s-banner tone="success" heading="Export ready">
              Downloaded {exportResult.rowCount} plan line
              {exportResult.rowCount === 1 ? "" : "s"} to{" "}
              {exportResult.fileName}. If your browser blocked the download,
              allow automatic downloads for this app.
            </s-banner>
          )}
        </s-section>

        <s-section heading="Ready to plan">
          {pool.notice && <s-paragraph>{pool.notice}</s-paragraph>}
          {pool.entries.length > 0 ? (
            <fetcher.Form method="post" className="poolForm">
              <input type="hidden" name="intent" value="create-plans" />
              <div className="poolTable">
                <div className="poolHead">
                  <span>Plan</span>
                  <span>Supplier</span>
                  <span>Quantity</span>
                </div>
                {pool.entries.map((entry) => (
                  <label key={entry.variantId} className="poolRow">
                    <span className="poolMain">
                      <input
                        type="checkbox"
                        name="variantIds"
                        value={entry.variantId}
                      />
                      <span className="poolNames">
                        <strong>{entry.productTitle}</strong>
                        <em>
                          {entry.variantTitle}
                          {entry.sku ? ` · ${entry.sku}` : ""}
                        </em>
                      </span>
                    </span>
                    <span className="poolSupplier">
                      {entry.supplierName ?? "Store default"}
                    </span>
                    <span className="poolQty">{entry.quantity} units</span>
                  </label>
                ))}
              </div>
              <div className="poolActions">
                <s-button type="submit" variant="primary">
                  Create plans from selected
                </s-button>
                <s-paragraph>
                  Lines are merged into one plan per supplier. Suggestions
                  already in an open plan stay out of this list.
                </s-paragraph>
              </div>
            </fetcher.Form>
          ) : (
            <s-paragraph>
              Nothing to plan right now. Accept or edit suggestions on the{" "}
              <a href="/app/inventory">Replenishment page</a> first.
            </s-paragraph>
          )}
        </s-section>

        <s-section heading="Plans">
          {plans.length === 0 ? (
            <s-paragraph>
              No purchase plans yet. Create one from the suggestions above.
            </s-paragraph>
          ) : (
            <>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="export-csv" />
                <s-button type="submit">Export all plans (CSV)</s-button>
              </fetcher.Form>
              {plans.map((plan) => {
                const pill = statusPill(plan.status);
                const isOpen = plan.status === "open";
                const totalUnits = plan.lines.reduce(
                  (sum, line) => sum + line.quantity,
                  0,
                );
                return (
                  <div
                    key={plan.id}
                    className={`planCard${isOpen ? "" : " planCardClosed"}`}
                  >
                    <div className="planHead">
                      <div className="planTitle">
                        <strong>{plan.reference}</strong>
                        <span>{plan.supplierName ?? "Store default"}</span>
                        <span
                          className={`statusPill statusPill-${pill.tone}`}
                        >
                          {pill.label}
                        </span>
                      </div>
                      <div className="planMetaText">
                        Created {formatCreated(plan.createdAt)}
                        {plan.purchaseDate
                          ? ` · purchase date ${plan.purchaseDate}`
                          : ""}
                        {plan.orderedAt
                          ? ` · ordered ${formatCreated(plan.orderedAt)}`
                          : ""}{" "}
                        · {plan.lines.length} line
                        {plan.lines.length === 1 ? "" : "s"} · {totalUnits}{" "}
                        units
                      </div>
                    </div>

                    {plan.lines.length === 0 ? (
                      <s-paragraph>
                        This plan has no lines anymore. Cancel it to clear it
                        from the list.
                      </s-paragraph>
                    ) : (
                      <div className="planLines">
                        {plan.lines.map((line) => (
                          <div key={line.id} className="planLine">
                            <span className="planLineNames">
                              <strong>{line.productTitle}</strong>
                              <em>
                                {line.variantTitle}
                                {line.sku ? ` · ${line.sku}` : ""}
                                {line.unitCost !== null
                                  ? ` · cost ${line.unitCost}`
                                  : ""}
                              </em>
                            </span>
                            {isOpen ? (
                              <fetcher.Form method="post" className="qtyForm">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="update-line"
                                />
                                <input
                                  type="hidden"
                                  name="planId"
                                  value={plan.id}
                                />
                                <input
                                  type="hidden"
                                  name="lineId"
                                  value={line.id}
                                />
                                <input
                                  type="text"
                                  name="quantity"
                                  defaultValue={line.quantity}
                                  inputMode="numeric"
                                  aria-label={`Quantity for ${line.productTitle} ${line.variantTitle}`}
                                />
                                <s-button type="submit" variant="tertiary">
                                  Save
                                </s-button>
                              </fetcher.Form>
                            ) : (
                              <span className="planLineQty">
                                {line.quantity} units
                              </span>
                            )}
                            {isOpen && (
                              <fetcher.Form method="post">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="remove-line"
                                />
                                <input
                                  type="hidden"
                                  name="planId"
                                  value={plan.id}
                                />
                                <input
                                  type="hidden"
                                  name="lineId"
                                  value={line.id}
                                />
                                <s-button type="submit" variant="tertiary">
                                  Remove
                                </s-button>
                              </fetcher.Form>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {isOpen && (
                      <fetcher.Form method="post" className="planMetaForm">
                        <input type="hidden" name="intent" value="update-meta" />
                        <input type="hidden" name="planId" value={plan.id} />
                        <label>
                          Purchase date
                          <input
                            type="date"
                            name="purchaseDate"
                            defaultValue={plan.purchaseDate ?? ""}
                          />
                        </label>
                        <label className="planNotesField">
                          Notes
                          <input
                            type="text"
                            name="notes"
                            defaultValue={plan.notes ?? ""}
                            maxLength={PLAN_NOTES_MAX_LENGTH}
                            placeholder="e.g. ask for split delivery"
                          />
                        </label>
                        <s-button type="submit" variant="secondary">
                          Save details
                        </s-button>
                      </fetcher.Form>
                    )}

                    <div className="planActions">
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="export-csv"
                        />
                        <input type="hidden" name="planId" value={plan.id} />
                        <s-button type="submit" variant="tertiary">
                          Export CSV
                        </s-button>
                      </fetcher.Form>
                      {isOpen && (
                        <>
                          <fetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="mark-ordered"
                            />
                            <input type="hidden" name="planId" value={plan.id} />
                            <s-button
                              type="submit"
                              variant="primary"
                              onClick={(event) => {
                                if (
                                  !window.confirm(
                                    `Mark ${plan.reference} as ordered? The ${plan.lines.length} matching suggestion(s) on the Replenishment page will move to Ordered. This can't be undone from here.`,
                                  )
                                ) {
                                  event.preventDefault();
                                }
                              }}
                            >
                              Mark ordered
                            </s-button>
                          </fetcher.Form>
                          <fetcher.Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="cancel-plan"
                            />
                            <input type="hidden" name="planId" value={plan.id} />
                            <s-button
                              type="submit"
                              variant="tertiary"
                              onClick={(event) => {
                                if (
                                  !window.confirm(
                                    `Cancel ${plan.reference}? Its suggestions go back to the planning pool. This can't be undone from here.`,
                                  )
                                ) {
                                  event.preventDefault();
                                }
                              }}
                            >
                              Cancel plan
                            </s-button>
                          </fetcher.Form>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </s-section>
      </s-page>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

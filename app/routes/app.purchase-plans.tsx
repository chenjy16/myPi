/**
 * Purchase Plans 页：从 accepted/edited 建议勾选生成计划（按供应商归并、多 SKU 合并），
 * 支持改量、删行、采购日期与备注、open → ordered / cancelled 流转、CSV 导出。
 * 数字只来自建议池与计划行，本页不重算补货——口径永远在 Replenishment 页那一份。
 */
import { useEffect, useRef } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { trackEvent } from "../analytics.server";
import { toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import { parsePlanQuantity, parsePurchaseDate } from "../lib/purchase-plans";
import {
  formatDateTime,
  formatDate,
  formatMoney,
  formatQuantity,
  MISSING,
} from "../lib/format";
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
import { EmptyState } from "../components/ui/empty-state";
import { FactGrid } from "../components/ui/fact-grid";
import { LoadingState } from "../components/ui/loading-state";
import {
  PlanStatusBadge,
  StatusBadge,
} from "../components/ui/status-badge";

const PLAN_NOTES_MAX_LENGTH = 500;

/** 提交意图：与 action 里的分支一一对应，页面按它决定反馈落在哪一段。 */
const INTENTS = [
  "create-plans",
  "update-line",
  "remove-line",
  "update-meta",
  "mark-ordered",
  "cancel-plan",
  "export-csv",
] as const;

type ActionIntent = (typeof INTENTS)[number];

/**
 * 反馈分桶：每一类提交的成功/失败只跟着它自己出现。
 * 「改数量失败」不该显示在「导出」旁边，更不该钉死在页面第一段下面。
 */
const BUCKETS = {
  pool: ["create-plans"] as ActionIntent[],
  lines: ["update-line", "remove-line"] as ActionIntent[],
  meta: ["update-meta"] as ActionIntent[],
  lifecycle: ["mark-ordered", "cancel-plan"] as ActionIntent[],
  export: ["export-csv"] as ActionIntent[],
};

const UNKNOWN_INTENT_ERROR =
  "This action couldn't be matched to a section, so its result is shown here.";

/** 认不出来源的提交（脏表单 / 服务端不支持的操作），必须有地方兜住才不被吞掉。 */
const intentIsKnown = (intent: unknown): boolean =>
  typeof intent === "string" && (INTENTS as readonly string[]).includes(intent);

/** 计划行的可编辑数量下限：0 件不是一次采购，删行才是正确动作。 */
const MIN_PLAN_QUANTITY = 1;

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [pool, plans, storeMeta] = await Promise.all([
    getAdvicePool(session.shop),
    listPurchasePlans(session.shop),
    // 金额与时区跟随店铺设置：页面上自己拼 UTC 串会让商家看到错位的时间。
    db.inventorySettings.findFirst({
      where: { shop: session.shop },
      select: { currencyCode: true, timezone: true },
    }),
  ]);
  return {
    pool,
    plans,
    currencyCode: storeMeta?.currencyCode ?? "USD",
    timeZone: storeMeta?.timezone ?? null,
  };
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
      const purchaseDate = dateText === "" ? null : parsePurchaseDate(dateText);
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
      const planId =
        typeof rawPlanId === "string" && rawPlanId ? rawPlanId : undefined;
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

export default function PurchasePlansPage() {
  const { pool, plans, currencyCode, timeZone } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const downloadedExport = useRef<string | null>(null);

  const data = fetcher.data;
  const errorMessage = data && "error" in data ? data.error : undefined;
  const noticeMessage = data && "notice" in data ? data.notice : undefined;
  const exportResult =
    data && "exportResult" in data ? data.exportResult : undefined;

  const isBusy = fetcher.state !== "idle";
  const currentIntent = fetcher.formData?.get("intent");
  const currentPlanId = fetcher.formData?.get("planId");
  const isRefreshing = navigation.state === "loading";

  const intentIn = (bucket: ActionIntent[]) =>
    typeof currentIntent === "string" &&
    bucket.includes(currentIntent as ActionIntent);

  /** 这一段是否正在提交：按钮的 disabled / loading 与行内反馈都以此为准。 */
  const bucketIsBusy = (bucket: ActionIntent[]) => isBusy && intentIn(bucket);
  const bucketNotice = (bucket: ActionIntent[]) =>
    noticeMessage !== undefined && intentIn(bucket) ? noticeMessage : undefined;
  const bucketError = (bucket: ActionIntent[]) =>
    errorMessage !== undefined && intentIn(bucket) ? errorMessage : undefined;

  /*
   * 计划卡内的反馈按 planId 再收一层：update-line / remove-line / update-meta /
   * mark-ordered / cancel-plan 的隐藏域都带 planId，只有「刚提交的那张卡」才该
   * 亮横幅或转圈，否则一句报错会同时复制到每一张计划卡上。
   */
  const planIsBusy = (planId: string, bucket: ActionIntent[]) =>
    isBusy && intentIn(bucket) && currentPlanId === planId;
  const planNotice = (planId: string, bucket: ActionIntent[]) =>
    noticeMessage !== undefined && intentIn(bucket) && currentPlanId === planId
      ? noticeMessage
      : undefined;
  const planError = (planId: string, bucket: ActionIntent[]) =>
    errorMessage !== undefined && intentIn(bucket) && currentPlanId === planId
      ? errorMessage
      : undefined;

  // 认不出来源的失败（脏表单 / 服务端不支持操作）单独在页顶显示一次，绝不重复
  // 出现在每个 section——否则同一句报错会同时亮起三四个横幅。
  const unattributedError =
    errorMessage !== undefined && !intentIsKnown(currentIntent)
      ? UNKNOWN_INTENT_ERROR
      : undefined;

  // 与 Replenishment 页同一套下载方式：action 拿文本，浏览器里落盘，不整页跳转。
  useEffect(() => {
    if (!exportResult) return;
    const fingerprint = `${exportResult.fileName}:${exportResult.rowCount}:${exportResult.csv.length}`;
    if (downloadedExport.current === fingerprint) return;
    downloadedExport.current = fingerprint;

    const url = URL.createObjectURL(
      // 前置 UTF-8 BOM，Excel 双击打开才不会把中文商品名/备注识别成乱码。
      new Blob(["\uFEFF" + exportResult.csv], {
        type: "text/csv;charset=utf-8;",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportResult.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [exportResult]);

  const openPlans = plans.filter((plan) => plan.status === "open");
  const unitsInOpenPlans = openPlans.reduce(
    (sum, plan) => sum + plan.lines.reduce((rowSum, line) => rowSum + line.quantity, 0),
    0,
  );
  const lineTotalLabel = (count: number) => `${formatQuantity(count)} line${count === 1 ? "" : "s"}`;

  return (
    <s-page heading="Purchase Plans">
      <s-section heading="How planning works">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Tick accepted or adjusted suggestions and create plans — lines are
            merged per supplier, quantities come from the numbers you confirmed
            on the Replenishment page. Adjust quantities, add a purchase date
            and notes, then mark the plan ordered: the matching suggestions move
            to Ordered too. Ordered and cancelled plans are kept as records and
            cannot be edited.
          </s-paragraph>
          {isRefreshing && <LoadingState label="Refreshing purchase plans…" />}
          <FactGrid
            facts={[
              {
                label: "Ready to plan",
                value: `${formatQuantity(pool.entries.length)} suggestions`,
              },
              {
                label: "Open plans",
                value: `${formatQuantity(openPlans.length)} of ${formatQuantity(plans.length)} shown`,
              },
              {
                label: "Units in open plans",
                value: formatQuantity(unitsInOpenPlans),
              },
            ]}
          />
          {unattributedError && (
            <s-banner tone="critical" heading="Couldn't continue">
              {unattributedError}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Ready to plan">
        <s-stack direction="block" gap="base">
          {pool.notice && (
            <s-banner tone="info" heading="Why the pool is empty">
              {pool.notice}
            </s-banner>
          )}
          {bucketError(BUCKETS.pool) && (
            <s-banner tone="critical" heading="Couldn't create plans">
              {bucketError(BUCKETS.pool)}
            </s-banner>
          )}
          {bucketNotice(BUCKETS.pool) && (
            <s-banner tone="success" heading="Plans created">
              {bucketNotice(BUCKETS.pool)}
            </s-banner>
          )}
          {pool.entries.length === 0 ? (
            <EmptyState
              heading="No suggestions are ready to plan"
              body="Purchase plans are built from suggestions you accepted or adjusted on the Replenishment page. Nothing is listed here until a suggestion has a confirmed quantity and isn't already part of an open plan."
              action={
                <s-button href="/app/inventory" variant="secondary">
                  Open Replenishment
                </s-button>
              }
            />
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create-plans" />
              <s-stack direction="block" gap="base">
                {/* 计划行是「主标题 + 带标签字段」的多列内容，和补货工作清单一样用
                    list 形态；窄屏折成清单，宽屏保持列对齐，不靠自定义表格壳。 */}
                <s-table variant="list">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Product / SKU
                    </s-table-header>
                    <s-table-header listSlot="labeled">Supplier</s-table-header>
                    <s-table-header listSlot="labeled">
                      Your quantity
                    </s-table-header>
                    <s-table-header listSlot="labeled">
                      System suggestion
                    </s-table-header>
                    <s-table-header listSlot="labeled">
                      Your decision
                    </s-table-header>
                    <s-table-header listSlot="inline">Include</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {pool.entries.map((entry) => (
                      <s-table-row key={entry.variantId}>
                        <s-table-cell>
                          {entry.productTitle} — {entry.variantTitle}
                          <br />
                          SKU: {entry.sku || MISSING}
                        </s-table-cell>
                        <s-table-cell>
                          {entry.supplierName ?? "Store default"}
                        </s-table-cell>
                        <s-table-cell>
                          {formatQuantity(entry.quantity)} units
                        </s-table-cell>
                        <s-table-cell>
                          {formatQuantity(entry.suggestedQuantity)} units
                        </s-table-cell>
                        <s-table-cell>
                          <StatusBadge state={entry.decisionStatus} />
                        </s-table-cell>
                        <s-table-cell>
                          {/* 列头已说明用途，视觉上不重复贴标签：用 accessibilityLabel
                              给读屏一句完整上下文（Polaris 里它会替代 label 的播报）。 */}
                          <s-checkbox
                            name="variantIds"
                            value={entry.variantId}
                            accessibilityLabel={`Include ${entry.productTitle} — ${entry.variantTitle} in new plans`}
                            disabled={bucketIsBusy(BUCKETS.pool)}
                          />
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
                <s-stack direction="block" gap="small">
                  <s-button
                    type="submit"
                    variant="primary"
                    disabled={bucketIsBusy(BUCKETS.pool)}
                    {...(bucketIsBusy(BUCKETS.pool) ? { loading: true } : {})}
                  >
                    Create plans from selected
                  </s-button>
                  <s-paragraph>
                    Tick at least one row. Lines are merged into one plan per
                    supplier; suggestions already in an open plan stay out of
                    this list.
                  </s-paragraph>
                </s-stack>
              </s-stack>
            </fetcher.Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Plans (${plans.length})`}>
        <s-stack direction="block" gap="base">
          {plans.length === 0 ? (
            <EmptyState
              heading="No purchase plans yet"
              body="A plan is a supplier-level purchase list built from the suggestions above. Create one and it appears here with its lines, status and CSV export."
            />
          ) : (
            <>
              <s-stack direction="inline" gap="small">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="export-csv" />
                  <s-button
                    type="submit"
                    disabled={bucketIsBusy(BUCKETS.export)}
                    {...(bucketIsBusy(BUCKETS.export) ? { loading: true } : {})}
                  >
                    Export all plans (CSV)
                  </s-button>
                </fetcher.Form>
                <s-paragraph>
                  {formatQuantity(plans.length)} plan
                  {plans.length === 1 ? "" : "s"} shown (newest first).
                </s-paragraph>
              </s-stack>
              {bucketError(BUCKETS.export) && (
                <s-banner tone="critical" heading="Export not completed">
                  {bucketError(BUCKETS.export)}
                </s-banner>
              )}
              {bucketNotice(BUCKETS.export) && exportResult && (
                <s-banner tone="success" heading="Export ready">
                  Downloaded {formatQuantity(exportResult.rowCount)} plan line
                  {exportResult.rowCount === 1 ? "" : "s"} to{" "}
                  {exportResult.fileName}. If your browser blocked the download,
                  allow automatic downloads for this app.
                </s-banner>
              )}
            </>
          )}
        </s-stack>
      </s-section>

      {plans.map((plan) => {
        const isOpen = plan.status === "open";
        const totalUnits = plan.lines.reduce(
          (sum, line) => sum + line.quantity,
          0,
        );
        return (
          <s-section
            key={plan.id}
            heading={`${plan.reference} · ${plan.supplierName ?? "Store default"}`}
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small">
                <PlanStatusBadge status={plan.status} />
                <s-text type="strong">
                  {lineTotalLabel(plan.lines.length)} ·{" "}
                  {formatQuantity(totalUnits)} units
                </s-text>
              </s-stack>
              <FactGrid
                facts={[
                  {
                    label: "Created",
                    value: formatDateTime(plan.createdAt, timeZone),
                  },
                  {
                    label: "Purchase date",
                    value: plan.purchaseDate
                      ? formatDate(plan.purchaseDate, timeZone)
                      : MISSING,
                  },
                  {
                    label: "Marked ordered",
                    value: plan.orderedAt
                      ? formatDateTime(plan.orderedAt, timeZone)
                      : MISSING,
                  },
                ]}
              />

              {planError(plan.id, BUCKETS.lines) && (
                <s-banner tone="critical" heading="Line not changed">
                  {planError(plan.id, BUCKETS.lines)}
                </s-banner>
              )}
              {planNotice(plan.id, BUCKETS.lines) && (
                <s-banner tone="success" heading="Line updated">
                  {planNotice(plan.id, BUCKETS.lines)}
                </s-banner>
              )}

              {plan.lines.length === 0 ? (
                <EmptyState
                  heading="This plan has no lines anymore"
                  body="Every line was removed or sent back to the planning pool. Cancel the plan to clear it from the open list; the record stays available for export."
                />
              ) : (
                <s-table variant="list">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Product / SKU
                    </s-table-header>
                    <s-table-header listSlot="labeled">
                      Quantity
                    </s-table-header>
                    <s-table-header listSlot="labeled">
                      Unit cost
                    </s-table-header>
                    <s-table-header listSlot="inline">
                      Line actions
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {plan.lines.map((line) => (
                      <s-table-row key={line.id}>
                        <s-table-cell>
                          {line.productTitle} — {line.variantTitle}
                          <br />
                          SKU: {line.sku || MISSING}
                        </s-table-cell>
                        <s-table-cell>
                          {isOpen ? (
                            <fetcher.Form method="post">
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
                              <s-stack direction="inline" gap="small">
                                {/* 列头已写 Quantity，字段标签只给读屏（exclusive），
                                    避免同一屏出现两个「Quantity」。 */}
                                <s-number-field
                                  name="quantity"
                                  label={`Quantity for ${line.productTitle} — ${line.variantTitle}`}
                                  labelAccessibilityVisibility="exclusive"
                                  defaultValue={String(line.quantity)}
                                  min={MIN_PLAN_QUANTITY}
                                  step={1}
                                  inputMode="numeric"
                                  required
                                  disabled={planIsBusy(plan.id, BUCKETS.lines)}
                                />
                                <s-button
                                  type="submit"
                                  variant="tertiary"
                                  disabled={planIsBusy(plan.id, BUCKETS.lines)}
                                >
                                  {planIsBusy(plan.id, BUCKETS.lines)
                                    ? "Working…"
                                    : "Save"}
                                </s-button>
                              </s-stack>
                            </fetcher.Form>
                          ) : (
                            <s-text type="strong">
                              {formatQuantity(line.quantity)} units
                            </s-text>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          {formatMoney(line.unitCost, currencyCode)}
                        </s-table-cell>
                        <s-table-cell>
                          {isOpen ? (
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
                              <s-button
                                type="submit"
                                variant="tertiary"
                                disabled={planIsBusy(plan.id, BUCKETS.lines)}
                              >
                                Remove
                              </s-button>
                            </fetcher.Form>
                          ) : (
                            <s-text>{MISSING}</s-text>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}

              {planError(plan.id, BUCKETS.meta) && (
                <s-banner tone="critical" heading="Plan details not saved">
                  {planError(plan.id, BUCKETS.meta)}
                </s-banner>
              )}
              {planNotice(plan.id, BUCKETS.meta) && (
                <s-banner tone="success" heading="Plan details saved">
                  {planNotice(plan.id, BUCKETS.meta)}
                </s-banner>
              )}

              {isOpen && (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="update-meta" />
                  <input type="hidden" name="planId" value={plan.id} />
                  <s-stack direction="block" gap="base">
                    <s-grid
                      gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
                      gap="base"
                    >
                      <s-date-field
                        name="purchaseDate"
                        label="Purchase date"
                        details="The date you intend to place this order."
                        defaultValue={plan.purchaseDate ?? ""}
                        disabled={planIsBusy(plan.id, BUCKETS.meta)}
                      />
                      <s-text-area
                        name="notes"
                        label="Notes"
                        details={`Internal note for this plan, up to ${PLAN_NOTES_MAX_LENGTH} characters.`}
                        placeholder="e.g. ask for split delivery"
                        maxLength={PLAN_NOTES_MAX_LENGTH}
                        defaultValue={plan.notes ?? ""}
                        disabled={planIsBusy(plan.id, BUCKETS.meta)}
                      />
                    </s-grid>
                    <s-button
                      type="submit"
                      variant="secondary"
                      disabled={planIsBusy(plan.id, BUCKETS.meta)}
                      {...(planIsBusy(plan.id, BUCKETS.meta)
                        ? { loading: true }
                        : {})}
                    >
                      Save details
                    </s-button>
                  </s-stack>
                </fetcher.Form>
              )}

              <s-stack direction="inline" gap="small">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="export-csv" />
                  <input type="hidden" name="planId" value={plan.id} />
                  <s-button
                    type="submit"
                    variant="tertiary"
                    disabled={isBusy}
                  >
                    {planIsBusy(plan.id, BUCKETS.export) ? "Working…" : "Export CSV"}
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
                        disabled={isBusy}
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
                      <input type="hidden" name="intent" value="cancel-plan" />
                      <input type="hidden" name="planId" value={plan.id} />
                      <s-button
                        type="submit"
                        variant="tertiary"
                        disabled={isBusy}
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
              </s-stack>
              {!isOpen && (
                <s-paragraph>
                  This plan is closed and kept as a record, so its lines and
                  details can no longer be edited. Export it any time.
                </s-paragraph>
              )}
            </s-stack>
          </s-section>
        );
      })}

      <s-section heading="App navigation">
        <s-stack direction="inline" gap="base">
          <s-link href="/app/inventory">Replenishment</s-link>
          <s-link href="/app/suppliers">Suppliers</s-link>
          <s-link href="/app">Back to workspace</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

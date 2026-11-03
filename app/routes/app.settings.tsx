import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import type { Session } from "@shopify/shopify-app-react-router/server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { trackEvent } from "../analytics.server";
import { toSafeError } from "../lib/app-error";
import { safeLoader } from "../lib/route-error";
import {
  DEFAULT_REPLENISHMENT_SETTINGS,
  REPLENISHMENT_LIMITS,
  validateReplenishmentSettings,
  type ReplenishmentFieldName,
} from "../lib/settings-validation";
import { formatDate, formatDateTime } from "../lib/format";
import { saveReplenishmentSettings } from "../inventory.server";
import { testModelConnection } from "../pi.server";
import {
  getModelConfigurationStatus,
  ProductCopyError,
} from "../product-copy.server";
import { FactGrid } from "../components/ui/fact-grid";
import { LoadingState } from "../components/ui/loading-state";
import { ReadinessBadge } from "../components/ui/status-badge";

/**
 * 「谁能测模型连接」的判定。online token 下保留「仅店主」限制；
 * 应用当前以 offline token 运行，`onlineAccessInfo` 恒为 undefined —— 旧实现把
 * 这判成「谁都不能测」，测试入口永不渲染（缺陷 #9）。offline 会话是店铺级
 * 服务凭证，能进入后台嵌入页的已经是被 Shopify 后台授权的管理员，视同允许。
 */
function resolveCanTestModel(session: Session): boolean {
  if (session.onlineAccessInfo) {
    return session.onlineAccessInfo.associated_user.account_owner === true;
  }
  return true;
}

/** Settings 页数据：补货参数（含来源标注）、同步状态、模型服务状态与权限判定。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settingsRow = await db.inventorySettings.findUnique({
    where: { shop: session.shop },
  });

  return {
    model: getModelConfigurationStatus(),
    canTestModel: resolveCanTestModel(session),
    general: {
      shop: session.shop,
      locationName: settingsRow?.locationName ?? null,
      timezone: settingsRow?.timezone ?? "UTC",
      currencyCode: settingsRow?.currencyCode ?? "USD",
    },
    replenishment: {
      leadTimeDays:
        settingsRow?.leadTimeDays ?? DEFAULT_REPLENISHMENT_SETTINGS.leadTimeDays,
      safetyStockDays:
        settingsRow?.safetyStockDays ??
        DEFAULT_REPLENISHMENT_SETTINGS.safetyStockDays,
      reviewPeriodDays:
        settingsRow?.reviewPeriodDays ??
        DEFAULT_REPLENISHMENT_SETTINGS.reviewPeriodDays,
      savedAt: settingsRow?.replenishmentSettingsSavedAt ?? null,
    },
    // 时间戳原样交给页面，由 lib/format 按商店时区渲染——服务端预拼 UTC 字符串
    // 会让商家看到一个和自己营业时区错位的时间（spec §10）。
    sync: {
      lastInventorySyncAt: settingsRow?.lastInventorySyncAt ?? null,
      lastSalesSyncAt: settingsRow?.lastSalesSyncAt ?? null,
      salesHistoryComplete: settingsRow?.salesHistoryComplete ?? false,
      salesWindowStart: settingsRow?.salesWindowStart ?? null,
    },
  };
});

/** 两类操作：保存补货参数（校验后落库并按需重算）、测试模型连接。 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-replenishment") {
    const validation = validateReplenishmentSettings({
      leadTimeDays: formData.get("leadTimeDays"),
      safetyStockDays: formData.get("safetyStockDays"),
      reviewPeriodDays: formData.get("reviewPeriodDays"),
    });
    if (!validation.ok) {
      return { fieldErrors: validation.errors };
    }
    try {
      const result = await saveReplenishmentSettings(
        session.shop,
        validation.value,
      );
      trackEvent(session.shop, "settings_saved", {
        section: "replenishment",
        changed: result.changed,
      });
      return { saved: validation.value, recalculation: result };
    } catch (error) {
      const safe = toSafeError(error);
      console.error("[mypi] replenishment settings save failed", {
        kind: safe.kind,
        detail: safe.detail,
      });
      return { error: safe.message, errorKind: safe.kind };
    }
  }

  if (intent === "test-model") {
    if (
      session.onlineAccessInfo &&
      session.onlineAccessInfo.associated_user.account_owner !== true
    ) {
      return { error: "Only the store owner can test the model connection." };
    }

    try {
      await testModelConnection();
      const { provider, model } = getModelConfigurationStatus();
      return { connection: { provider, model, passed: true } };
    } catch (error) {
      const safe = toSafeError(error);
      console.error("[mypi] model connection test failed", {
        code: error instanceof ProductCopyError ? error.code : safe.kind,
        detail: safe.detail,
      });
      return { error: safe.message, errorKind: safe.kind };
    }
  }

  return { error: "Unsupported operation." };
};

const FIELD_LABELS: Record<ReplenishmentFieldName, string> = {
  leadTimeDays: "Supplier lead time",
  safetyStockDays: "Safety stock buffer",
  reviewPeriodDays: "Purchase review cycle",
};

const FIELD_HINTS: Record<ReplenishmentFieldName, string> = {
  leadTimeDays:
    "Days between placing an order with your supplier and receiving stock.",
  safetyStockDays:
    "Extra days of demand kept as buffer against delays and spikes.",
  reviewPeriodDays:
    "How often you place purchase orders; advice covers demand until the next review.",
};

const REPLENISHMENT_FIELDS: ReplenishmentFieldName[] = [
  "leadTimeDays",
  "safetyStockDays",
  "reviewPeriodDays",
];

/** Settings 页：General / Inventory Settings / Supplier Settings / AI Configuration / Data Synchronization 五段。 */
export default function SettingsPage() {
  const { model, canTestModel, general, replenishment, sync } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  const data = fetcher.data;
  const fieldErrors =
    data && "fieldErrors" in data ? data.fieldErrors : undefined;
  const saved = data && "saved" in data ? data.saved : undefined;
  const recalculation =
    data && "recalculation" in data ? data.recalculation : undefined;
  const connection =
    data && "connection" in data ? data.connection : undefined;
  const error = data && "error" in data ? data.error : undefined;

  // 结果只跟着「刚刚提交的那一段」出现：补货参数报错不该盖在模型配置下面。
  const currentIntent = fetcher.formData?.get("intent");
  const saveSectionBusy = isBusy && currentIntent === "save-replenishment";
  const testSectionBusy = isBusy && currentIntent === "test-model";
  const saveErrored =
    error !== undefined && currentIntent === "save-replenishment";
  const testErrored = error !== undefined && currentIntent === "test-model";

  const configured = model.valid && model.configured;
  const parametersAreCustom = replenishment.savedAt !== null;
  const timeZone = general.timezone;

  return (
    <s-page heading="Settings">
      <s-section heading="General">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Replenishment parameters, supplier data, model service and
            synchronization for this store.
          </s-paragraph>
          <FactGrid
            facts={[
              { label: "Store domain", value: general.shop },
              {
                label: "Primary location",
                value: general.locationName ?? "Not selected yet",
              },
              {
                label: "Timezone / currency",
                value: `${general.timezone} · ${general.currencyCode}`,
              },
            ]}
          />
          <s-paragraph>
            Timezone and currency follow the Shopify store settings; the order
            date boundary used by advice is shown on Data health.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Inventory settings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <ReadinessBadge
              kind={parametersAreCustom ? "storeSettings" : "systemEstimate"}
            />
          </s-paragraph>
          <s-paragraph>
            These parameters drive reorder advice. Saving changed values
            recalculates the calculation basis of advice rows on the current
            snapshot; quantities and statuses you already decided on are never
            overwritten.
          </s-paragraph>
          {saveSectionBusy && <LoadingState label="Saving settings…" />}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="save-replenishment" />
            <s-stack direction="block" gap="base">
              <s-grid
                gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                gap="base"
              >
                {REPLENISHMENT_FIELDS.map((field) => (
                  <s-number-field
                    key={field}
                    name={field}
                    label={`${FIELD_LABELS[field]} (days)`}
                    details={FIELD_HINTS[field]}
                    error={fieldErrors?.[field]}
                    min={REPLENISHMENT_LIMITS[field].min}
                    max={REPLENISHMENT_LIMITS[field].max}
                    step={1}
                    required
                    disabled={saveSectionBusy}
                    defaultValue={String(replenishment[field])}
                  />
                ))}
              </s-grid>
              <s-button
                type="submit"
                variant="primary"
                disabled={saveSectionBusy}
                {...(saveSectionBusy ? { loading: true } : {})}
              >
                Save settings
              </s-button>
            </s-stack>
          </fetcher.Form>
          {saved && (
            <s-banner tone="success" heading="Settings saved">
              {recalculation?.changed
                ? `Reorder advice recalculated (${
                    recalculation.registered + recalculation.refreshed
                  } advice rows refreshed).`
                : "Values matched what was already stored, so nothing was recalculated."}
            </s-banner>
          )}
          {saveErrored && error && (
            <s-banner tone="critical" heading="Operation not completed">
              {error}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Supplier settings">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <ReadinessBadge kind="available" />
          </s-paragraph>
          <s-paragraph>
            Supplier profiles, per-SKU MOQ, case pack, unit cost and supplier
            lead times are managed on the{" "}
            <s-link href="/app/suppliers">Suppliers</s-link> page. Bound supply
            terms override the store-wide defaults above for those variants, and
            reorder quantities round up to full packs and minimum order
            quantities.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="AI configuration">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <ReadinessBadge
              kind={configured ? "configured" : "needsSetup"}
            />
          </s-paragraph>
          <s-paragraph>
            The model connection is configured by the app developer in the
            server environment. The API Key is never displayed, returned to the
            browser, or saved in shop data.
          </s-paragraph>
          <FactGrid
            facts={[
              { label: "Provider", value: model.provider },
              { label: "Model", value: model.model },
              {
                label: "API Key",
                value: !model.valid
                  ? "Invalid configuration"
                  : model.configured
                    ? "Configured on the server"
                    : "Needs setup",
              },
            ]}
          />
          {!configured && (
            <s-banner tone="warning" heading="Model service needs setup">
              Set <code>PI_API_KEY</code> in the environment where the service
              runs. Model requests may incur Provider costs. This build saves
              copy task history only; daily statistics and in-app quota
              management are not included yet.
            </s-banner>
          )}
          {testSectionBusy && <LoadingState label="Testing model connection…" />}
          {canTestModel ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="test-model" />
              <s-button
                type="submit"
                variant="secondary"
                disabled={testSectionBusy}
                {...(testSectionBusy ? { loading: true } : {})}
              >
                Test model connection
              </s-button>
            </fetcher.Form>
          ) : (
            <s-paragraph>
              Only the store owner can start a model connection test.
            </s-paragraph>
          )}
          {connection?.passed && (
            <s-banner tone="success" heading="Model connection passed">
              {connection.provider}/{connection.model} connected successfully.
              This test did not create a product draft.
            </s-banner>
          )}
          {testErrored && error && (
            <s-banner tone="critical" heading="Operation not completed">
              {error}
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Data synchronization">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Inventory and sales data refresh on a background schedule, on
            Shopify webhooks, and when you run Sync on the Replenishment page.
            Raw payloads are only invalidation signals — numbers are always
            re-read from the Shopify Admin API.
          </s-paragraph>
          <FactGrid
            facts={[
              {
                label: "Last inventory sync",
                value: formatDateTime(sync.lastInventorySyncAt, timeZone),
              },
              {
                label: "Last sales sync",
                value: formatDateTime(sync.lastSalesSyncAt, timeZone),
              },
              {
                label: "Sales history coverage",
                value:
                  sync.salesHistoryComplete && sync.salesWindowStart
                    ? `Full history from ${formatDate(sync.salesWindowStart, timeZone)}`
                    : sync.salesWindowStart
                      ? `Recent window from ${formatDate(
                          sync.salesWindowStart,
                          timeZone,
                        )} (60-day limit under current approval)`
                      : "Not synced yet",
              },
            ]}
          />
          <s-paragraph>
            Check per-check diagnosis and the ledger of every sync run on{" "}
            <s-link href="/app/data-health">Data health</s-link>.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

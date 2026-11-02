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
import { saveReplenishmentSettings } from "../inventory.server";
import { testModelConnection } from "../pi.server";
import {
  getModelConfigurationStatus,
  ProductCopyError,
} from "../product-copy.server";

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

/** 把同步时间戳收成商家可读的一行文本；没跑过就如实说没跑过，不留空白猜测。 */
function formatSyncStamp(value: Date | null): string {
  return value ? `${value.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Never";
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
    sync: {
      lastInventorySyncAt: formatSyncStamp(settingsRow?.lastInventorySyncAt ?? null),
      lastSalesSyncAt: formatSyncStamp(settingsRow?.lastSalesSyncAt ?? null),
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

  const configured = model.valid && model.configured;
  const parametersAreCustom = replenishment.savedAt !== null;

  return (
    <s-page heading="Settings">
      <div className="workspace secondaryWorkspace">
        <div className="pageIntro">
          <span className="eyebrow">Service configuration</span>
          <h1>Settings</h1>
          <p>
            Manage replenishment parameters, supplier data, model service and
            synchronization for this store.
          </p>
        </div>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ◦
              </span>
              <h2>General</h2>
            </div>
          </div>
          <dl className="settingsDetails">
            <div>
              <dt>Store domain</dt>
              <dd>{general.shop}</dd>
            </div>
            <div>
              <dt>Primary location</dt>
              <dd>{general.locationName ?? "Not selected yet"}</dd>
            </div>
            <div>
              <dt>Timezone / currency</dt>
              <dd>
                {general.timezone} · {general.currencyCode}
              </dd>
            </div>
          </dl>
          <p className="settingsHelp">
            Timezone and currency follow the Shopify store settings; the order
            date boundary used by advice is shown on Data health.
          </p>
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ⟳
              </span>
              <h2>Inventory settings</h2>
            </div>
            <span
              className={`connectionPill ${
                parametersAreCustom ? "isConfigured" : "needsSetup"
              }`}
            >
              <span aria-hidden="true">●</span>
              {parametersAreCustom ? "Store settings" : "System estimate"}
            </span>
          </div>
          <p>
            These parameters drive reorder advice. Saving changed values
            recalculates the calculation basis of advice rows on the current
            snapshot; quantities and statuses you already decided on are never
            overwritten.
          </p>
          <fetcher.Form method="post" className="settingsForm">
            <input type="hidden" name="intent" value="save-replenishment" />
            <div className="settingsFieldGrid">
              {(
                [
                  ["leadTimeDays", replenishment.leadTimeDays],
                  ["safetyStockDays", replenishment.safetyStockDays],
                  ["reviewPeriodDays", replenishment.reviewPeriodDays],
                ] as const
              ).map(([field, value]) => (
                <label className="settingsField" key={field}>
                  <span>{FIELD_LABELS[field]} (days)</span>
                  <input
                    type="number"
                    name={field}
                    min={REPLENISHMENT_LIMITS[field].min}
                    max={REPLENISHMENT_LIMITS[field].max}
                    step="1"
                    required
                    disabled={isBusy}
                    defaultValue={value}
                    aria-invalid={fieldErrors?.[field] ? "true" : undefined}
                  />
                  <em>{
                    fieldErrors?.[field] ?? FIELD_HINTS[field]
                  }</em>
                </label>
              ))}
            </div>
            <s-button
              type="submit"
              variant="primary"
              disabled={isBusy}
              {...(isBusy ? { loading: true } : {})}
            >
              Save settings
            </s-button>
          </fetcher.Form>
          {saved && (
            <div className="settingsSuccess">
              Saved.{" "}
              {recalculation?.changed
                ? `Reorder advice recalculated (${
                    recalculation.registered + recalculation.refreshed
                  } advice rows refreshed).`
                : "Values matched what was already stored, so nothing was recalculated."}
            </div>
          )}
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ▤
              </span>
              <h2>Supplier settings</h2>
            </div>
            <span className="connectionPill isConfigured">
              <span aria-hidden="true">●</span>Available
            </span>
          </div>
          <p>
            Supplier profiles, per-SKU MOQ, case pack, unit cost and supplier
            lead times are managed on the <a href="/app/suppliers">Suppliers</a>{" "}
            page. Bound supply terms override the store-wide defaults above for
            those variants, and reorder quantities round up to full packs and
            minimum order quantities.
          </p>
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ⚙
              </span>
              <h2>AI configuration</h2>
            </div>
            <span
              className={`connectionPill ${configured ? "isConfigured" : "needsSetup"}`}
            >
              <span aria-hidden="true">●</span>
              {configured ? "Configured" : "Needs setup"}
            </span>
          </div>
          <p>
            The model connection is configured by the app developer in the
            server environment. The API Key is never displayed, returned to the
            browser, or saved in shop data.
          </p>
          <dl className="settingsDetails">
            <div>
              <dt>Provider</dt>
              <dd>{model.provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{model.model}</dd>
            </div>
            <div>
              <dt>API Key</dt>
              <dd>
                {!model.valid
                  ? "Invalid configuration"
                  : model.configured
                    ? "Configured on the server"
                    : "Needs setup"}
              </dd>
            </div>
          </dl>
          {!configured && (
            <div className="settingsNotice">
              Set <code>PI_API_KEY</code> in the environment where the service
              runs. Model requests may incur Provider costs. This build saves
              copy task history only; daily statistics and in-app quota
              management are not included yet.
            </div>
          )}
          {canTestModel ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="test-model" />
              <s-button
                type="submit"
                disabled={isBusy}
                {...(isBusy ? { loading: true } : {})}
              >
                Test model connection
              </s-button>
            </fetcher.Form>
          ) : (
            <p className="settingsHelp">
              Only the store owner can start a model connection test.
            </p>
          )}
          {connection?.passed && (
            <div className="settingsSuccess">
              {connection.provider}/{connection.model} connected successfully.
              This test did not create a product draft.
            </div>
          )}
        </section>

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="sectionGlyph" aria-hidden="true">
                ▣
              </span>
              <h2>Data synchronization</h2>
            </div>
          </div>
          <p>
            Inventory and sales data refresh on a background schedule, on
            Shopify webhooks, and when you run Sync on the Replenishment page.
            Raw payloads are only invalidation signals — numbers are always
            re-read from the Shopify Admin API.
          </p>
          <dl className="settingsDetails">
            <div>
              <dt>Last inventory sync</dt>
              <dd>{sync.lastInventorySyncAt}</dd>
            </div>
            <div>
              <dt>Last sales sync</dt>
              <dd>{sync.lastSalesSyncAt}</dd>
            </div>
            <div>
              <dt>Sales history coverage</dt>
              <dd>
                {sync.salesHistoryComplete && sync.salesWindowStart
                  ? `Full history from ${sync.salesWindowStart}`
                  : sync.salesWindowStart
                    ? `Recent window from ${sync.salesWindowStart} (60-day limit under current approval)`
                    : "Not synced yet"}
              </dd>
            </div>
          </dl>
          <p className="settingsHelp">
            Check per-check diagnosis and the ledger of every sync run on{" "}
            <a href="/app/data-health">Data health</a>.
          </p>
        </section>

        {error && <div className="settingsError">{error}</div>}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

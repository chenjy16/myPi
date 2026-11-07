import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { AUTOMATION_ENABLED } from "../features";
import { getShopBetaMetrics, trackDailyVisit } from "../analytics.server";
import { safeLoader } from "../lib/route-error";
import { formatRate, humanizeDurationMs } from "../lib/analytics";
import { formatDate } from "../lib/format";

/**
 * Beta 指标看板：只呈现**当前这家店**自己的埋点推导结果，绝不跨店。
 * 数据全部来自 lib/analytics 的纯函数，口径与采集同源；缺的事件一律显示 “—”，不编造数字。
 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  if (AUTOMATION_ENABLED) throw redirect("/app");
  const { session } = await authenticate.admin(request);
  // 访问本页本身也刷新「日活心跳」，与 dashboard_viewed 的每店每天一条口径一致。
  void trackDailyVisit(session.shop);
  const [beta, storeMeta] = await Promise.all([
    getShopBetaMetrics(session.shop),
    // 安装日期按商店时区展示：自己拼 UTC 串会让商家看到错位的一天（§4）。
    db.inventorySettings.findFirst({
      where: { shop: session.shop },
      select: { timezone: true },
    }),
  ]);
  return { shop: session.shop, ...beta, timeZone: storeMeta?.timezone ?? null };
});

/** 三态文案：true / false / null（样本不足，不下结论）。 */
function yesNoUnknown(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "Yes" : "Not yet";
}

export default function MetricsPage() {
  const {
    metrics,
    installedAt,
    weeklyActive,
    retainedDay7,
    retainedDay30,
    eventCount,
    timeZone,
  } = useLoaderData<typeof loader>();

  const cards = [
    {
      label: "Activated",
      value: metrics.activated ? "Yes" : "Not yet",
      note: "At least one successful sync has completed.",
      tone: "toneGreen",
      icon: "✓",
    },
    {
      label: "Time to first value",
      value: humanizeDurationMs(metrics.timeToFirstValueMs),
      note: "Install → first accepted suggestion.",
      tone: "toneBlue",
      icon: "◷",
    },
    {
      label: "Advice adoption",
      value: formatRate(metrics.adoptionRate),
      note: `${metrics.decisionCount} decision${
        metrics.decisionCount === 1 ? "" : "s"
      } (accept + adjust share).`,
      tone: "tonePurple",
      icon: "▣",
    },
    {
      label: "Sync success",
      value: formatRate(metrics.syncSuccessRate),
      note: "Successful syncs over all syncs with an outcome.",
      tone: "toneRed",
      icon: "↻",
    },
  ];

  return (
    <s-page heading="Beta Metrics">
      <s-section heading="This store">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            These numbers come only from <strong>this store’s</strong> own product
            events. Nothing here is aggregated across other merchants.
          </s-paragraph>
          {/* 指标卡与 Home 同源：dsMetrics 是 §1 豁免的合法业务展示层，不重复造轮子 */}
          <section className="dsMetrics" aria-label="Beta metrics">
            {cards.map((card) => (
              <article className="dsMetric" key={card.label}>
                <span className={`dsMetricIcon ${card.tone}`} aria-hidden="true">
                  {card.icon}
                </span>
                <div className="dsMetricBody">
                  <span className="dsMetricLabel">{card.label}</span>
                  <strong className="dsMetricValue">{card.value}</strong>
                  <span className="dsMetricTrend isPlain">{card.note}</span>
                </div>
              </article>
            ))}
          </section>
        </s-stack>
      </s-section>

      <s-section heading="Engagement & retention">
        <s-table variant="list">
          <s-table-header-row>
            <s-table-header listSlot="primary">Signal</s-table-header>
            <s-table-header listSlot="labeled">Value</s-table-header>
          </s-table-header-row>
          <s-table-body>
            <s-table-row>
              <s-table-cell>Weekly active (last 7 days)</s-table-cell>
              <s-table-cell>{yesNoUnknown(weeklyActive)}</s-table-cell>
            </s-table-row>
            <s-table-row>
              <s-table-cell>Installed on</s-table-cell>
              <s-table-cell>{formatDate(installedAt, timeZone)}</s-table-cell>
            </s-table-row>
            <s-table-row>
              <s-table-cell>Retained day 7</s-table-cell>
              <s-table-cell>{yesNoUnknown(retainedDay7)}</s-table-cell>
            </s-table-row>
            <s-table-row>
              <s-table-cell>Retained day 30</s-table-cell>
              <s-table-cell>{yesNoUnknown(retainedDay30)}</s-table-cell>
            </s-table-row>
          </s-table-body>
        </s-table>
        <s-paragraph>
          Retention anchors on the install date; a “—” means there is not enough
          history yet to judge it. Based on {eventCount} recorded event
          {eventCount === 1 ? "" : "s"} — early samples are expected to be small.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

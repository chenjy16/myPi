import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getShopBetaMetrics, trackDailyVisit } from "../analytics.server";
import { safeLoader } from "../lib/route-error";
import { formatRate, humanizeDurationMs } from "../lib/analytics";

/**
 * Beta 指标看板：只呈现**当前这家店**自己的埋点推导结果，绝不跨店。
 * 数据全部来自 lib/analytics 的纯函数，口径与采集同源；缺的事件一律显示 “—”，不编造数字。
 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // 访问本页本身也刷新「日活心跳」，与 dashboard_viewed 的每店每天一条口径一致。
  void trackDailyVisit(session.shop);
  const beta = await getShopBetaMetrics(session.shop);
  return { shop: session.shop, ...beta };
});

/** 三态文案：true / false / null（样本不足，不下结论）。 */
function yesNoUnknown(value: boolean | null): string {
  if (value === null) return "—";
  return value ? "Yes" : "Not yet";
}

function formatDay(value: Date | null): string {
  if (!value) return "—";
  return `${value.toISOString().slice(0, 10)} UTC`;
}

export default function MetricsPage() {
  const { metrics, installedAt, weeklyActive, retainedDay7, retainedDay30, eventCount } =
    useLoaderData<typeof loader>();

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
    <div className="ds">
      <s-page heading="Beta Metrics">
        <s-section heading="This store">
          <p className="dsEmptyRow">
            These numbers come only from <strong>this store’s</strong> own product
            events. Nothing here is aggregated across other merchants.
          </p>
        </s-section>

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

        <s-section heading="Engagement & retention">
          <div className="dsTableWrap">
            <table className="dsTable">
              <tbody>
                <tr>
                  <th>Weekly active (last 7 days)</th>
                  <td>{yesNoUnknown(weeklyActive)}</td>
                </tr>
                <tr>
                  <th>Installed on</th>
                  <td>{formatDay(installedAt)}</td>
                </tr>
                <tr>
                  <th>Retained day 7</th>
                  <td>{yesNoUnknown(retainedDay7)}</td>
                </tr>
                <tr>
                  <th>Retained day 30</th>
                  <td>{yesNoUnknown(retainedDay30)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="dsEmptyRow">
            Retention anchors on the install date; a “—” means there is not enough
            history yet to judge it. Based on {eventCount} recorded event
            {eventCount === 1 ? "" : "s"} — early samples are expected to be small.
          </p>
        </s-section>
      </s-page>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

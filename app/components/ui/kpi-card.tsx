/**
 * Dashboard 首屏 KPI 卡片（UI Alignment R1-B1）。
 * 视觉走 dashboard.css 已存在的 .dsMetric 系列（Sprint 6 收口的 ds 业务层），
 * 组件只负责装配结构与 tone 类名，页面不再自己拼 div 层级。
 * value 允许 string | number | null —— null 是"数据不足时诚实显示 N/A"的语义，
 * 由调用方保留到底（不预先折算成 0 或 100%），与 P4-17 health 降级口径一致。
 */
export type KpiCardTone = "tonePurple" | "toneRed" | "toneBlue" | "toneGreen";

export type KpiCardProps = {
  label: string;
  value: string | number | null;
  note?: string;
  tone: KpiCardTone;
  icon?: string;
  /** 提供则整卡走 s-link 语义；缺省则不可点，只作展示。 */
  href?: string;
};

/** 空值统一显示为 N/A 而不是 0，与 PRD §5.2 KPI Card 3 的诚实边界一致。 */
function displayValue(value: string | number | null): string {
  if (value === null) return "N/A";
  if (typeof value === "number") return value.toLocaleString("en-US");
  return value;
}

export function KpiCard({ label, value, note, tone, icon, href }: KpiCardProps) {
  const body = (
    <article className="dsMetric">
      <span className={`dsMetricIcon ${tone}`} aria-hidden="true">
        {icon ?? "▤"}
      </span>
      <div className="dsMetricBody">
        <span className="dsMetricLabel">{label}</span>
        <strong className="dsMetricValue">{displayValue(value)}</strong>
        {note ? <span className="dsMetricTrend isPlain">{note}</span> : null}
      </div>
    </article>
  );

  if (!href) return body;
  return <s-link href={href}>{body}</s-link>;
}

/**
 * 统一「进行中」反馈（spec §9 — 全站此前只有按钮级 loading，没有任何页面级反馈）。
 * 用 Polaris `s-spinner` 承载，不自造动画；文案同时给出，读屏能念出来。
 * 用法：配合 `useNavigation()` / `useFetcher().state`，在 pending 时渲染并禁用触发按钮。
 * 动画本身由 tokens.css 的 prefers-reduced-motion 规则统一降级。
 */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="dsLoading" role="status" aria-live="polite">
      <s-spinner size="base" accessibilityLabel={label} />
      {label}
    </span>
  );
}

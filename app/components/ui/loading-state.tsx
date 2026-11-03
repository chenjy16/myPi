/**
 * 统一进行中反馈（spec §9 — 全站此前完全缺失 Loading 态）。
 * 用法：配合 useNavigation()/useFetcher().state，在 pending 时渲染或禁用提交。
 * 动画尊重 tokens.css 的 prefers-reduced-motion 全局规则。
 */
export function LoadingState({ label = "Working…" }: { label?: string }) {
  return (
    <span className="dsLoading" role="status" aria-live="polite">
      <span className="dsLoadingSpinner" aria-hidden="true" />
      {label}
    </span>
  );
}

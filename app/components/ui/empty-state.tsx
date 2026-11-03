import type { ReactNode } from "react";

/**
 * 统一空状态（spec §9）：说明为什么没有数据 + 下一步做什么。
 * 不允许只有一句 "No data"。
 */
export function EmptyState({
  heading,
  body,
  action,
}: {
  heading: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="dsEmptyState" role="status">
      <p className="dsEmptyStateHeading">{heading}</p>
      <p className="dsEmptyStateBody">{body}</p>
      {action ? <div className="dsEmptyStateAction">{action}</div> : null}
    </div>
  );
}

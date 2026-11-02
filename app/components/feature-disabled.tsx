import { Link } from "react-router";

/**
 * 功能开关关闭时的显式停用页。
 * 模板时代这类页面会静默重定向，商家点进来只会看到一次无声跳转；
 * P1-9 要求明确告知“功能当前不可用”，并给出真实可去的地方。
 */
export function FeatureDisabledPage({
  heading,
  featureName,
}: {
  heading: string;
  featureName: string;
}) {
  return (
    <s-page heading={heading}>
      <s-section heading="Feature not available">
        <p className="dsEmptyRow">
          <strong>{featureName}</strong> is not part of the current mypi
          release. Your existing drafts and history are kept untouched and will
          appear here again if the feature returns.
        </p>
        <p className="dsEmptyRow">
          Need this feature in your day-to-day purchasing? Send the team a note
          through{" "}
          <Link to="/app/docs" style={{ fontWeight: 700 }}>
            Guide &amp; docs
          </Link>{" "}
          — feedback volume decides what we build next. Meanwhile the
          replenishment workflow is fully available:
        </p>
        <p className="dsEmptyRow">
          <Link to="/app/inventory">Open Replenishment →</Link>
        </p>
      </s-section>
    </s-page>
  );
}

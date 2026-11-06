// P4-06：写 scope 缺口引导横幅。三个入口（列表 / 详情 / 向导）共用同一份文案与跳转，
// 保证「未重授权前相关自动化不运行」的诚实边界在 UI 层只有一份口径。
// 只吃 ScopeGap 纯结构 + shop 域名，不查库、不读 session——路由 loader 负责装配。
// href 走 /auth?shop=<domain>：Shopify 库内嵌 OAuth 会把 iframe 提升到 top 完成再授权，
// 这是本项目既有的重授权入口（见 app/shopify.server.ts authPathPrefix="/auth"）。
import type { ScopeGap } from "../../lib/scope-guard";

export type ScopeGapBannerProps = {
  gap: ScopeGap;
  shopDomain: string;
};

export function ScopeGapBanner({ gap, shopDomain }: ScopeGapBannerProps) {
  if (gap.ok) return null;
  const href = `/auth?shop=${encodeURIComponent(shopDomain)}`;
  return (
    <s-banner tone="critical" heading="Store access needed">
      <s-stack direction="block" gap="small">
        <s-paragraph>
          These automations need write permissions your store hasn&rsquo;t
          granted yet:{" "}
          <s-text type="strong">{gap.missing.join(", ")}</s-text>. Until you
          reauthorize, any automation using them is listed here but does not
          run &mdash; we won&rsquo;t pretend otherwise.
        </s-paragraph>
        <s-stack direction="inline" gap="small">
          <s-link href={href}>Reauthorize</s-link>
          <s-paragraph>
            You&rsquo;ll be asked to approve the additional scopes; nothing else
            changes.
          </s-paragraph>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

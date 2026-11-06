# P4-08 · Shopify App Store 上架预检（Phase 4 K4）

对全代码库跑 `shopify-app-store-review` 预检，逐项对照 [最新要求清单](https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements)。结论落本文件；高危项当场闭环，外部动作（TLS/正式提交）标注不伪造。

## Summary

- ✅ **Likely passing:** 主要可代码核验项（见下）
- ❌ **Likely failing:** 0
- ⚠️ **Needs review:** 2（2.3.1 手动域名表单、3.1.1 TLS 证书）
- ⏭️ **Groups skipped:** 多数 category-specific 组（无对应 extension）

## ✅ Likely passing（有正向代码证据）

| 要求 | 证据 |
| --- | --- |
| 1.1.1 session tokens 认证 | `@shopify/app-bridge-react@4.2.4` + `@shopify/shopify-app-react-router@3.0.1`；`AppProvider`（app.tsx）；`grep localStorage / document.cookie / js-cookie` 在 `app/` **零命中** |
| 1.1.2 走 Shopify checkout | 无外链 checkout/支付逻辑（应用是库存决策后台，不碰下单） |
| 1.1.3 不下载主题 | 无 Themes/Assets API 建/传主题调用（`grep themes\.` 零命中） |
| 2.2.1 使用 Shopify API | `shopifyApp(...)` + `authenticate.admin` + Admin GraphQL 全链路 |
| 2.2.3 最新 App Bridge | 官方 `@shopify/app-bridge-react@^4.2.4`；无 legacy `@shopify/app-bridge` |
| 2.2.4 GraphQL Admin API | 全用 `admin.graphql`；`grep /admin/api/...json` **零命中**（无 REST） |
| 3.2.1 read_all_orders 按需 | `app._index.tsx`/inventory 正确处理「无该 scope → 60 天窗口 + banner」，不默认请求 |
| 卸载删数据 | `webhooks.app.uninstalled.tsx` → `purgeShopBusinessData(shop)`（覆盖全部 V2 表） |
| 错误不泄栈 | `app.tsx` `describeRouteError`/`toSafeError`：堆栈与上游原文一律不下发，仅分类文案 + Reference 码 |
| 1.2 计费 | **无任何 billing 逻辑**（Beta 免费）；见下方 Needs review 附注 |

## ⚠️ Needs review

**⚠️ 2.3.1 Initiate installation from a Shopify-owned surface**

- **为什么要注意：** 要求「安装/配置流程中不得请求手动输入 myshopify.com 域名」。
- **检测到什么：** `app/routes/_index/route.tsx` 有一个手动输入 `xxx.myshopify.com` 的登录表单（仅当访问根 URL 且**无 `?shop` 参数**时显示，`showForm: Boolean(login)`）。真实 App Store 安装走 Shopify OAuth（`/auth/login?shop=`），不经过此表单；该表单是 Shopify 官方模板的标准 dev 入口。
- **建议：** 提交前确认正式安装路径从不落到该表单；如 Shopify 审核对此敏感，可对 public 构建隐藏该表单（`process.env.NODE_ENV === "production"` 时不渲染），保留本地 dev 便利。**本次不擅自改动**——它不影响 OAuth 安装主链路，改动有回归 dev 工作流的风险。

**⚠️ 3.1.1 有效 TLS/SSL 证书**

- **为什么要注意：** 代码库无法核验线上证书。
- **检测到什么：** 应用经托管平台 + Cloudflare 隧道对外（`docs/release-runbook.md`），HTTPS 由部署环境提供。**待 Staging/生产**用浏览器核验证书链无告警。

**（附）1.2.1 billing：** 当前完全免费，符合「真免费则可不接 Billing」。**红线**：一旦对商家收费（即便走站外/独立网站），必须接 Shopify Billing API 或 Managed Pricing，不得「站内标免费、站外收费」。

## ❌ Likely failing

无。

## ⏭️ Skipped groups（条件信号未检测到）

- **5.1 Online store** — 无 `shopify.extension.toml` 且无 `type = "theme"`
- **5.2 Checkout / 5.3 POS / 5.4 Customer accounts / 5.6 Functions / 5.7 Fulfillment / 5.8 Payment / 5.9 Sales channel / 5.10 Channels** — 无对应 extension target
- **2.2.6 admin extensions 促销 / 2.2.7 Max modal** — 无 admin.block/action/link extension、无 fullscreen/ResourcePicker
- **1.1.7 Payment Gateway / 1.1.8 三方 POS / 1.1.16 资本借贷 / 3.2.2 write_payment_mandate / 3.2.3 checkout_apis / 3.2.4 dom_pixel / 3.2.5 checkout_chat** — 无相关能力/scope

## 待外部（诚实边界）

- 正式向 Shopify 提交审核、线上 TLS 核验、public 构建下是否隐藏 `_index` 表单——均属发布动作，本预检只给结论与整改建议，不伪造通过。

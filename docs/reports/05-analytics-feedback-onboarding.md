# 交付报告 05 —— 埋点、指标、反馈与 Onboarding

- 日期：2026-11-02 ｜ 阶段：Stage 5 ｜ 证据基线：`npm test` 当时 113 例通过；迁移 `add_analytics_feedback` 已落库
- 数据来源说明：指标口径由单测锁定，非真实商家数据；上线后数字来自 Beta 店事件。

## 事件模型（P1-6）

- `AnalyticsEvent` 表（append-only，props 只放业务上下文，不放个人信息）。
- **13 类事件**（清单唯一事实源 `app/lib/analytics.ts`，测试断言不重复不增减）：
  `app_installed`、`dashboard_viewed`、`sync_completed`、`settings_saved`、`supplier_saved`、`advice_accepted`、`advice_edited`、`advice_ignored`、`advice_ordered`、`csv_exported`、`purchase_plan_created`、`purchase_plan_ordered`、`feedback_submitted`。
- 接线 6 个 route；采集 fire-and-forget（`trackEvent` 不 await 不抛错，失败只进日志）；sync 撞锁不计 failed，保护 Sync Success 分母。
- `app_uninstalled` 被有意排除：卸载即 purge，记录必然被删，伪事件不如没有。

## 指标口径（纯函数 + 单测锁公式）

`computeBetaMetrics`：Activation、Time to First Value（安装前 accept 不算）、Adoption（(accept+edit)/决策数）、Decision Completion、Sync Success；`isWeeklyActiveShop` 周活；`isRetainedOnDay` 7/30 日留存。缺数据返回 **null，不假报 0**。测试：`tests/analytics.test.ts`（10 例）。

## 建议反馈（P1-7）

- `AdviceFeedback` 表：verdict（useful/not_useful，由 reason 推导，前端不各写一套）+ reason 五档 + comment（≤500）+ **自动关联 variant 与最近审计行 auditId**。
- Replenishment 行级下拉 + 备注 + 发送；同页展示已记录反馈。

## Onboarding（P1-8）

`app/lib/onboarding.ts` 五步推导：选地点 → 同步 → 参数（可跳过）→ 首条建议 → 首个决策；Home 引导卡从看板已有数据推导（零额外查询），全部完成才收起。测试 `tests/onboarding.test.ts`（5 例）。

## 遗留

Beta 指标报告（Stage 7 之后按真实事件产出）依赖上线后的数据收集。

# 交付报告 02 —— Settings 重构与参数落库

- 日期：2026-11-02 ｜ 阶段：Stage 2 ｜ 证据基线：`npm test` 当时 77 例通过；迁移 `add_replenishment_settings_source` 已落库
- 数据来源说明：验证基于 demo 店 `stepchic.myshopify.com`。

## 关闭的审计缺陷

- **#8 参数无写入路径**：`leadTimeDays / safetyStockDays / reviewPeriodDays` 此前只有 schema `@default(14/7/14)`，UI 显示「System estimate」名不副实。现在 Settings 五段表单真实落库，Home 参数来源标注随实际值切换。
- **#9 模型自测静默不可用**：offline session 下 `session.onlineAccessInfo` 恒 undefined 导致 `canTestModel` 恒假。改由 `resolveCanTestModel` 按服务端配置的 API key 判定，测试按钮真实可用。

## 实现位置

- `app/routes/app.settings.tsx`：General / Inventory Settings / Supplier Settings / AI Configuration / Data Synchronization 五段。
- `app/lib/settings-validation.ts`：参数校验纯函数（范围、整数、必填），单测 `tests/settings-validation.test.ts`。
- 保存后按新参数触发建议重算；Supplier 段指向真实的 `/app/suppliers`。

## 验收

校验失败给出字段级文案而非整页报错；保存有成功反馈；typecheck/lint 全绿，构建成功。

## 遗留

无。

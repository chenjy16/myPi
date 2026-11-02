# 交付报告 06 —— 假 UI 清理与设计语言统一

- 日期：2026-11-02 ｜ 阶段：Stage 6 ｜ 证据基线：`npm test` 113 例通过，client+server 构建成功，无新表

## 移除的假元素（审计映射表逐项）

| 元素 | 原状态 | 处理 |
| --- | --- | --- |
| 侧栏 `Pro trial / 14 days left` | 写死，全仓零计费实现 | 移除 |
| `Upgrade plan → shopify.com` | 假链接 | 移除 |
| `Contact support → shopify.com` | 假链接 | 移除，反馈入口见下 |
| `Help center → help.shopify.com` | 与应用无关的通用链接 | 换成应用内 `/app/docs` |
| 顶栏铃铛（假红点）/ 头像 | 纯装饰 `aria-hidden` | 移除，对应 dead CSS（约 70 行）同步删除 |

grep 复核全仓无残留引用（仅存注释说明）。计费 API 未接入前不展示任何套餐/试用状态（外部限制节既定原则）。

## 应用内文档页 `/app/docs`

计算口径、决策流、暂停条件、数据与权限（只读 scopes、卸载清除、埋点范围）全部按代码事实撰写；附**店铺级反馈表单**，收进 `feedback_submitted`（props.scope: "app"），不新增事件类型。

## copy / history 显式停用（P1-9）

开关关闭不再静默 redirect；共享 `app/components/feature-disabled.tsx` 明说「功能不在当前版本、数据保留、可反馈、Replenishment 照常可用」。

## 设计语言收敛（P1-10 / 缺陷 #13）

- Data Health 整页从自定义 section 卡收敛到 `s-page`/`s-section` 骨架，与 Settings / Suppliers / Purchase Plans / Docs / Replenishment 同构。
- Home 保留营销看板栅格：内容真实非假元素；视觉层统一（色板与 pill 语义对齐）列为 Beta 后持续项，不为了风格纯度重写运行页。

## 遗留

Home/Data Health 内容层仍混用部分 ds 组件类；深度令牌统一随 P2 迭代推进。

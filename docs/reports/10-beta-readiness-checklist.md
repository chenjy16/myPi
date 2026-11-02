# 交付报告 10 —— Beta 发布就绪清单

- 日期：2026-11-02 ｜ 汇总口径：P0 8/8、P1 11/11 全部关闭；证据基线见各分报告
- 数据来源说明：所有功能验证基于 demo 店 `stepchic.myshopify.com`；Beta 指标上线后按真实事件重新出数。

## 工程门禁（最终验证）

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 全绿 |
| `npm run lint` | 全绿 |
| `npm test` | 115 例通过（起点 58 → P0 70 → Stage2 77 → Stage3 88 → Stage4 98 → Stage5 113 → Stage7 115） |
| `npm run build`（client + server） | 成功 |
| 迁移 | 10 个 migration 目录全部 applied（含 `add_decision_reason_idempotency`），最后一条经真实 IP 绕行落库 |

## 商家主链路（闭环验收）

安装 → Onboarding 五步引导 → 选地点 → Sync → 数据健康检查 → 建议（可解释公式 + 置信度 + MOQ 取整）→ Accept/Adjust(+reason)/Ignore(+reason)/Ordered（请求级幂等）→ 建议池 → 按供应商归并成采购计划 → 改量/日期/备注 → ordered/cancelled 终态 → CSV 导出 → 行级反馈 + 店铺级反馈 → 卸载全量清除（16 表）。每一环都有真实实现，UI 无假元素。

## 诚实性红线（贯穿验收）

- 无套餐/试用展示（计费未接入）；无 soon 假承诺；copy/history 显式停用页。
- 60 天订单窗口限制如实降级展示；指标缺数据返回 null 不假报 0；埋点失败不伤主流程。
- 卸载即 purge，docs 页对数据面如实披露（含按店绑定的 usage events 与回访用途）。

## 外部依赖与 Beta 后事项

| 事项 | 状态 |
| --- | --- |
| `read_all_orders` + orders webhook（protected data） | 待 Partners 审批，不可自助绕过 |
| Staging 独立 store/库 | 上线前按 `release-runbook.md` 开通 |
| App Store listing 材料（截图/描述/预览链接） | 发布动作本身，非代码缺口 |
| P2 迭代 | 分段交期与停运日历、预算规划、多地点聚合、90 天历史、流式导出、移动端、i18n、精度自校准 |

## 结论

代码侧 Beta 门槛已全部达到，P0/P1 无遗留缺口；发布被阻塞的仅剩上表外部事项。

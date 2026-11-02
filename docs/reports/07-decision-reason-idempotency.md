# 交付报告 07 —— 决策理由与请求级幂等（P1-5 / 缺陷 #12）

- 日期：2026-11-02 ｜ 阶段：Stage 7 前置 ｜ 证据基线：`npm test` 115 例通过；迁移 `add_decision_reason_idempotency` 已落库
- 本项是 Stage 6 回填中标注的 P1 缺口，本轮补齐，至此 P1 清单 11 条全部关闭。

## reason 字段

- `ReorderRecommendation.decisionReason`（当前态，随最新决策覆盖）+ `RecommendationAudit.reason`（审计流水，与动作同事务写入）。
- 收集面：Adjust 与 Ignore 决策表单的可选输入（Accept 原样采纳无需理由）；上限 200 字符常量 `DECISION_REASON_MAX_LENGTH`，UI `maxLength` 与服务端校验共用（表单引用校验层常量惯例）。
- 归一：未填/纯空白 → null，超长 → 拒绝并给可行动文案；纯函数 `parseDecisionReason` 单测锁定。
- 展示：行内决策状态段与 Recent decisions 审计表均显示理由。

## 请求级幂等（不再依赖 UI 禁用）

- 每行表单携带 UUID `requestKey`（loader 发初始键；action 消费后为该行换发新键，其余行不受影响）。
- `RecommendationAudit.requestKey` 唯一索引 = 硬保证：双击/重试的第二次提交撞 P2002，事务整体回滚，route 识别后按「已记录」返回且**不重复记埋点**（决策事件只在真实写入后计数）。
- 表单值不可信：非标准 UUID 直接拒（`isValidRequestKey` 单测覆盖注入串/缺段/非 hex）。
- 系统写入（同步登记 pending、计划下单）requestKey 为 null，PG 唯一索引忽略 NULL，不互相冲突。

## 状态流转校验下沉（P1-5 第三点）

决策状态机 `isReorderDecisionIntent/isReorderDecisionStatus` 与计划状态机 `canTransitionPlanStatus` 均已是纯函数唯一事实源，route 与 service 共用（Stage 1/4 完成，此处复验）。

## 测试与验证

`tests/reorder-recommendations.test.ts` 新增 2 例（reason 归一/上限边界、UUID 校验）；typecheck/lint/test/build 全绿；迁移经真实 IP 绕行落库。

## 遗留

无。幂等窗口设计为「同一次提交去重」，商家有意再次表态走新键，不阻断正常改主意。

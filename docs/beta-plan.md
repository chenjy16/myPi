# mypi 商业化 Beta 升级计划（P0 / P1 / P2）

> 定位：Inventory Decision Intelligence。目标是从「能跑的开发版本」升级为「可供外部商家使用、能验证产品价值、具备生产能力」的 Beta。
> 本文件是执行主线，按阶段推进并在每阶段结束时回填状态。

## 一、审计结论（2026-11-02，基于实际代码 + 真库 + 真实 HTTP 探测）

起点基线：`typecheck` / `lint` 全绿，`npm test` 58 例通过，生产构建成功，dev 店 `stepchic.myshopify.com`。

已经做对的部分（不推翻，直接保留）：

- 补货计算是**纯函数 + 确定性规则**（`app/lib/inventory-calculations.ts`），带公式文本、观测样本天数、缺货日期，可解释性已具备。
- 置信度分档（`app/lib/reorder-confidence.ts`）区分 hard / soft / info，数据不足时主动降档，不伪造精确度。
- 决策状态机 + append-only 审计（`ReorderRecommendation` / `RecommendationAudit`，`saveReorderRecommendation` 同事务写入）。
- 同步幂等设计良好：payload 只作失效信号、数值一律回 Admin API 重读、同日 upsert、webhook 合并窗口。
- **数据隔离已验证**：`inventory.server.ts` / `sync-jobs.server.ts` 全部 24 处查询都带 `shop` 谓词，无跨店泄漏。
- 后台 worker（`worker/index.ts`）有 cron、`noOverlap`、env 预检、启动补跑。
- Data Health 七项检查全部按真实字段动态计算，无写死。

### UI 与功能映射（实测）

| 页面           | UI 元素                                                         | 应有功能               | 当前状态                                                                                             | 处理                                |
| -------------- | --------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 全站           | 侧栏 `Pro trial / 14 days left`                                 | 真实套餐状态           | **假**：写死，全仓零计费实现                                                                         | P1 移除                             |
| 全站           | `Upgrade plan → shopify.com`                                    | 计费页                 | **假链接**                                                                                           | P1 移除                             |
| 全站           | `Contact support → shopify.com`                                 | 客户支持               | **假链接**                                                                                           | P1 换成真实反馈入口                 |
| 全站           | `Help center → help.shopify.com`                                | 帮助                   | 通用链接，与应用无关                                                                                 | P1 换成应用内文档                   |
| 全站           | 顶栏 `◍` 铃铛 / 头像                                            | 通知中心 / 账户菜单    | **纯装饰**（`aria-hidden`，无事件）                                                                  | P1 移除                             |
| Home           | `Edit →` / `Lead times` 跳 Settings                             | 编辑补货参数           | **落空**：Settings 无参数编辑                                                                        | P1 随 Settings 重构修复             |
| Home           | `System estimate` 标注                                          | 参数来源说明           | **名不副实**：值只来自 schema `@default(14/7/14)`，无任何写入路径                                    | P1 修                               |
| Home           | 指标卡 / 建议表 / Recent decisions                              | 真库计算               | 真实                                                                                                 | 验证                                |
| Home           | `Purchase plans (soon)` 等 3 项                                 | —                      | 诚实占位，不产生误导操作                                                                             | 保留                                |
| Replenishment  | Sync / 选地点 / Accept / Adjust / Ignore / Ordered / Export CSV | 7 个真实 action intent | 真实                                                                                                 | 补并发保护与错误分类                |
| Data Health    | 检查项 + Affects advice + Sync ledger                           | 动态计算               | 真实                                                                                                 | 修 `blocksRecommendations` 语义歧义 |
| Settings       | AI Model 卡片                                                   | 展示 + 连接测试        | **测试入口永不渲染**：offline token 下 `session.onlineAccessInfo` 恒 undefined → `canTestModel` 恒假 | P1 修                               |
| Settings       | 补货参数 / 供应商 / 同步设置                                    | 配置持久化             | **整节缺失**                                                                                         | P1 实现                             |
| copy / history | 开关关闭时的访问                                                | 明确不可用             | 静默白屏（冷会话 + redirect 叠加）                                                                   | P1 修                               |

### 缺陷清单（按性质）

| #   | 缺陷                                                                                                                                          | 证据                                                                             | 等级     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| 1   | 13 处 `admin.graphql` 全部**零重试**。库默认 `retries: options?.tries ? tries-1 : 0`，即不传 `tries` 就不处理 429/503                         | `@shopify/shopify-app-react-router/dist/esm/server/clients/admin/graphql.mjs:15` | P0       |
| 2   | `DataSyncJob` 无租约：进程崩溃后行永远停在 `running`，`hasRunningJob` 会**永久跳过**该店所有后续同步（cron / webhook / 手动同时失效）         | `app/sync-jobs.server.ts:70-79`                                                  | P0       |
| 3   | 手动 Sync 不查 `hasRunningJob`，双击或多人并发即跑两次全量同步                                                                                | `app/routes/app.inventory.tsx:212-225`                                           | P0       |
| 4   | action 把原始 `error.message` 直接回给浏览器，且**不区分数据库不可用 / Shopify 不可用 / 业务校验失败**                                        | `app.inventory.tsx:236-245`                                                      | P0       |
| 5   | 生产镜像**跑不起来 worker**：`esbuild` 只在 devDependencies，而镜像是 `npm ci --omit=dev`，`worker:build` 必然失败；Dockerfile 也没有健康检查 | `package.json` + `Dockerfile`                                                    | P0       |
| 6   | `write_products` 仍在申请，但 Beta 主链路从不写商品（唯一的写点在开关关闭的 copy apply）                                                      | `shopify.app.toml`                                                               | P0       |
| 7   | 无健康检查端点，负载均衡与滚动发布无法判定就绪                                                                                                | —                                                                                | P0       |
| 8   | `leadTimeDays/safetyStockDays/reviewPeriodDays` 无任何写入路径；`inventorySettings.upsert` 从不带这三列                                       | `app/inventory.server.ts:829-852`                                                | P1       |
| 9   | offline token 下 `account_owner === true` 恒假 → 模型自测功能静默不可用                                                                       | `app/routes/app.settings.tsx:21,34`                                              | P1       |
| 10  | Suppliers / Purchase Plans 无数据模型，闭环断在「接受建议 → 采购计划 → 导出」                                                                 | `prisma/schema.prisma`                                                           | P1       |
| 11  | 无事件埋点、无反馈入口 → 无法计算 Activation / TTFV / Retention                                                                               | —                                                                                | P1       |
| 12  | 决策不记录 reason、无请求级幂等（防重复提交依赖 UI 禁用）                                                                                     | `ReorderRecommendation`                                                          | P1       |
| 13  | 设计语言分裂：Home/Data Health/Settings 自定义 CSS，Replenishment 用 Polaris Web Components                                                   | `app/styles/*`                                                                   | P1       |
| 14  | 60 天订单窗口限制已如实反映（`salesHistoryComplete` + warn 文案），无需伪造；`read_all_orders` 与 orders webhook 受 Partners 审批阻塞         | `shopify.app.toml` 注释                                                          | 外部限制 |

## 二、P0 —— 阻断正确性/安全/闭环/稳定性（先做）

| 项   | 内容                                                                                                                | 验收              |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P0-1 | 集中化 Admin GraphQL 请求：带 `tries` 走官方 429/503 + `Retry-After` 退避，识别 `extensions.cost` 节流              | 单测 + 真同步跑通 |
| P0-2 | `DataSyncJob` 加租约：超龄 `running` 回收为 `failed`，避免永久卡死                                                  | 单测覆盖超龄判定  |
| P0-3 | 手动 Sync 加并发保护，已有任务在跑时明确告知而非重复执行                                                            | 代码走查 + 实测   |
| P0-4 | 错误分类：区分 `validation` / `database` / `shopify_api` / `auth` / `unknown`，对外只给可行动文案，原始细节只进日志 | 单测覆盖分类      |
| P0-5 | 新增 `/health`：DB ping + 版本 + 运行时长，DB 不可用返回 503                                                        | curl 实测 200/503 |
| P0-6 | 权限最小化：Beta 移除 `write_products`，copy apply 在缺该 scope 时给出明确拒绝而非 API 报错                         | 真库重装授权      |
| P0-7 | 生产镜像补齐 worker 可运行 + 健康检查 + 重启策略说明                                                                | 构建验证          |
| P0-8 | 数据真实性：所有指标标注来源店铺与快照日期，报告一律标明 demo 店证据                                                | 文档 + UI 文案    |

## 三、P1 —— Beta 发布前必须

1. **Settings 重构**：General / Inventory Settings / Supplier Settings / AI Configuration / Data Synchronization 五段，参数真正落库（带校验与保存反馈）；修 offline token 下的模型自测判定。
2. **Suppliers MVP**：`Supplier` + `VariantSupplier` 模型，增删改停、联系人、MOQ、Case Pack、Unit Cost、供应商级 Lead Time；建议量按 MOQ / case pack 向上取整。
3. **Purchase Plans MVP**：从 accepted/edited 建议生成计划、多 SKU 合并、改量、状态流转、采购日期与备注、CSV 导出。
4. **假 UI 清理**：移除 trial 卡片、Upgrade、Contact support、铃铛、头像；Help 换成应用内真实文档入口。
5. **决策增强**：reason 字段、请求级幂等（防重复提交）、状态流转合法性校验下沉到服务层。
6. **产品埋点与指标**：`AnalyticsEvent` 表 + 13 类事件；Activation / Time to First Value / Adoption / Decision Completion / Weekly Active Stores / Sync Success / 7·30 日留存。
7. **用户反馈**：建议「有用/无用」+ 调整原因，与 variant + audit 关联。
8. **Onboarding**：空状态引导，安装到第一条可信建议的目标路径。
9. **copy / history 不再静默白屏**：显式 disabled 页。
10. **设计语言统一**：以 Polaris Web Components 为基线收敛自定义 CSS。
11. **发布工程**：Development / Staging / Production 三环境定义、迁移验证与回滚流程。

## 四、P2 —— Beta 后迭代

分段供应链交期与停运日历、采购预算规划、多地点聚合视图、90 天真实历史（待 `read_all_orders` 审批）、流式 CSV 下载、移动端适配、i18n、按建议效果回测的精度自校准。

## 五、外部限制（不得用假数据绕过）

- `read_all_orders` 与 `orders/create`、`orders/cancelled` webhook 属 protected customer data，需 Partners 后台审批；审批前 60 天窗口是硬限制，UI 已如实降级。
- Shopify 计费 API 尚未接入，因此 Beta 不展示任何套餐/试用状态。
- 本地网络：Shopify 后台 SPA 的 `shopify-assets.shopifycdn.com` 在无代理时被 DNS 污染，代理又会截获 5432，需域名分流才能浏览器端联调。CLI 侧同现：fake-IP 代理劫持 `*.pooler.supabase.com` 的 DNS（返回 `198.18.x.x`）导致 Prisma `P1001`，`nc -z` 假通过；单次绕行办法是用 `dig @1.1.1.1` 查真实 IP 后临时替换 `DATABASE_URL` 主机名跑 `prisma migrate deploy`，不改 `.env`。

## 六、阶段状态

| 阶段 | 内容                      | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | P0 全量（8 项）           | ✅ 完成（typecheck/lint 全绿，`npm test` 70 例通过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2    | Settings 重构 + 参数落库  | ✅ 完成（缺陷 #8/#9 已修：五段 Settings、参数校验落库并按需重算、offline 下模型自测可用；typecheck/lint 全绿，`npm test` 77 例通过，构建成功；迁移 `add_replenishment_settings_source` 与补跑的 `add_sync_job_claim_key` 已落库）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3    | Suppliers MVP             | ✅ 完成（`Supplier` + `VariantSupplier` 落库；增删改停 / 联系人 / MOQ / Case Pack / Unit Cost / 供应商级 Lead Time 全可用；建议量按「整箱且达 MOQ」向上取整并写入公式解释；停用即回退店铺口径；保存后自动重算建议；Settings 对应段已指向真实页面；typecheck/lint 全绿，`npm test` 88 例通过，构建成功）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4    | Purchase Plans MVP        | ✅ 完成（`PurchasePlan` + `PurchasePlanLine` 落库；从 accepted/edited 建议勾选生成、按供应商归并多 SKU、同变体并量；行改量/删行、采购日期与备注、open → ordered / cancelled 状态机下沉纯函数层；标记下单同步建议决策为 ordered 并走既有审计链路；单计划与全量 CSV 导出复用补货导出转义口径；Home 与入口文案不再标 soon；typecheck/lint 全绿，`npm test` 98 例通过，构建成功）                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5    | 埋点 + 反馈 + Onboarding  | ✅ 完成（`AnalyticsEvent` + `AdviceFeedback` 落库；13 类事件：app_installed / dashboard_viewed / sync_completed / settings_saved / supplier_saved / advice_accepted / advice_edited / advice_ignored / advice_ordered / csv_exported / purchase_plan_created / purchase_plan_ordered / feedback_submitted，全站 6 个 route 接线；Activation / TTFV / Adoption / Decision Completion / Sync Success / 周活 / 7·30 留存由 `computeBetaMetrics` 等纯函数从事件推导并单测锁口径；Replenishment 行级「有用/没用+原因」反馈、自动关联 variant 与最近审计行；Home 五步 Onboarding 引导卡从看板数据推导，全部完成才收起；修复 uninstall purge 缺 Stage 3/4/5 六张表的合规缺口；typecheck/lint 全绿，`npm test` 113 例通过，构建成功）                                                        |
| 6    | 假 UI 清理 + 设计语言统一 | ✅ 完成（壳层假元素全部移除：Pro trial 卡 / Upgrade plan / Help center 外链 / Contact support / 顶栏铃铛与头像，并同步删除对应 dead CSS；Help 换成应用内真实文档页 `/app/docs`——计算口径、决策流、暂停条件、数据与权限（只读 scopes、卸载清除、埋点范围）全部按代码事实撰写，附店铺级反馈表单收进 `feedback_submitted`（scope: app）；copy / history 开关关闭不再静默重定向，共享 `FeatureDisabledPage` 显式停用页（P1 第 9 条完成）；Data Health 页骨架从自定义 section 卡收敛到 `s-page`/`s-section`，与 Settings / Suppliers / Purchase Plans / Docs 同构，Home 保留营销看板栅格（真实内容非假元素，色板继续走同一 tokens）；typecheck/lint 全绿，`npm test` 113 例通过，client+server 构建成功。注：P1-5 的决策 reason 字段与请求级幂等不属本阶段，当时仍待补，已于 Stage 7 前置检查中补齐闭环 |
| 7    | 发布工程 + 十份交付报告   | ✅ 完成（前置补齐 P1-5 缺口，Stage 6 备注的待补项就此闭环：`ReorderRecommendation.decisionReason` + `RecommendationAudit.reason` 双表落库，Adjust/Ignore 表单可填理由并在行内与审计中展示；`RecommendationAudit.requestKey` 唯一索引实现请求级幂等——loader 发 per-row UUID、action 消费后换发，P2002 撞键按「已记录」返回且不重复埋点，同步/计划等系统写入 requestKey 为 null 不受约束；迁移 `add_decision_reason_idempotency` 经真实 IP 绕行落库。发布工程：`docs/release-runbook.md` 定义三环境（Staging 未开通如实标注）、发布五步门禁、向后兼容迁移规则（禁删列/改类型）、回滚流程（旧镜像+新 schema 默认兼容、回滚前三表导出）。交付报告：`docs/reports/01–10` 十份，逐份写明证据来源与诚实缺口，P1 第 5 条关闭后 P0 8/8、P1 11/11 全关。typecheck/lint 全绿，`npm test` 115 例通过，client+server 构建成功） |

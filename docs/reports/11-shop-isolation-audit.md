# P4-03 多租户隔离审计清单（shop 作用域硬边界）

> 基准：`docs/V2-PHASE4-TASKS.md` P4-03；红线「每个 V2 读写以 `shopId`/`shop` 为硬边界」。
> 审计方法：逐一静态审查全部 V2 服务/引擎/服务核模块的 Prisma 查询与变更，按「查询是否带租户 where /
> 是否按 id 裸取后断言归属」判定；发现项当场修复并以单测/渗透测锁定（见文末验证）。
> 审计时间：Phase 4 K1（2026-11）。

## 1. 模块 × 查询 × 判定

| 模块 | 关键查询/变更 | 租户边界方式 | 判定 |
| --- | --- | --- | --- |
| `lib/automations-core.ts` | automation 列表/详情/状态变更；version 创建 | `where { shopId }` / `findFirst { id, shopId }` 先校验归属再按 id 写 | ✅ 合格 |
| `lib/activity.ts` | ExecutionLog 分页/详情/血缘/待确认计数 | 全部 `where { shopId }`；step 经 `execution: { shopId }` 关联；跨店统一 null | ✅ 合格 |
| `lib/integrations-core.ts` | Integration CRUD/测试；引用统计 | `where { shopId }`；删除/测试先 `findFirst { id, shopId }` | ✅ 合格 |
| `lib/execution-log.ts` | create/appendStep/updateStep/finalizeStatus | 落库原语：shopId 由入参携带；step 经父执行 Cascade | ✅ 合格（原语层，归属由调用方约束） |
| `lib/execution-queue.ts` | 入队/认领/收尾/租约回收 | 以 `shopDomain` 为行键；`claimNextEvent(shop)` 只取本店；回收可按店 | ✅ 合格 |
| `automation-matcher.server.ts` | active 自动化 + 当前版本匹配 | 两段查询：`{ shopId, status:"active" }` + 版本用本店已知 currentVersionId 圈定；空 shopId 直接抛 | ✅ 合格 |
| `automation-loop.server.ts` | 去重窗重复计数 / 限次计数 / 级联深度 | **原缺陷①**：重复计数 `where { dedupeKey }` 未带 shopId（指纹含 automationId 隐含租户，但非显式） | 🔧 已修复：where 增补 `shopId` |
| `lib/automation-retry.ts` | retryExecution / confirmStep / correctUnknownStep | **原缺陷②**：按 id `findUnique` 裸取执行/步骤，租户收口只存在于调用方（ui-actions），核心原语自身不设防——留一条可绕过边界的通路 | 🔧 已修复：三函数 input 增 `shopId` 必填，取回后立即 `assertShopScope`，跨店一律 not_found（先于状态暴露） |
| `automation-engine/retry.server.ts` | 上述核心的真库绑定面 | 原样透传（无调用方的死通路，风险同上） | 🔧 已修复：签名同步要求 `shopId` |
| `automation-ui-actions.server.ts` | 确认/重试/资格裁决入口 | 写前 `findFirst { id, shopId }` 收口 + 资格只走 shop 收口的 `getExecutionDetail` | ✅ 合格（现叠加核心层第二道守卫） |
| `lib/automation-ingest.ts` | 落账/去重/入队 | 域名来自 `authenticate.webhook` 已鉴权 shop；`ensureShop` 定位租户行 | ✅ 合格 |
| `lib/webhook-delivery.ts` | 投递记录/ prune | 按 `(shop, webhookId)` 唯一记录；prune 全局按时序（非租户数据面） | ✅ 合格 |
| `lib/action-bindings.ts` | 出站绑定解析 | `where { shopId }`；跨店 Integration 查不到即留空（干净失败） | ✅ 合格 |
| `webhook-sync.server.ts` | 合规删除清单 | `SHOP_SCOPED_DELETES` 全表按 shop；V2 表已覆盖 | ✅ 合格 |
| 路由 `app.automation.*` | loader/action | 一律 `authenticate.admin` → `resolveShopFromSession` 取本店租户行，id 参数只进本店作用域函数 | ✅ 合格 |
| `worker/index.ts` | 队列消费/扫描 | 按 `installedShops()` 逐店循环，认领按 shop | ✅ 合格 |

## 2. 修复项与防护落点

1. **`app/lib/shop-scope.ts`（新增）**：`ShopScopeError` / `requireShopId` / `assertShopScope`——
   「按 id 取回再操作」的通路统一在取回后、任何状态暴露/写入之前断言归属；跨店与不存在同一
   不可见口径，不泄露他店存在性。
2. **引擎核心三原语补硬边界**（`automation-retry.ts` + `retry.server.ts`）：`shopId` 成为必填入参，
   即使未来出现忘记收口的新调用方，核心层也会把跨店请求折成 not_found（防御纵深）。
3. **loop 去重计数显式带 shopId**（`automation-loop.server.ts`）。

## 3. 验证

- 单测：`tests/shop-scope.test.ts`（守卫语义 5 例）；`tests/automation-retry.test.ts` 新增 3 例跨店渗透
  （他店 id → not_found、零 Mutation、零回读、原状态不动）。
- DB 渗透集成测：`tests/shop-isolation.db.test.ts`（P4-04，MYPI_DB_INTEGRATION 门下真库验证）。
- 三门禁：见 K1 门禁记录。

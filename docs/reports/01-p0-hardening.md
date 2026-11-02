# 交付报告 01 —— P0 加固（8 项）

- 日期：2026-11-02 ｜ 阶段：Stage 1 ｜ 证据基线：`npm test` 当时 70 例通过，typecheck/lint 全绿
- 数据来源说明：全部验证基于开发店 `stepchic.myshopify.com`（demo 店），非真实商家数据。

## 交付内容与证据

| # | 项 | 实现位置 | 验证证据 |
| --- | --- | --- | --- |
| 1 | Admin GraphQL 集中化 + 限流重试 | `app/lib/admin-graphql.server.ts`（唯一出口，`tries` 默认 3、上限 4，识别 `extensions.cost`） | `tests/app-error.test.ts` + 全仓 13 处调用点收敛到该出口 |
| 2 | `DataSyncJob` 租约回收 | `app/sync-jobs.server.ts` `leaseCutoff()`，超 `WORKER_JOB_LEASE_MINUTES`（默认 30）的 `running` 判 failed 并释放锁 | `tests/sync-jobs.test.ts` 覆盖超龄判定 |
| 3 | 手动 Sync 并发保护 | 页面先查 `hasRunningJob` 给「已在跑」提示；互斥由任务锁保证；撞锁抛 `SyncAlreadyRunningError` | 代码走查 + 联调实测 |
| 4 | 错误分类 | `app/lib/app-error.ts`：`validation / database / shopify_api / auth / unknown`；对外可行动文案，原始细节只进日志 | `tests/app-error.test.ts` |
| 5 | `/health` 探针 | `app/routes/health.tsx`：DB ping（超时上限 `HEALTH_CHECK_TIMEOUT_MS`）+ 版本 + uptime；DB down 返回 503；`Cache-Control: no-store` | curl 实测 200/503（Stage 1 联调记录） |
| 6 | 权限最小化 | `shopify.app.toml` scopes 收敛为 `read_products,read_inventory,read_orders,read_locations`；copy apply 缺 `write_products` 时显式拒绝 | 真库重装授权实测 |
| 7 | 生产镜像可运行 worker | `Dockerfile` 双阶段：build 全量依赖（esbuild 可用），runtime `--omit=dev` 只带产物；`HEALTHCHECK` 用 busybox wget；worker 独立进程 `npm run docker-worker` | `docker build` 构建验证 |
| 8 | 数据真实性文案 | 指标带来源店铺与快照日期；60 天订单窗口限制如实降级（`salesHistoryComplete`），无伪造 | UI 走查 + `tests/data-health.test.ts` |

## 遗留

无。8 项全部关闭；#6 的 copy apply 写回路径当前整体在功能开关后（`PRODUCT_COPY_ENABLED=false`）。

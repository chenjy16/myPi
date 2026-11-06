# P4-23 · 索引审阅 + 轻载基准（Phase 4 K4）

基准：`docs/V2-PHASE4-TASKS.md` P4-23。范围限于「现有索引是否覆盖高频查询 + 纯核 CPU 侧成本 + 连接池预算」；多副本容器与真实吞吐演练标注「待 Staging」。

## 1. 索引审阅（prisma/schema.prisma）

审阅口径：对自动化运行路径上每次 webhook 都会经过的读点，比对 `where` 列 + `orderBy` 与已有索引。

| 表 | 高频查询 | 现有索引 | 判定 |
| --- | --- | --- | --- |
| `Automation` | `where shopId, status='active', currentVersionId not null`（matcher 首段） | `@@index([shopId, status])` | **命中**：前缀完全覆盖 where |
| `AutomationVersion` | `where id IN (...)`（matcher 次段） | `@@unique([automationId, version])`；主键 `id` | **命中**：走 id 主键 |
| `ExecutionLog` | `where shopId, automationId, createdAt desc`（Activity 列表） | `@@index([shopId, automationId, createdAt])` | **命中**：三列复合前缀 |
| `ExecutionLog` | `where shopId, status, createdAt`（health 成功率窗口） | `@@index([shopId, status, createdAt])` | **命中** |
| `ExecutionLog` | `where shopId, entityRef`（GDPR data_request 反查） | `@@index([shopId, entityRef])` | **命中** |
| `ExecutionStep` | `where executionId`（详情页展开步骤） | `@@unique([executionId, order])` | **命中**：主 index 前缀 |
| `WebhookDelivery` | `where webhookId`（幂等去重） | `@@unique([webhookId])` | **命中** |
| `WebhookDelivery` | `where receivedAt < cutoff`（TTL prune） | `@@index([receivedAt])` | **命中** |
| `WebhookDelivery` | `where shop, topic, receivedAt`（对账 / 排障 SQL） | `@@index([shop, topic, receivedAt])` | **命中** |
| `ScheduledJob` | `where shopId, nextRunAt`（cron 领取） | `@@index([shopId, nextRunAt])` | **命中** |
| `DataSyncJob`（automation 执行队列） | `where shop, jobType='automation-execute', status='queued' orderBy createdAt asc` | `@@index([shop, jobType, status])` | **可用**：where 三段完全命中；`orderBy createdAt` 需 sort。轻载（≤200 pending）无感；重载时再考虑 `[shop, jobType, status, createdAt]` 覆盖式索引 |
| `Integration` | `where shopId, kind` | `@@index([shopId, kind])` | **命中** |

**结论**：不加新索引。目前唯一「where 命中但 orderBy 需 sort」的是 `DataSyncJob` 领取路径，属于队列短表 (<200 常驻行)；加一条覆盖式索引会拖慢每次 `updateMany(status=queued → running)` 的写侧成本，收益不划算。列入观察项：若 `queueDepth` 常态 >200（§8 告警阈值），再补索引。

## 2. 轻载基准（`scripts/perf-light.ts`）

只压纯核 CPU 侧路径，DB 走假 client，测的是「每一条 webhook 都会付的固定成本」。Node 22.14 / macOS arm64。

```
== P4-23 light benchmark  N=100 shops  M=1000 events/shop ==
normalizeEvent       n=100000  p50=0.0002ms  p95=0.0005ms  p99=0.0007ms  max=0.2658ms
matchAutomations     n=100000  p50=0.0015ms  p95=0.0033ms  p99=0.0068ms  max=0.4409ms
```

**解读**：

- 归一化：P95 < 1μs，单核理论上限 ≈ 1M events/s，非瓶颈。
- 匹配器：P95 ≈ 3.3μs（含假 db 的 JS filter + Promise tick），真实 DB 环境下瓶颈在 IO 不在这段。
- max 抖动 <0.5ms 都在 GC 抖动范围内。

真实环境下的 DB IO 与网络延迟不在本基准内，见 `docs/server-operations-guide.md` §7.2 排障 SQL 采样。

## 3. 连接池预算（写入 runbook）

Supabase transaction-mode pooler（`PORT=6543`）单实例上限 100 conn；本项目当前拓扑：

| 消费者 | 池配置 | 峰值连接 |
| --- | --- | --- |
| Web 进程（react-router serve） | `connection_limit=10` per node | 1 × 10 = 10 |
| Worker 进程（cron） | `connection_limit=5` per node | 1 × 5 = 5 |
| Prisma migrate / CLI | 单连接 | 1 |
| **合计基线** | — | **≤ 16** |

**红线**：多副本部署时按副本数线性放大；预算公式 `web_replicas × 10 + worker_replicas × 5 + 1`。超过 pooler 上限的一半就要提 `connection_limit` 下调或走 session-pooler 分流，写进 `docs/release-runbook.md` §1。

`DATABASE_URL` 里的 `pg.bouncer=transaction` 已开启，Prisma 长连接不复用同一后端会话；worker 每次 cron 结束都主动 `$disconnect`（见 `worker/index.ts` 收尾）。

## 4. 遗留 · 待 Staging

- **多副本容器演练**（P4-23 原要求）：需 Staging 云资源开通后跑一次 3 web + 1 worker 的 compose，观察 pooler 与队列认领冲突。当前不伪造。
- **真实吞吐压测**：`k6`/`autocannon` 打 `/webhooks/inventory_levels/update`，含 HMAC + DB 写，需 Staging 环境。
- **`DataSyncJob` 覆盖式索引**：只在 `queueDepth` 长期 >200 时启用；触发条件与决策依据已在 §1 记录。

## 复现

```bash
# 覆盖率
node --experimental-transform-types --test --experimental-test-coverage \
     --test-coverage-include='app/lib/**' tests/*.test.ts

# 轻载基准
node --experimental-transform-types scripts/perf-light.ts 100 1000
```

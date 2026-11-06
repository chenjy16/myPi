# mypi 发布 Runbook（三环境 / 迁移验证 / 回滚）

> P1-11 交付物。这里的每一条流程都对应仓库里已有的脚本或镜像行为，不是设想。
> 环境变量事实来源：`.env.example`；镜像行为事实来源：`Dockerfile`；探针事实来源：`app/routes/health.tsx`。

## 1. 三环境定义

| | Development | Staging | Production |
| --- | --- | --- | --- |
| 用途 | 日常开发、`shopify app dev` 热更新 | 发布前完整验收：真实镜像、真实 OAuth 流、迁移演练 | 商家实际使用 |
| Shopify 应用 | dev store（当前：`stepchic.myshopify.com`） | 独立 dev store，绑定 `shopify.app.<handle>.toml` 变体 | 正式 App Store listing |
| 数据库 | Supabase session pooler（与 .env 一致） | **独立 project / 独立库**，绝不与 Production 共用 | Supabase session pooler（IPv4；直连端点 IPv6-only 会 P1001） |
| 进程 | `npm run dev`（CLI 起 web + worker） | 镜像 + `npm run docker-start`（web）、`npm run docker-worker`（worker） | 同 Staging |
| 流量摘除 | 不适用 | HEALTHCHECK 驱动 | HEALTHCHECK 驱动（30s 间隔、3 次失败摘除） |

Staging 尚未开通独立 store 与独立数据库实例；首次外部 Beta 前按本表开通，开通前所有发布验证只能在 Production 之外的本地镜像（`docker build` + 本地跑 `npm run setup` 指向一次性库）完成，并在交付报告中如实标注。

环境变量矩阵见 `.env.example` 注释（唯一事实来源），按用途分组：

- **数据库 / 连接池**：`DATABASE_URL`（session pooler + `sslmode=require` + `connect_timeout`）、`DB_CONNECTION_LIMIT`、`DB_POOL_TIMEOUT_SECONDS`、`DB_CONNECT_TIMEOUT_SECONDS`。
- **Worker cron 与节奏**：`WORKER_SNAPSHOT_CRON` / `WORKER_SALES_CRON` / `WORKER_AUTOMATION_CRON` / `WORKER_AUTOMATION_BATCH` / `WORKER_DELIVERY_PRUNE_CRON` / `WORKER_RETENTION_PRUNE_CRON` / `WORKER_RECONCILE_CRON`、`WORKER_JOB_LEASE_MINUTES`、`WORKER_SHUTDOWN_GRACE_MS`、`WEBHOOK_SNAPSHOT_COALESCE_SECONDS`。
- **自动化引擎（V2）**：`AUTOMATION_EXECUTION_ENABLED`（Safe by Default，生产灰度才开；注意总开关 `AUTOMATION_ENABLED` 是 `app/features.ts` 编译期常量、非 env）、`AUTOMATION_SECRET_KEY`（Integration 密钥加密主钥，32 字节 hex，生产必填）、`WEBHOOK_DELIVERY_TTL_HOURS`、`EXECUTION_RETENTION_DAYS`。
- **防循环 / 重试**：`LOOP_MAX_CASCADE_DEPTH`、`LOOP_DEDUP_WINDOW_MS`、`LOOP_RATE_LIMIT_WINDOW_MS`、`LOOP_RATE_LIMIT_COUNT`（非法值回退安全默认并钳上界）、`EXECUTION_MAX_ATTEMPTS`、`EXECUTION_BACKOFF_CAP_MS`、`EXECUTION_LEASE_MINUTES`。
- **漏投对账（P4-13）**：`RECONCILE_ENABLED`（默认关）、`RECONCILE_INTERVAL_MINUTES`、`RECONCILE_LOOKBACK_MINUTES`。
- **探针 / 版本 / 出站**：`HEALTH_CHECK_TIMEOUT_MS`、`HEALTH_AUTOMATION_WINDOW_MS` / `HEALTH_WORKER_HEARTBEAT_STALE_MS` / `HEALTH_AUTOMATION_QUERY_TIMEOUT_MS`（`/health` 自动化态势维度的窗长/心跳 stale 水位/子查询超时护栏，均降级安全、**永不影响 503 摘流量判据**——仅 `database: down` 才 503）、`APP_VERSION`（CI 注入，`/health` 透出版本号）、`SHOPIFY_GRAPHQL_TRIES`、`PI_API_KEY`/`PI_PROVIDER`/`PI_MODEL`；邮件动作 provider 密钥待 OQ-8 选定后接入。

所有数值型 env 都遵循「缺省/非法回退可读默认 + 上界护栏」口径（见各 `parse*` 纯函数与其单测），缺变量不会把引擎置于无界或 NaN 状态。Shopify 侧 `SHOPIFY_API_KEY / SECRET / APP_URL / SCOPES` 由 CLI 或部署平台注入，不落仓库。

### 1.1 连接池预算（P4-23）

Supabase transaction-mode pooler 单实例上限 100 conn；基线预算（P4-23 审阅）：

| 消费者 | 单实例池 | 基线副本 | 峰值连接 |
| --- | --- | --- | --- |
| Web (`react-router-serve`) | `DB_CONNECTION_LIMIT=10` | 1 | 10 |
| Worker (cron) | `connection_limit=5` | 1 | 5 |
| Prisma migrate / CLI | 1 | — | 1 |
| **合计** | — | — | **≤ 16** |

**多副本预算公式**：`web_replicas × 10 + worker_replicas × 5 + 1`。总量接近 pooler 上限一半（≥50）时，先把 `DB_CONNECTION_LIMIT` 下调到 6 或拆 session-pooler 给长事务（Migration/备份），再考虑升级 Supabase 规格。`DATABASE_URL` 默认已开 `pg.bouncer=transaction`；worker 每轮 cron 收尾主动 `$disconnect`，不留长会话。索引审阅与轻载基准见 `docs/reports/13-p4-performance.md`。

## 2. 发布流程（每次上线）

1. **本地门禁**：`npm run typecheck && npm run lint && npm test && npm run build` 全绿才允许推送。
2. **迁移评审**（见第 3 节规则）：新 migration 只能是向后兼容变更。
3. **镜像构建**：`docker build`。构建阶段全量 `npm ci`（worker 打包需要 devDependencies 里的 esbuild），运行阶段 `npm ci --omit=dev` 只带产物 `build/`、`build-worker/` 与 `prisma/`。
4. **部署**：容器启动执行 `npm run docker-start` → `prisma generate && prisma migrate deploy && react-router-serve`。worker 容器执行 `npm run docker-worker` → 只 `prisma generate`，**不跑迁移**（结构变更归发布流程，不归常驻进程）。
5. **上线验证**：`curl -f https://<host>/health` 期望 200 且 JSON 里 `database: "up"`、版本与本次发布一致；DB 故意断连时该端点返回 503（编排系统据此摘流量）。随后走一遍：登录 → 手动 Sync → 看一条建议 → Accept（含 reason）→ 生成计划 → 导出 CSV。

### 2.1 分级灰度口径（P4-24：先发无审批项）

发布按「是否依赖外部审批」分两档，避免为等 G1/G2 而阻塞无审批价值：

- **第一档 · 无审批即可发（G1/G2 未解除也上线）**：Event Ingestion 框架、去重、Condition Evaluator、Execution Log/Retry、多租户隔离、风险确认引擎、Send Email、Custom Webhook（SSRF 守卫）、**T4 Low Stock Alert**（`read_inventory` 已具备）、隐私/合规基座（retention/GDPR/脱敏）、health/告警/对账运维面。`AUTOMATION_ENABLED`（编译期）可开；`AUTOMATION_EXECUTION_ENABLED` 按店灰度。
- **第二档 · 待外部审批才解锁（标灰、不得伪记通过）**：订单/客户类触发（orders/create|paid|cancelled、customers/create）需 **G1** Protected Customer Data 审批 + webhook 订阅生效；打标/改状态动作需 **G2** 写 scope 扩权经 App Store 权限审核。审批提交与生效属外部动作，本 Runbook 只交付准备物（`docs/V2-P4-APPROVAL-PACK.md`）与重授权引导（scope-guard banner），不伪造。

**判定**：第一档全过 + §6 无审批项勾满 → 可发「基建 + T4」子集；第二档项在阻塞解除前保持 BLOCKED。

## 3. 迁移规则与验证

Prisma `migrate deploy` 只向前，**没有自动回滚**。因此：

- **允许的迁移**：新建表；给已有表加 nullable / 带默认值的列；加索引（含唯一索引，前提是新列或已清洗数据）。Beta 现有迁移全部符合（`add_purchase_plans`、`add_analytics_feedback`、`add_decision_reason_idempotency` 均为新表或加 nullable 列）。
- **禁止的迁移**（Beta 期间）：删列、改列类型、重命名、带数据回填的破坏性变更。确需时拆成「先兼容双写 → 切读 → 后清理」的多版本发布。
- **验证**：部署前在目标库执行 `npx prisma migrate status`（应报告无 pending）；部署后再跑一次确认全部 applied。新列抽查，如：

  ```sql
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'RecommendationAudit' AND column_name IN ('reason','requestKey');
  ```

- **本地网络限制**：代理（Shadowrocket TUN + fake-IP）会劫持 `*.pooler.supabase.com` 的 DNS（返回 `198.18.x.x`，`nc -z` 假通过）并抢占第一默认路由，5432 裸 TCP 被代理节点丢弃，Prisma 报 P1001。根治办法（2026-11-05 验证）：在**实际生效的代理配置**（macOS Shadowrocket 为 配置 → default.conf → 通用 → 「跳过代理」）加入 `*.supabase.com`、`*.supabase.co` 后断开重连；这些域名的连接由 TUN 直连出网，浏览器走系统 HTTP 代理访问隧道的行为不受影响。注意：「兼容模式」开关只加回真实网关路由、不撤销 utun4 默认路由，无法解决本问题；旧「dig 真实 IP 临时替换 DATABASE_URL」绕行法在 TUN 抢路由后同样失效（真实 IP 流量照样进 utun4）。唯一可信判据是 `npx prisma migrate status` 报 up to date（DNS 仍回 198.18.x 不代表未修好）。CI / 服务器网络不经该代理，无需任何处理。

## 4. 回滚流程

镜像与应用代码：保留上一个可用镜像 tag，回滚 = 指回旧 tag 重启。数据：

1. 旧镜像 + 新 schema **默认兼容**（新列全部 nullable），所以先回滚应用、后处理数据。
2. 若迁移本身需要回退（罕见）：Supabase Dashboard 的数据库备份 / PITR 恢复到迁移前时间点，然后回滚应用。恢复会丢掉迁移后写入的决策与埋点——回滚前导出 `RecommendationAudit`、`ReorderRecommendation`、`AnalyticsEvent` 三表到 CSV 存档。
3. 回滚后 `npx prisma migrate status` 确认 schema 版本与所回退的代码版本一致，再走一遍第 2 节第 5 步的上线验证。

## 5. 常驻进程与重启策略

- web 与 worker 共用镜像、各自独立容器：worker 崩溃不影响对外服务，可单独重启与扩缩（worker 有 `noOverlap` 与任务锁，多副本只会有一份 cron 实际执行——锁被占用时其余运行直接跳过）。
- 编排系统按 Dockerfile `HEALTHCHECK` 决定摘除与重启；重启策略建议 `unless-stopped` + 部署平台原生滚动。
- 崩溃遗留的 `running` 同步行由租约机制自动回收（超 `WORKER_JOB_LEASE_MINUTES` 判 failed 并释放锁），无需人工清账。
- 收到 `SIGTERM` 时 worker 走优雅退出：停止 node-cron 排程（不再触发新 tick）→ `prisma.$disconnect()` 释放连接池 → 干净退出；超过 `WORKER_SHUTDOWN_GRACE_MS`（默认 10s）仍未退出则强制结束，避免容器停机把进程钉成僵尸。若此刻正有一次启动补跑同步在飞行中，它会被硬超时打断，遗留的 `running` 同步行同样由上面的租约回收兜底，不会伪装成"正在同步"。

## 6. 备份与恢复（P1-9）

数据库是唯一需要持久化的状态（会话 offline token、店铺设置、地点目录、每日快照、库存事件、同步台账、每日销量、补货决策与埋点）。Shopify 侧数据是权威源、可随时重新同步，不在备份范围内。

### 6.1 备份方式与节奏

两条腿并用，互为兜底：

1. **Supabase 自动备份 / PITR**（平台层，主）：在 Dashboard → Database → Backups 开启并确认保留窗口。PITR 能把整库恢复到保留窗口内任意时间点；恢复粒度是「整个 project」，适合灾难恢复。
2. **逻辑备份 `pg_dump`**（脚本层，细粒度、可跨实例）：对 session pooler 连接串做单次全量导出，产物落对象存储（Supabase Storage / 私有桶），**不入库、不进 git**。

   ```bash
   # 只读导出，走 .env.example 确立的 session pooler；schema + data 一起
   TS=$(date -u +%Y%m%dT%H%M%SZ)
   pg_dump "$DATABASE_URL" --format=custom --file="backup/mypi-${TS}.dump"
   # 校验产物非空且可读头（拿到表数即证明转储完整）
   pg_restore --list "backup/mypi-${TS}.dump" | head
   ```

节奏与保留：`pg_dump` 每日一次（错开 worker 的 03:00 销量重建），保留最近 14 份日备 + 发布前手动快照一份；Supabase 备份按平台默认。具体保留天数与 PITR 窗口取决于所购 Supabase 套餐，上线前据 Dashboard 实际值确认并记在这里，不假设未开通的能力。

### 6.2 恢复流程（恢复到一次性 scratch 库验证，绝不直接盖生产）

```bash
# 1) 建临时库（本地 postgres 或另一个 Supabase project），用 DATABASE_URL_SCRATCH 指向它
# 2) 逻辑恢复：先建 schema 再灌数据，--no-owner 让对象归属跟随连接用户
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL_SCRATCH" "backup/mypi-<TS>.dump"
# 3) 结构一致性：迁移台账应与生产版本对齐、无 pending
DATABASE_URL="$DATABASE_URL_SCRATCH" npx prisma migrate status
```

### 6.3 恢复后的校验（用行数对账，不抽查一两张表就宣称成功）

对 scratch 库逐表比对关键计数与源库备份时的数量级（允许因备份后新写入产生的小幅增长，不允许缺表或量级塌陷）。V1 主链路 + V2 自动化/投递/调度 全量覆盖，P4-18 已把自动化侧 8 张表补进对账：

```sql
-- V1 主链路（同步、建议、计划、审计、埋点）
SELECT 'Session' t, count(*) FROM "Session"
UNION ALL SELECT 'InventorySnapshot', count(*) FROM "InventorySnapshot"
UNION ALL SELECT 'SalesDaily', count(*) FROM "SalesDaily"
UNION ALL SELECT 'DataSyncJob', count(*) FROM "DataSyncJob"
UNION ALL SELECT 'ReorderRecommendation', count(*) FROM "ReorderRecommendation"
UNION ALL SELECT 'RecommendationAudit', count(*) FROM "RecommendationAudit"
UNION ALL SELECT 'AnalyticsEvent', count(*) FROM "AnalyticsEvent"
-- V2 自动化侧（P4-18）
UNION ALL SELECT 'Shop', count(*) FROM "Shop"
UNION ALL SELECT 'Automation', count(*) FROM "Automation"
UNION ALL SELECT 'AutomationVersion', count(*) FROM "AutomationVersion"
UNION ALL SELECT 'ExecutionLog', count(*) FROM "ExecutionLog"
UNION ALL SELECT 'ExecutionStep', count(*) FROM "ExecutionStep"
UNION ALL SELECT 'WebhookDelivery', count(*) FROM "WebhookDelivery"
UNION ALL SELECT 'Integration', count(*) FROM "Integration"
UNION ALL SELECT 'ScheduledJob', count(*) FROM "ScheduledJob";
```

补充一致性对账（只靠行数不够，自动化侧跨表必须对齐）：

```sql
-- 每条 Automation 必须有一个当前版本（currentVersionId 非空且能在 AutomationVersion 里找到）
SELECT count(*) AS orphan_automation_current
FROM "Automation" a
LEFT JOIN "AutomationVersion" v ON v.id = a."currentVersionId"
WHERE a.status <> 'deleted' AND v.id IS NULL;

-- 每条 ExecutionStep 必须属于一个 ExecutionLog（跨表无悬空）
SELECT count(*) AS orphan_execution_step
FROM "ExecutionStep" s
LEFT JOIN "ExecutionLog" l ON l.id = s."executionId"
WHERE l.id IS NULL;

-- WebhookDelivery 与 shop 的归属完整性（shopId 可空：未映射店先不阻断，但总量不能偏离预期）
SELECT ("shopId" IS NULL) null_shop, count(*)
FROM "WebhookDelivery" GROUP BY 1;

-- Integration 密钥密文非空（UI 展示 secretConfigured 的字段密文就是 secretsEncrypted）
-- 预期：kind 非 SHOPIFY 且声明了密钥的行 secretsEncrypted 都不为空。
SELECT count(*) AS integration_missing_secret
FROM "Integration"
WHERE kind IN ('EMAIL', 'CUSTOM_WEBHOOK')
  AND "secretsEncrypted" IS NULL;
-- 以上四项预期都应为 0（最后一条只统计 null_shop 分布，供人工确认）；
-- 非 0 即备份链上有丢行或触发词不同库实例，先查后上。
```

再跑一遍只读业务校验：用 scratch 库起 web，登录测试店 → Replenishment 页应显示同步后的建议而非空态；Automations 列表不为空（若源库有）、Activity 日志能拉到至少一条。计数查询的表名以 `prisma/schema.prisma` 的 model 映射为准，新增核心表时同步补进上面这条对账 SQL。

### 6.3.1 scratch 演练记录（首次实执时填写）

本地 pg_dump → 还原 scratch 库 → 上面两 SQL 逐行验证 → 回写下面表格；未实际跑过的备份链不算恢复能力。至少每季度重跑一次。

行数与一致性 SQL 已封成只读脚本：`scripts/backup-reconcile.ts`（`DATABASE_URL=… node --experimental-transform-types scripts/backup-reconcile.ts`）。

**预演练（Phase 4 K3·2026-05-XX）—— 仅行数对账 + 一致性 SQL，未含 pg_dump/restore**：

| 项 | 值 |
| --- | --- |
| 日期 | 2026-05（K3 预演练） |
| 环境 | Supabase 开发库（非生产） |
| SQL 验证 | 16 项行数 + 4 项一致性均执行成功；orphan_automation_current=0、orphan_execution_step=0、integration_missing_secret=0 |
| 行数当前量级 | Session 1 / Shop 1 / Automation 1 / AutomationVersion 1 / InventorySnapshot 40 / DataSyncJob 57 / ReorderRecommendation 5 / RecommendationAudit 17 / AnalyticsEvent 43；ExecutionLog/Step/WebhookDelivery/Integration/ScheduledJob 均为 0（开发库无真实自动化运行历史） |
| pg_dump / pg_restore 完整演练 | **待 Staging**：需本地安装 postgresql-client 后指向 Supabase Staging 实例实执；本次仅验证 SQL 契约与行量级基线 |
| 发现的异常与处置 | 无 |

上表仅证明 §6.3 的两段 SQL 可执行且当前无一致性异常。备份→scratch 还原→行数比对的完整演练仍待 Staging 开通后补写，不伪造成已完成。



### 6.4 RPO / RTO 与红线

- **RPO**（最多丢多少数据）：等于上次备份以来的写入间隔——`pg_dump` 日备为 24h、PITR 为分钟级。补货决策与埋点是最不能丢的写路径，正式商家接入前须把 PITR 开到位。
- **RTO**（多久恢复可用）：以「恢复到 scratch 库并通过 6.3 校验」的实测耗时为准，首次演练后把数字记在这里。
- **红线**：备份产物含 offline access token 与商家数据，属敏感数据——只放私有加密存储，绝不提交仓库、不进日志；恢复验证只在 scratch 库做，通过后才谈切换，绝不拿生产库当试验场。

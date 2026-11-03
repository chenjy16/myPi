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

环境变量矩阵见 `.env.example` 注释：`DATABASE_URL`（session pooler + `sslmode=require` + `connect_timeout`）、`WORKER_SNAPSHOT_CRON` / `WORKER_SALES_CRON` / `WORKER_JOB_LEASE_MINUTES`、`WEBHOOK_SNAPSHOT_COALESCE_SECONDS`、`SHOPIFY_GRAPHQL_TRIES`、`HEALTH_CHECK_TIMEOUT_MS`、`APP_VERSION`（CI 注入，`/health` 透出版本号）。Shopify 侧 `SHOPIFY_API_KEY / SECRET / APP_URL / SCOPES` 由 CLI 或部署平台注入，不落仓库。

## 2. 发布流程（每次上线）

1. **本地门禁**：`npm run typecheck && npm run lint && npm test && npm run build` 全绿才允许推送。
2. **迁移评审**（见第 3 节规则）：新 migration 只能是向后兼容变更。
3. **镜像构建**：`docker build`。构建阶段全量 `npm ci`（worker 打包需要 devDependencies 里的 esbuild），运行阶段 `npm ci --omit=dev` 只带产物 `build/`、`build-worker/` 与 `prisma/`。
4. **部署**：容器启动执行 `npm run docker-start` → `prisma generate && prisma migrate deploy && react-router-serve`。worker 容器执行 `npm run docker-worker` → 只 `prisma generate`，**不跑迁移**（结构变更归发布流程，不归常驻进程）。
5. **上线验证**：`curl -f https://<host>/health` 期望 200 且 JSON 里 `database: "up"`、版本与本次发布一致；DB 故意断连时该端点返回 503（编排系统据此摘流量）。随后走一遍：登录 → 手动 Sync → 看一条建议 → Accept（含 reason）→ 生成计划 → 导出 CSV。

## 3. 迁移规则与验证

Prisma `migrate deploy` 只向前，**没有自动回滚**。因此：

- **允许的迁移**：新建表；给已有表加 nullable / 带默认值的列；加索引（含唯一索引，前提是新列或已清洗数据）。Beta 现有迁移全部符合（`add_purchase_plans`、`add_analytics_feedback`、`add_decision_reason_idempotency` 均为新表或加 nullable 列）。
- **禁止的迁移**（Beta 期间）：删列、改列类型、重命名、带数据回填的破坏性变更。确需时拆成「先兼容双写 → 切读 → 后清理」的多版本发布。
- **验证**：部署前在目标库执行 `npx prisma migrate status`（应报告无 pending）；部署后再跑一次确认全部 applied。新列抽查，如：

  ```sql
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'RecommendationAudit' AND column_name IN ('reason','requestKey');
  ```

- **本地网络限制**：代理 fake-IP 会劫持 `*.pooler.supabase.com` 的 DNS（返回 `198.18.x.x`，`nc -z` 假通过、Prisma P1001）。单次绕行：`dig +short @1.1.1.1 <pooler-host>` 取真实 IP，临时替换 `DATABASE_URL` 主机名执行 `prisma migrate deploy`，不改 `.env`。CI / 服务器网络不经该代理，无需绕行。

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

对 scratch 库逐表比对关键计数与源库备份时的数量级（允许因备份后新写入产生的小幅增长，不允许缺表或量级塌陷）：

```sql
SELECT 'Session' t, count(*) FROM "Session"
UNION ALL SELECT 'InventorySnapshot', count(*) FROM "InventorySnapshot"
UNION ALL SELECT 'SalesDaily', count(*) FROM "SalesDaily"
UNION ALL SELECT 'DataSyncJob', count(*) FROM "DataSyncJob"
UNION ALL SELECT 'ReorderRecommendation', count(*) FROM "ReorderRecommendation"
UNION ALL SELECT 'RecommendationAudit', count(*) FROM "RecommendationAudit"
UNION ALL SELECT 'AnalyticsEvent', count(*) FROM "AnalyticsEvent";
```

再跑一遍只读业务校验：用 scratch 库起 web，登录测试店 → Replenishment 页应显示同步后的建议而非空态。计数查询的表名以 `prisma/schema.prisma` 的 model 映射为准，新增核心表时同步补进上面这条对账 SQL。

### 6.4 RPO / RTO 与红线

- **RPO**（最多丢多少数据）：等于上次备份以来的写入间隔——`pg_dump` 日备为 24h、PITR 为分钟级。补货决策与埋点是最不能丢的写路径，正式商家接入前须把 PITR 开到位。
- **RTO**（多久恢复可用）：以「恢复到 scratch 库并通过 6.3 校验」的实测耗时为准，首次演练后把数字记在这里。
- **红线**：备份产物含 offline access token 与商家数据，属敏感数据——只放私有加密存储，绝不提交仓库、不进日志；恢复验证只在 scratch 库做，通过后才谈切换，绝不拿生产库当试验场。

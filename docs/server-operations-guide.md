# myPi 服务器运维指南（统一文档）

生产环境于 2026-11-05 部署上线。本文档覆盖：SSH 登录、首页访问、日常运维、发布流程、应急自救。

---

## 1. 架构总览

```
商家/用户 ──HTTPS──▶ https://mypier.duckdns.org（443）
                          │
                    ┌─────▼─────┐
                    │   sslh    │  按协议分流：
                    │  (443)    │  SSH 握手 → sshd:22（运维）
                    └─────┬─────┘  TLS/HTTP → Caddy:4430（网站）
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          mypi-web    mypi-worker   mypi-caddy
        （应用:3000）（定时任务） （证书+反代）
              │
              ▼
     Supabase 数据库（eu-west-1，远程）
```

| 项 | 值 |
|---|---|
| 服务器 | RackNerd VPS `racknerd-15b4d6c`，Rocky Linux 9，IP `192.3.84.21`（静态） |
| 域名 | `mypier.duckdns.org`（DuckDNS 免费子域，A 记录已指向服务器） |
| 生产地址 | **https://mypier.duckdns.org** |
| 应用版本 | Shopify `mypi-2`（已 release） |
| 代码位置 | 服务器 `/opt/mypi/`（docker compose 编排） |
| 环境变量 | 服务器 `/opt/mypi/.env`（600 权限，含密钥，勿外传） |
| SSH 用户 | `root`，密钥认证（密码已不用于登录，建议尽快在面板改掉旧密码） |

> **为什么 SSH 走 443 端口**：中国防火墙（GFW）拦截境内直连境外 SSH 协议（22/2222 等端口实测均被掐断），仅 443 放行。因此服务器用 sslh 在 443 上同时提供 SSH 与网站——一个端口两种用途。境外访问网站不受任何影响。

---

## 2. 本地 SSH 登录服务器

已配置好 `~/.ssh/config` 别名，本机终端只需一条命令：

```bash
ssh mypi-server
```

等价于完整形式：

```bash
ssh -i ~/.ssh/mypi_deploy_key -p 443 root@192.3.84.21
```

要点：

- 密钥文件：`~/.ssh/mypi_deploy_key`（已持久化，重启不丢；公钥在服务器 `/root/.ssh/authorized_keys`）
- **必须带 `-p 443`**（别名已内置）；直连 22 端口从境内会被 GFW 掐断
- 登录成功标志：出现 `[root@racknerd-15b4d6c ~]#` 提示符
- 若提示 `Connection closed by ... port 443`：先按第 5 节应急流程处理（sslh 挂了）

### 服务器快速上手命令

```bash
cd /opt/mypi
docker compose ps                 # 看三容器状态（应全为 healthy）
docker compose logs -f web        # 实时看应用日志（Ctrl+C 退出）
docker compose logs -f worker     # 看定时任务日志
curl -s localhost/health          # 服务器本机自检
```

---

## 3. 访问项目首页

| 入口 | 地址 | 说明 |
|---|---|---|
| **应用首页** | https://mypier.duckdns.org | 浏览器直接打开；未登录店铺会跳到 Shopify 登录/授权流程 |
| **健康检查** | https://mypier.duckdns.org/health | 期望 `{"status":"ok","database":"up",...}` |
| **Shopify 后台入口（推荐）** | admin.shopify.com → 登录 stepchic 店铺 → Apps → **mypi** | 嵌入式应用的正常使用路径 |

- 境内、境外浏览器均可直连，无需任何代理/VPN 配合（443 上的 HTTPS 不被拦）。
- 本机 Shadowrocket 开或关都不影响访问——应用与其数据面都在境外服务器上。

---

## 4. 更新发布流程（代码变更后）

```bash
# 1. 本机：rsync 代码上服务器（排除依赖/历史/本地凭据）
#    注意 -e 只写传输程序（ssh），主机别名放在目标路径前缀；
#    切勿写成 -e "ssh mypi-server"（会把 mypi-server 当命令执行而报错）。
#    重要：--delete 会删除「服务器上存在、本地缺失」的文件。历史上
#    compose.yaml / Caddyfile 只存于服务器，曾因此被误删导致无法重建。
#    现两者已纳入本仓库版本管理（无密钥），会随 rsync 一并下发，不再被删。
cd /Users/chenjianyu/CodeGeeXProjects/myPi
rsync -az --delete -e ssh \
  --exclude node_modules --exclude .git --exclude .env \
  --exclude build --exclude build-worker --exclude ui-forensics \
  --exclude '.react-router' --exclude prisma/dev.sqlite \
  ./ mypi-server:/opt/mypi/

# 2. 服务器：重建镜像并滚动更新（约 3-5 分钟）
ssh mypi-server 'cd /opt/mypi && docker compose up -d --build'

# 3. 验证
curl -s -m 20 https://mypier.duckdns.org/health
```

若改动了 `shopify.app.toml`（URL、权限、webhook），还需本机发布新版本：

```bash
npx shopify app deploy --allow-updates
```

> 注意：`automatically_update_urls_on_dev` 已设为 `false`，本地 `npm run dev` 不会再冲掉生产 URL。

---

## 5. 应急自救（按故障层级）

### 5.1 SSH 连不上（`Connection closed by port 443`）

多半是 sslh 挂了。去 **RackNerd 面板的 VNC/控制台**（网页终端，永远可达），粘贴：

```bash
systemctl restart sslh; systemctl is-active sslh
```

若仍 failed，手动拉起临时通道（之后再用 systemctl 修服务）：

```bash
sslh -f -p 0.0.0.0:443 --ssh=127.0.0.1:22 --tls=127.0.0.1:4430 --http=127.0.0.1:4430 &
```

看到 `LISTEN 0.0.0.0:443` 后本机即可重新 `ssh mypi-server`。

### 5.2 网站打不开，但 SSH 正常

VNC 或 SSH 里检查：

```bash
cd /opt/mypi && docker compose ps
docker compose restart caddy web   # 或 docker compose up -d --build 全量重建
```

### 5.3 域名失效（服务器换 IP 时才会遇到）

浏览器访问（替换 token 为 DuckDNS 账户里的 Token）：

```
https://www.duckdns.org/update?domains=mypier&token=你的Token&ip=192.3.84.21
```

### 5.4 终极兜底

RackNerd 面板 VNC 控制台不依赖任何网络路径，进系统后一切可修。

---

## 6. 已知注意事项

- **密码卫生**：root 密码曾在对话中出现过，请尽快在 RackNerd 面板修改（SSH 走密钥，改密码不影响使用）。
- **DuckDNS 限制**：免费方案，适合 beta 验证期；正式上架 App Store 前建议换自有域名（改 Caddyfile + DuckDNS 无关，5 分钟工作量）。
- **证书续期**：Caddy 全自动（Let's Encrypt，60 天周期，30 天自动续），无需人工。
- **worker 健康检查**：用 `pgrep worker.mjs` 进程判活，不监听端口（镜像默认 3000 探针仅对 web 有效）。
- **公网扫描噪音**：Caddy 日志里会有大量 `/.ssh/id_rsa`、`/_vti_pvt` 之类的 404/502 请求，是全球扫描器，非故障。

---

## 7. 指标字典（P4-20 执行维度埋点）

自动化引擎的运行态势以 `AnalyticsEvent` 行落库（`shop` = 店铺域名、`props` 无 PII/密钥），与 V1 商家动作埋点同源但维度分开。事件清单唯一事实源在 `app/lib/analytics.ts` 的 `ANALYTICS_EVENT_TYPES`；采集点在 `automation-engine/consume.server.ts`（引擎收尾）、`automation-ingest.server.ts`（投递去重）、`reconcile.server.ts`（对账补投）。埋点是 fire-and-forget 旁路，采集失败绝不影响执行闭环。

| 事件 | 触发维度 / props | 用途（对应告警与探针） |
| --- | --- | --- |
| `execution_succeeded` | 一次执行终态 SUCCESS | 成功率分子；执行健康度基线 |
| `execution_failed` | 终态 FAILED（全步失败） | 失败率告警主指标（P4-21） |
| `execution_partial` | 终态 PARTIAL_SUCCESS（部分步成功） | 定位「部分动作未落地」的自动化 |
| `execution_skipped` | `props.reason ∈ {conditions, dedupe, all-skipped}` | 条件未命中 / 去重跳过，区分「本就不该跑」与异常 |
| `execution_awaiting_confirmation` | `props.executionStatus`（高风险步挂起待确认） | 确认堆积水位告警；驱动 `/health` 的 `awaitingConfirmation` |
| `execution_loop_blocked` | 防循环裁决 block（级联超限 / 指纹重复） | 回环排查（场景 E）；异常升高说明自动化互相触发 |
| `execution_retried` | 终态 RETRYING（步骤进入重试退避） | 重试频率告警；配合 `EXECUTION_MAX_ATTEMPTS` |
| `webhook_dedup_hit` | `props.topic`（同 X-Shopify-Webhook-Id 重复投递） | 投递重复率；Shopify 重投风暴的早期信号 |
| `reconcile_requeued` | `props.{requeued, scanned}`（对账补投条数） | 漏投缺口指标；`RECONCILE_ENABLED` 开启后的核心可观测面 |

### 7.1 `/health` 自动化维度（P4-17）

`GET /health` 的 `automation` 字段是聚合快照，全部来自上述表的原生计数/groupBy（**不依赖埋点，也不影响 503 摘流量判据——仅 `database: down` 才 503**）：

- `queueDepth`：`DataSyncJob`（`jobType=automation-execute`, `status=queued`）积压条数。
- `executionSuccess`：近窗（默认 24h，`HEALTH_AUTOMATION_WINDOW_MS` 可调）终态执行的成功率明细，分母 = SUCCESS+FAILED+PARTIAL（SKIPPED/在途不计）。
- `awaitingConfirmation`：`ExecutionStep.status=AWAITING_CONFIRMATION` 堆积数。
- `heartbeat`：各店 `ScheduledJob.lastRunAt` 最大值折算的 worker 心跳时效（`fresh`/`stale`/`unknown`，水位 `HEALTH_WORKER_HEARTBEAT_STALE_MS` 默认 15min）。

每条子查询带超时护栏（`HEALTH_AUTOMATION_QUERY_TIMEOUT_MS` 默认 2s）；任一查询超时或抛错只把对应字段降级为 `null`/`unknown`，绝不把探针拖成 503。据此可写编排侧告警：`queueDepth` 水位、`heartbeat.status=stale`、`awaitingConfirmation` 超阈、成功率下滑。

### 7.2 常用取数 SQL（排障起点，详见 §8）

```sql
-- 近 24h 各执行维度事件计数（按店铺）
SELECT shop, type, count(*)
  FROM "AnalyticsEvent"
 WHERE (type LIKE 'execution_%' OR type IN ('webhook_dedup_hit','reconcile_requeued'))
   AND "createdAt" >= now() - interval '24 hours'
 GROUP BY shop, type ORDER BY shop, type;
```

```sql
-- 队列积压与在途（不靠埋点，直接看队列真相）
SELECT status, count(*)
  FROM "DataSyncJob"
 WHERE "jobType" = 'automation-execute'
 GROUP BY status;
```

---

## 8. 告警阈值与投递（P4-21）

下表是 Phase 4 收口时确立的基线；开启方式见后面「接渠道」。阀值都可调，写进 env 时保留旧值注释。

| 信号 | 取数 | 默认阈值 | 级别 | 处置 |
| --- | --- | --- | --- | --- |
| 执行失败率（店铺维度） | `executionSuccess.failed / (success+failed+partial)` | 15min 滑窗 ≥ 20% 且样本 ≥ 10 | P2 | 先看 §9 定位失败集中 action；确认不回复后手动 `pause` 该自动化 |
| `AWAITING_CONFIRMATION` 堆积 | `ExecutionStep.status='AWAITING_CONFIRMATION'` | > 24h 未裁决 → 1 条 | P2 | 商家未确认：邮件提醒；商家已确认但没自动重跑：查 automation-retry |
| 队列积压 `queueDepth` | `DataSyncJob(jobType=automation-execute, status=queued)` | ≥ 200 持续 10min | P1 | worker 卡死：看 worker 日志；正常处理量提升：水平加 worker |
| worker 心跳缺失 | `/health` 中 `automation.heartbeat.status` | `stale` 持续 ≥ 5min | P1 | pm2/systemd 重启 worker；确认 `WORKER_AUTOMATION_CRON` 未被误关 |
| 对账缺口 | `reconcile_requeued` 计数 | 单店 30min 内 > 50 条 | P2 | Admin API 拉回实体 vs `WebhookDelivery` 差集变大：先看 Shopify 侧投递日志与 HMAC 失败 |
| HMAC 鉴权失败 | 日志 `[webhook] hmac mismatch` | ≥ 5 次/分钟 | P1 | 确认 `SHOPIFY_WEBHOOK_SECRET` 未轮换；排除后看 IP 白名单 |
| SSRF 拦截 | `ssrf_blocked` 日志 | 仅记录，不告警 | — | 商家自配 webhook 目标内网，属预期拦截 |
| `EXECUTION_LEASE_MINUTES` 内认领未推进 | `DataSyncJob(status='running' AND "startedAt" < now() - lease)` | ≥ 20 行 | P1 | worker 中途 crash：重启后 `activeKey` 会释放、下一轮 cron 重抢；多副本时确认仅一实例认领 |
| Integration 健康度下降 | `Integration.status='failing'` | 5min 内新转 failing ≥ 3 | P2 | 商家侧服务商不可达：邮件通知商家；确认非本侧网络后不自动重试 |

### 8.1 接渠道（现网可用）

- **Cloudflare 告警**（首选，零新基础设施）：在 Worker 上挂 Cron，每 5min 打 `/health`，把 `automation` 字段写进 Cloudflare Analytics Engine；在 Cloudflare Dashboard 建 Alert 订阅阈值。
- **邮件**：`INTEGRATIONS.email` 已支持 SMTP（目前仅测试可发）；接一个 `alerts@` 收件人即可，凭据同其它 EMAIL Integration，密文入库。
- **PagerDuty / Slack**：自定义 webhook 可用 `webhook.send` 动作反向投递（需为告警机专用 Integration，不开放给商家自动化）。

未接渠道前， `/health` 的 `automation` 字段 + 上方 SQL 手动巡检；Phase 4 不上告警平台不阻断发布，但 **Staging 前必须至少接上 Cloudflare 阈值**（写进 §6 发布卡）。

### 8.2 值班流程

1. P1 告警 5min 内 ack，P2 当日 ack；先确认可复现（`/health` + 上方 SQL）。
2. 能回滚先回滚（`docs/release-runbook.md` §4）；不能回滚先隔离（`AUTOMATION_EXECUTION_ENABLED=false` 只关引擎，同步链路不受影响）。
3. 开 Issue 写到本目录 `docs/incidents/YYYY-MM-DD-<slug>.md`：时间线 + 根因 + 处置 + 预防项（下一节 §9.4 有模板）。

---

## 9. 排障手册（P4-22）

### 9.1 executionId 全链路追踪（ingest → queue → execution → steps）

```sql
-- 一次执行的完整上下文（包含自动化快照与步骤清单）
SELECT l.id                AS execution_id,
       l."automationId",
       l."automationVersion",
       l.status            AS execution_status,
       l."triggerType",
       l."entityRef",
       l."dedupeKey",
       l."cascadeDepth",
       l."createdAt",
       l."updatedAt",
       s.id                AS step_id,
       s."order"           AS step_order,
       s."actionId",
       s.status            AS step_status,
       s.result            AS step_result,
       s."errorText"       AS step_error
  FROM "ExecutionLog" l
  LEFT JOIN "ExecutionStep" s ON s."executionId" = l.id
 WHERE l.id = $1
 ORDER BY s."order";
```

```sql
-- 反向：从 webhookId 定位它引发的投递与可能的执行（同 store + topic 时间窗）
SELECT d."webhookId", d.topic, d.shop, d."receivedAt",
       l.id AS execution_id, l.status AS execution_status, l."createdAt" AS execution_at
  FROM "WebhookDelivery" d
  LEFT JOIN "ExecutionLog" l
    ON l."shopId" = d."shopId"
   AND l."entityRef" IS NOT NULL
   AND l."createdAt" BETWEEN d."receivedAt" - interval '5 seconds'
                          AND d."receivedAt" + interval '5 minutes'
 WHERE d."webhookId" = $1;
```

入口参考：

- `WebhookDelivery` 同 `webhookId` 已存在：属预期去重（`@@unique([webhookId])`）；
- HMAC 失败 → 路由层直接 4xx 不入库（见 `app/routes/webhooks.*.tsx` 入口）；
- 入库但 `ExecutionLog` 无对应行：`automation-matcher` 未命中启用的自动化（确认 `Automation.status='active'` 与 `ExecutionLog.triggerType` 一致）。

### 9.2 loop_blocked 定位（级联/限流）

```sql
-- 近 24h 因超深度而 SKIPPED 的执行
SELECT l.id, l."automationId", l."createdAt", l."cascadeDepth", l.status
  FROM "ExecutionLog" l
 WHERE l.status = 'SKIPPED'
   AND l."cascadeDepth" >= 1
   AND l."createdAt" >= now() - interval '24 hours'
 ORDER BY l."createdAt" DESC
 LIMIT 50;
```

定位思路：先看 `LOOP_MAX_CASCADE_DEPTH` 与 `LOOP_THROTTLE_COUNT` 当前值；若一条商家自定义自动化在改标签 → 触发 inventory webhook → 又改标签，属预期拦截。真要放行时优先拆自动化，而不是改大上限。

### 9.3 对账缺口排查（reconcile）

```sql
-- 当前店当前窗口内，已投递 vs 应投递差集（人读口径，实际实现见 app/lib/reconcile-policy.ts）
-- Admin API 拉回的实体列表先落临时表 entities("entityId", "observedAtAt")，然后：
SELECT e."entityId", e."observedAt"
  FROM tmp_reconcile_entities e
 WHERE NOT EXISTS (
   SELECT 1 FROM "WebhookDelivery" d
    WHERE d.shop = $1
      AND d."receivedAt" >= e."observedAt"
      AND d.topic = $2
 )
   AND NOT EXISTS (
   SELECT 1 FROM "ExecutionLog" l
    WHERE l."shopId" = $3
      AND l."entityRef" = e."entityId"
      AND l."createdAt" >= e."observedAt"
 );
-- 不直接拿这段 SQL 补投：reconcile-worker 会走 HMAC 同一条 ingest 链路，保证同 `WebhookDelivery` 幂等约束。
```

`RECONCILE_ENABLED=true` 后 worker 会每 30min 补一次；补投同走 HMAC 同走 `WebhookDelivery` 幂等约束，不会产生重复执行。

### 9.4 Incident 模板

```markdown
---
date: YYYY-MM-DD
severity: P1 | P2
slug: short-handle
status: open | resolved
---

## 时间线
- HH:MM  告警抵达 / 商家上报
- HH:MM  定位完成（附 executionId / webhookId / 日志片段）
- HH:MM  处置（回滚 / 隔离 / 重启）
- HH:MM  验证（行数对账 / 健康度恢复）

## 根因

## 处置

## 预防项
- [ ] 代码修改
- [ ] 阈值调整（写 env + runbook §8）
- [ ] 新告警规则
```

### 9.5 常见“看起来是 bug”的误判

- **页面没自动刷新**：`/health` 与埋点不驱动 UI 重拉，商家需手动刷新；属预期。
- **`queueDepth` 非 0 但无新行**：worker 卡死时 `DataSyncJob(status=running)` 会占住 lease；`EXECUTION_LEASE_MINUTES` 到点自动重抢，不需人工。
- **`heartbeat: unknown`**：`ScheduledJob` 为空时属预期（商家未启用定时型自动化），不视为告警。
- **`successRate: null`**：无终态样本时诚实回 null，不伪造 100%；只有少量执行时属正常。


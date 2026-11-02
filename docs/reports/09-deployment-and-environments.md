# 交付报告 09 —— 部署与运行环境

- 日期：2026-11-02 ｜ 依据：`Dockerfile`、`package.json` scripts、`worker/index.ts`、`app/routes/health.tsx`、`docs/release-runbook.md`

## 镜像与进程

- 双阶段 Dockerfile：build 阶段全量 `npm ci`（`react-router build` 需要 devDependencies；worker 打包依赖 esbuild——修复了审计缺陷 #5「运行阶段 `--omit=dev` 打不出 worker」）；runtime 只带 `build/`、`build-worker/`、`prisma/` 与生产依赖。
- 密钥纪律：`.dockerignore` 挡 `.env` 与 sqlite——镜像层是缓存的，某层出现过明文就抹不掉，所以从入口挡住。
- 双进程同镜像：web（`docker-start` = setup + serve）与 worker（`docker-worker` = 仅 generate + 常驻，不跑迁移）；worker 崩溃不带走对外服务。
- `HEALTHCHECK` 30s / 10s 超时 / 40s 起步 / 3 次重试，busybox wget 打 `/health`。

## 探针与编排

`/health`：DB ping 带超时上限（`HEALTH_CHECK_TIMEOUT_MS`，防止把「慢」误报成探针失败）、版本（`APP_VERSION` CI 注入）、uptime；DB down → 503 摘流量；响应 `no-store` 防读到上一轮状态。

## worker 可靠性

cron（快照每小时、销售重建每日 03:00，均可 env 覆盖）、`noOverlap`、env 预检、启动补跑；崩溃遗留的 `running` 任务由租约（默认 30 分钟）自动回收。

## 三环境与流程

Development / Staging / Production 定义、发布五步门禁、向后兼容迁移规则、回滚流程（含回滚前三表导出存档）见 `docs/release-runbook.md`。本地网络对 pooler DNS 劫持的绕行办法也已写入 runbook（仅影响开发机，CI/服务器无需）。

## 现状与诚实缺口

- 已完成：镜像构建验证（Stage 1）、本报告日前每阶段 `npm run build` client+server 全绿。
- 未开通：Staging 独立 store/库（首次外部 Beta 前按 runbook 开通）；生产部署目标平台未定，runbook 以通用容器编排描述，未绑定具体厂商。

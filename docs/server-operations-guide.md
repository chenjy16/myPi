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

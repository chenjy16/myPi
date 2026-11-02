# my-pi 框架与工具配置地图

> 文档基线：2026-11-01。本文按框架/工具分层梳理仓库中「需要定义哪些配置文件与约定命名的代码文件」，用于快速理解各框架的职责边界与接入点。内容描述当前实现，具体值以仓库文件为准。

## 0. 项目定位

my-pi 是一个 **Shopify 嵌入式应用（Embedded App）**，技术栈为 **React Router 7（SSR）+ Shopify 官方库 + Prisma + Pi AI SDK**，由 **Shopify CLI** 驱动开发与部署。下面按 13 个框架/工具逐层展开。

---

## 1. Shopify App / CLI（平台层）

Shopify 平台对「应用」有一套强制的配置约定，由 CLI 读取。

| 文件 | 作用 |
|------|------|
| `shopify.app.toml` | **应用主配置**。定义 `client_id`、`application_url`、`embedded`、权限范围 `[access_scopes]`、Webhook 订阅 `[webhooks]`（含 API 版本 `2026-10` 与每个 topic→uri 映射）、OAuth `[auth.redirect_urls]`、构建行为 `[build]` |
| `shopify.web.toml` | **Web 服务配置**。声明框架名、`roles = ["frontend","backend"]`、`webhooks_path`，以及 `predev` / `dev` 启动命令（先跑 Prisma 再起 React Router） |
| `.shopify/project.json` | CLI 生成的项目元数据（当前关联的 app） |
| `extensions/.gitkeep` | 扩展目录（当前为空，预留 UI Extension 等工作区） |

**关键点：** `shopify.app.toml` 里的 webhook `api_version` 必须与代码中 `app/shopify.server.ts` 的 `ApiVersion.October26` 保持一致。

---

## 2. Shopify 官方服务端库 `@shopify/shopify-app-react-router`

把 Shopify OAuth / 鉴权 / Webhook 校验接入 React Router 的桥梁。

| 文件 | 作用 |
|------|------|
| `app/shopify.server.ts` | **核心实例定义**。调用 `shopifyApp({...})` 配置 apiKey、apiSecret、apiVersion、scopes、`useOnlineTokens`、`authPathPrefix`、session 存储、distribution；并导出 `authenticate` / `login` / `registerWebhooks` / `addDocumentResponseHeaders` 等 |
| `app/entry.server.tsx` | SSR 入口，调用 `addDocumentResponseHeaders` 给 HTML 加嵌入式安全头 |
| `app/routes/app.tsx` | 用 `AppProvider`（见第 3 层）与 `boundary.error` / `boundary.headers` 处理 Shopify 抛出的鉴权 Response |
| `app/routes/webhooks.*.tsx` | **Webhook 处理器**，文件名与 `shopify.app.toml` 中的 `uri` 一一对应（如 `/webhooks/app/uninstalled` ↔ `webhooks.app.uninstalled.tsx`） |

---

## 3. App Bridge `@shopify/app-bridge-react`

让应用嵌入 Shopify Admin 后台。

| 文件 | 作用 |
|------|------|
| `app/routes/app.tsx` | 用 `<AppProvider apiKey={apiKey}>` 包裹整个嵌入布局 |
| `vite.config.ts` | `optimizeDeps.include: ["@shopify/app-bridge-react"]` 预打包 |

---

## 4. React Router 7（路由 + SSR 框架）

取代旧的 Remix，有自己的路由/入口约定。

| 文件 | 作用 |
|------|------|
| `app/routes.ts` | 路由表定义，这里用 `@react-router/fs-routes` 的 `flatRoutes()` 按文件名自动生成 |
| `app/root.tsx` | 全站 HTML 外壳（`<html>` / `<head>` / `<Outlet>`） |
| `app/entry.server.tsx` | 服务端渲染入口（`handleRequest` + `renderToPipeableStream`） |
| `app/routes/*.tsx` | 各页面路由，用 **点号扁平命名**（如 `app.inventory.tsx` → `/app/inventory`） |
| `.react-router/types/` | `react-router typegen` 生成的路由类型（由 `typecheck` 脚本产出） |

> 约定：每个 route 文件里的 `loader` / `action` / `default` / `headers` / `ErrorBoundary` 都是 React Router 的**约定导出**。

---

## 5. Vite（构建 / 开发服务器）

| 文件 | 作用 |
|------|------|
| `vite.config.ts` | 注册 `reactRouter()` 与 `tsconfigPaths()` 插件；配置 dev server 端口、HMR（区分 localhost 与 tunnel）、`fs.allow`、`optimizeDeps` |
| `env.d.ts` | 引入 `vite/client` 与 `@react-router/node` 类型 |

---

## 6. Prisma（ORM + 数据库）

| 文件 | 作用 |
|------|------|
| `prisma/schema.prisma` | **数据模型定义**。datasource（postgresql，URL 取 `env("DATABASE_URL")`）、generator（client-js），以及 `Session`（供 Shopify session 存储）、`ProductDraft`、`InventorySettings`、`Location`、`InventorySnapshot`（地点×变体×日）、`InventoryEvent`、`DataSyncJob`、`SalesDaily`、`ReorderRecommendation` 等 model |
| `prisma/migrations/*/migration.sql` | 每个变更的迁移 SQL（命名带时间戳；切库后以 `init_postgres_baseline` 为基线） |
| `app/db.server.ts` | **单例 PrismaClient**，开发态挂 `global` 避免热更新重复连库；顶部 `import "dotenv/config"` 让 SSR 进程也能读到 `.env` 的 `DATABASE_URL` |
| `worker/index.ts` | **后台 worker 入口**（node-cron 定时快照与销量重建），`npm run worker` 用 esbuild 打包到 `build-worker/` 后跑 |

> 约定：仅服务端可用的文件用 `.server.ts` 后缀（如 `db.server.ts`、`inventory.server.ts`、`pi.server.ts`）。

---

## 7. GraphQL Codegen `@shopify/api-codegen-preset`

为 Shopify Admin GraphQL 查询生成 TypeScript 类型。

| 文件 | 作用 |
|------|------|
| `.graphqlrc.ts` | graphql-config 定义，用 `shopifyApiProject` 扫描 `app/**` 中的 GraphQL document，输出类型到 `app/types/`；并自动挂载 `extensions/*/schema.graphql` |
| `app/types/` | 生成的类型产物 |

---

## 8. Pi Coding Agent SDK `@earendil-works/pi-coding-agent`（AI 能力）

项目独有的 AI 商品文案生成。

| 文件 | 作用 |
|------|------|
| `app/pi.server.ts` | 创建隔离的 `ModelRuntime` / `AgentSession`（无工具、内存设置、临时目录），发 prompt 生成文案 |
| `app/product-copy.server.ts` | 模型配置读取、超时封装、错误分类、Zod 解析 |
| `.env.example` | 定义 `PI_API_KEY` / `PI_PROVIDER` / `PI_MODEL` 环境变量约定 |

---

## 9. Zod（运行时校验）

| 文件 | 作用 |
|------|------|
| `app/product-copy.server.ts` | `productCopySchema` 校验 AI 返回的 `title` / `description` |

---

## 10. TypeScript（类型系统）

| 文件 | 作用 |
|------|------|
| `tsconfig.json` | 编译选项（strict、ESNext、bundler 解析、jsx react-jsx），`include` 含 `.react-router/types`，`types` 引入 polaris-types 等 |
| `env.d.ts` / `app/globals.d.ts` | 全局 / 环境类型声明 |

---

## 11. ESLint 与编辑器规范

| 文件 | 作用 |
|------|------|
| `.eslintrc.cjs` | 基础 + React + TypeScript + Node 分层 override；忽略 `.server` / `.client` |
| `.editorconfig` | 编辑器约定（缩进 / 编码 / 换行 / 去尾空格） |

> 注：原 `.eslintignore`（被 lint 脚本 `--ignore-path .gitignore` 覆盖而失效）与 `.prettierignore`（工具链内无 prettier 配置/脚本/CI 步骤）已随清理删除。

---

## 12. 测试（Node 原生 test runner）

| 文件 | 作用 |
|------|------|
| `tests/*.test.ts` | 用 `node --experimental-transform-types --test` 跑纯逻辑单测（库存计算、文案、补货建议） |
| 纯逻辑模块（如 `inventory-calculations.ts`、`reorder-recommendations.ts`） | 与 `.server` 分离，便于无副作用测试 |

---

## 13. 部署 / 其他工具

| 文件 | 作用 |
|------|------|
| `Dockerfile` | node:22-alpine 容器构建，`npm run build` + `docker-start`（先 setup Prisma 再 serve） |
| `.mcp.json` / `.cursor/mcp.json` / `.gemini/extensions/...` | 各家 AI IDE 的 Shopify dev MCP 服务器配置 |
| `.npmrc` | npm 行为（如 workspaces / 锁文件相关） |
| `package.json` | 依赖、`workspaces`（`extensions/*`）、`overrides` / `resolutions`、所有 npm scripts（build/dev/deploy/lint/typecheck/prisma 等） |

---

## 命名约定速查表

本项目大量依赖**文件名约定**来驱动框架行为，这是理解它的关键：

| 约定 | 含义 |
|------|------|
| `app/routes/app.inventory.tsx` | flatRoutes 点号 → 路由 `/app/inventory` |
| `*.server.ts` / `*.server.tsx` | 仅服务端加载（受 React Router / Vite 保护） |
| `webhooks.<topic-path>.tsx` | 对应 `shopify.app.toml` 里的 webhook `uri` |
| `prisma/migrations/<时间戳>_<名称>/` | Prisma 迁移顺序 |
| `.react-router/types/` | typegen 产物，勿手改 |
| `app/types/` | GraphQL codegen 产物 |

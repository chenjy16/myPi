# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 构建阶段：需要 devDependencies（react-router build 依赖 @react-router/dev + vite，
# worker 打包依赖 esbuild），所以这里装全量依赖。
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN apk add --no-cache openssl
WORKDIR /app

# 构建期也要按生产模式跑，产物里才不会留 dev-only 分支。
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Prisma Client 必须先生成，否则 build 阶段拿到的是未生成时抛错的桩代码。
RUN npx prisma generate && npm run build && npm run worker:build

# ---------------------------------------------------------------------------
# 运行阶段：只带生产依赖 + 构建产物。
# 历史教训：镜像层是缓存的 —— 只要某一层的文件系统里出现过 .env，
# 后续层删掉文件也抹不掉那份明文，所以 .dockerignore 必须挡住 .env 和 sqlite。
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/prisma ./prisma
COPY --from=build /app/build ./build
COPY --from=build /app/build-worker ./build-worker

EXPOSE 3000

# 探针不打 Shopify 鉴权，纯读：数据库连不上就 503，编排系统据此摘流量。
# 用 alpine 自带的 busybox wget（-q 静默、-O /dev/null 丢正文），比装 curl 少一层依赖。
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

# Web 进程。后台 worker 是独立进程，用同一个镜像跑另一条命令：
#   docker run <image> npm run docker-worker
# worker 只 prisma generate、不 migrate deploy —— 结构变更归发布流程，不归常驻进程。
# 两者共用一个镜像但可各自重启与扩缩，worker 崩溃不会带走对外服务。
CMD ["npm", "run", "docker-start"]

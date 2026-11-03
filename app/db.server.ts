import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildDatasourceUrl } from "./lib/db-pool-url";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * 单个进程共用一个 PrismaClient（P0-3 生命周期要求）：
 * - 开发态挂到 global，热更新不重复建池；
 * - 生产态每个进程（Web 一个、Worker 一个）各建一次，之后所有请求复用同一份连接池，
 *   绝不在请求结束时 $disconnect 共享池——那会让下一个请求重新冷连接。
 * 连接池参数由 db-pool-url 补进连接串；DATABASE_URL 缺失时回落到默认构造，让 Prisma 自己读 env。
 */
function createPrismaClient(): PrismaClient {
  const datasourceUrl = buildDatasourceUrl();
  return new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    // 只把告警/错误送进日志通道；查询级噪声不进生产日志。
    log: ["warn", "error"],
  });
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

/** 全应用共用的 Prisma 客户端；开发态挂到 global，避免热更新重复连库。 */
const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;

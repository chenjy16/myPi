import "dotenv/config";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

/** 全应用共用的 Prisma 客户端；开发态挂到 global，避免热更新重复连库。 */
const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
